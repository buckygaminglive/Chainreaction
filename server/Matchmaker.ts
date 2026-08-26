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
const QUEUE_TTL_MS = 90_000;
/** Public listings are refreshed by the room itself on every roster change, so
 *  anything this stale means the room died without telling us. */
const LISTING_TTL_MS = 120_000;


interface QueueEntry {
  code: string;
  mode: GameModeKey;
  boardSize: BoardSizeKey;
  at: number;
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
    this.queue = this.queue.filter((q) => now - q.at < QUEUE_TTL_MS);
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
        boardSize: BoardSizeKey;
        // Already verified against the hub by the worker; this object never
        // sees a rating a client chose.
        rating?: number;
      };
      return Response.json(
        await this.takeOrQueue({ ...body, rating: Number(body.rating) || DEFAULT_RATING })
      );
    }
    if (url.pathname.endsWith('/dequeue')) {
      const { code } = (await request.json()) as { code: string };
      this.queue = this.queue.filter((q) => q.code !== code);
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
      await this.persist();
      return Response.json({ queued: this.queue.length, inRooms });
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
    boardSize: BoardSizeKey;
    rating: number;
  }) {
    const now = Date.now();
    const best = this.queue
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => q.mode === req.mode && q.boardSize === req.boardSize && q.code !== req.code)
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
      // Closest rating first; a longer wait breaks ties, so nobody is
      // repeatedly passed over by later arrivals.
      .sort((a, b) => a.gap - b.gap || a.q.at - b.q.at)[0];

    if (best) {
      this.queue.splice(best.i, 1);
      await this.persist();
      return { code: best.q.code, waiting: false };
    }

    this.queue = this.queue.filter((q) => q.code !== req.code);
    this.queue.push({
      code: req.code,
      mode: req.mode,
      boardSize: req.boardSize,
      at: now,
      rating: req.rating,
    });
    await this.persist();
    return { code: req.code, waiting: true };
  }
}
