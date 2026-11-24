import { DurableObject } from 'cloudflare:workers';
import type { BoardSizeKey, PublicRoom } from '../src/net/protocol';
import type { GameModeKey } from '../src/game/modes';
import { DEFAULT_RATING, ratingBand } from '../src/net/matchmaking';

/**
 * One instance for the whole game, holding the quick-match queue and the list
 * of rooms that have opted to be public.
 *
 * A single object is a deliberate simplification: it is the only way to make
 * "pair the two people waiting right now" actually work without a distributed
 * queue, and at this scale one object is nowhere near its limits. Sharding by
 * region or mode is the escape hatch if that ever stops being true.
 *
 * It never holds game state. Everything here is a pointer to a GameRoom, so
 * losing the whole object costs at most one round of matchmaking.
 */

/** A queued room is only worth offering to someone else for as long as its
 *  owner is plausibly still sitting in it. */
const QUEUE_TTL_MS = 180_000;
/** 'auto' in the queue means any board size will do. */
type QueueSize = BoardSizeKey | 'auto';
/** Public listings are refreshed by the room itself on every roster change, so
 *  anything this stale means the room died without telling us. */
const LISTING_TTL_MS = 120_000;


interface QueueEntry {
  code: string;
  mode: GameModeKey;
  boardSize: QueueSize;
  /** How many the match is for (2 = 1v1), and how many are in so far. */
  players: number;
  filled: number;
  at: number;
  /** Last sign of life from the room, for the TTL. */
  seen?: number;
  /** Verified by the worker before it gets here — never a number a client
   *  sent. Absent on entries queued by an older client. */
  rating?: number;
}

interface Listing extends PublicRoom {
  at: number;
}

export interface MatchmakerEnv {
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
}

