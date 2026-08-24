import { DurableObject } from 'cloudflare:workers';
import type { BoardSizeKey, PublicRoom } from '../src/net/protocol';
import type { GameModeKey } from '../src/game/modes';

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
      const body = (await request.json()) as { code: string; mode: GameModeKey; boardSize: BoardSizeKey };
      return Response.json(await this.takeOrQueue(body));
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
   * Matching is on mode and board size, because being dropped into a match with
   * rules you did not pick is worse than waiting a few more seconds.
   */
  private async takeOrQueue(req: { code: string; mode: GameModeKey; boardSize: BoardSizeKey }) {
    const idx = this.queue.findIndex(
      (q) => q.mode === req.mode && q.boardSize === req.boardSize && q.code !== req.code
    );

    if (idx !== -1) {
      const [entry] = this.queue.splice(idx, 1);
      await this.persist();
      return { code: entry.code, waiting: false };
    }

    this.queue = this.queue.filter((q) => q.code !== req.code);
    this.queue.push({ code: req.code, mode: req.mode, boardSize: req.boardSize, at: Date.now() });
    await this.persist();
    return { code: req.code, waiting: true };
  }
}