export class Matchmaker extends DurableObject<MatchmakerEnv> {
  private queue: QueueEntry[] = [];
  private listings = new Map<string, Listing>();
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: MatchmakerEnv) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.queue = (await ctx.storage.get<QueueEntry[]>('queue')) ?? [];
      const stored = await ctx.storage.get<[string, Listing][]>('listings');
      this.listings = new Map(stored ?? []);
    });
  }

  private prune() {
    const now = Date.now();
    this.queue = this.queue.filter((q) => now - (q.seen ?? q.at) < QUEUE_TTL_MS);
    for (const [code, listing] of this.listings) {
      if (now - listing.at >= LISTING_TTL_MS) this.listings.delete(code);
    }
  }

  private async persist() {
    await this.ctx.storage.put('queue', this.queue);
    await this.ctx.storage.put('listings', Array.from(this.listings.entries()));
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    this.prune();
    const url = new URL(request.url);

    if (url.pathname.endsWith('/queue')) {
      const body = (await request.json()) as {
        code: string;
        mode: GameModeKey;
        boardSize: QueueSize;
        players?: number;
        // Already verified against the hub by the worker; this object never
        // sees a rating a client chose.
        rating?: number;
      };
      return Response.json(
        await this.takeOrQueue({
          ...body,
          players: Number(body.players) || 2,
          rating: Number(body.rating) || DEFAULT_RATING,
        })
      );
    }
    if (url.pathname.endsWith('/dequeue')) {
      const { code } = (await request.json()) as { code: string };
      this.queue = this.queue.filter((q) => q.code !== code);
      await this.persist();
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith('/refill')) {
      // A ranked room reporting how many players it has while it fills.
      const b = (await request.json()) as { code: string; mode: GameModeKey; boardSize: BoardSizeKey; players: number; filled: number };
      const entry = this.queue.find((q) => q.code === b.code);
      if (b.filled <= 0 || b.filled >= b.players) {
        this.queue = this.queue.filter((q) => q.code !== b.code);
      } else if (entry) {
        entry.filled = b.filled;
        entry.seen = Date.now();
      } else {
        // Someone dropped out of a room the queue had already closed: open it
        // again so the empty place can be filled.
        this.queue.push({ code: b.code, mode: b.mode, boardSize: b.boardSize, players: b.players, filled: b.filled, at: Date.now() });
      }
      await this.persist();
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith('/publish')) {
      const room = (await request.json()) as PublicRoom;
      this.listings.set(room.code, { ...room, at: Date.now() });
      await this.persist();
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith('/unpublish')) {
      const { code } = (await request.json()) as { code: string };
      this.listings.delete(code);
      this.queue = this.queue.filter((q) => q.code !== code);
      await this.persist();
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith('/presence')) {
      // Genuinely counted, not estimated: people sitting in the queue plus
      // people sitting in listed rooms. It is allowed to be a small number.
      const inRooms = Array.from(this.listings.values()).reduce((n, r) => n + r.players, 0);
      // Players searching, per match size — what the ranked screen shows next
      // to each option.
      const searching: Record<string, number> = { 2: 0, 3: 0, 4: 0 };
      for (const q of this.queue) searching[q.players ?? 2] = (searching[q.players ?? 2] ?? 0) + (q.filled ?? 1);
      await this.persist();
      return Response.json({ queued: this.queue.length, inRooms, searching });
    }
    if (url.pathname.endsWith('/rooms')) {
      const rooms = Array.from(this.listings.values())
        .sort((a, b) => b.at - a.at)
        .slice(0, 40)
        .map(({ at: _at, ...room }) => room);
      await this.persist();
      return Response.json({ rooms });
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * The heart of quick match. Either hands back somebody else's waiting room or
   * parks the caller's own and tells them to sit tight.
   *
   * Mode and board size are hard filters, because being dropped into a match
   * with rules you did not pick is worse than waiting a few more seconds.
   * Rating is a soft one: the closest opponent inside the waiting player's
   * current band wins, and the band widens the longer they have waited.
   */
  private async takeOrQueue(req: {
    code: string;
    mode: GameModeKey;
    boardSize: QueueSize;
    players: number;
    rating: number;
  }) {
    const now = Date.now();
    const sizeFits = (a: QueueSize, b: QueueSize) => a === 'auto' || b === 'auto' || a === b;
    const best = this.queue
      .map((q, i) => ({ q, i }))
      .filter(
        ({ q }) =>
          q.mode === req.mode &&
          (q.players ?? 2) === req.players &&
          sizeFits(q.boardSize, req.boardSize) &&
          q.code !== req.code
      )
      .map(({ q, i }) => ({
        q,
        i,
        gap: Math.abs((q.rating ?? DEFAULT_RATING) - req.rating),
        // The band belongs to whoever has been waiting: the newcomer has waited
        // no time at all, so judging by their band would keep a long-waiting
        // player unmatched next to somebody they should have been given.
        band: ratingBand(now - q.at),
      }))
      .filter((c) => c.gap <= c.band)
      // Fullest room first, so groups complete instead of splitting; then the
      // closest rating; then the longest wait.
      .sort((a, b) => (b.q.filled ?? 1) - (a.q.filled ?? 1) || a.gap - b.gap || a.q.at - b.q.at)[0];

    if (best) {
      const q = best.q;
      // Somebody who picked a size settles it for an Auto room.
      if (q.boardSize === 'auto' && req.boardSize !== 'auto') q.boardSize = req.boardSize;
      q.filled = (q.filled ?? 1) + 1;
      q.seen = now;
      if (q.filled >= (q.players ?? 2)) this.queue.splice(best.i, 1);
      await this.persist();
      return { code: q.code, waiting: false, boardSize: q.boardSize, players: q.players ?? 2 };
    }

    this.queue = this.queue.filter((q) => q.code !== req.code);
    this.queue.push({
      code: req.code,
      mode: req.mode,
      boardSize: req.boardSize,
      players: req.players,
      filled: 1,
      at: now,
      rating: req.rating,
    });
    await this.persist();
    return { code: req.code, waiting: true, boardSize: req.boardSize, players: req.players };
  }
}
