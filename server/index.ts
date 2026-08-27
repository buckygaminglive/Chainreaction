import { GameRoom, MATCHMAKER_SINGLETON, PLAYER_HUB_SINGLETON, type Env } from './GameRoom';
import { Matchmaker } from './Matchmaker';
import { PlayerHub } from './PlayerHub';
import { RATE_LIMITS, RateLimiter } from './RateLimiter';
import type { BoardSizeKey } from '../src/net/protocol';
import { GAME_MODES, type GameModeKey } from '../src/game/modes';

export { GameRoom, Matchmaker, PlayerHub, RateLimiter };

/**
 * Checks a caller's budget for one bucket.
 *
 * Fails open. A limiter that takes the whole game down when it has a bad day
 * is a worse outage than the abuse it exists to prevent, and abuse is survivable
 * for the minutes it takes to notice — so an error here allows the request and
 * says so in the log.
 */
async function allow(env: Env, request: Request, bucket: keyof typeof RATE_LIMITS): Promise<number> {
  const rule = RATE_LIMITS[bucket];
  // Cloudflare sets this on every request through the edge. Absent only in
  // local dev, where everyone sharing one bucket is harmless.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  try {
    const stub = env.RATE_LIMITER.getByName(ip);
    const res = await stub.fetch('https://rl/check', {
      method: 'POST',
      body: JSON.stringify({ bucket, ...rule }),
    });
    const result = (await res.json()) as { allowed: boolean; retryAfter: number };
    return result.allowed ? 0 : result.retryAfter;
  } catch (err) {
    console.error(`rate limit check failed for ${bucket}, allowing:`, String(err));
    return 0;
  }
}

function tooMany(retryAfter: number): Response {
  return Response.json(
    { error: 'Too many requests. Try again shortly.', retryAfter },
    { status: 429, headers: { ...corsHeaders(), 'Retry-After': String(retryAfter) } }
  );
}

/** Routes the client calls directly. Everything that mutates an account is a
 *  POST carrying the account's own secret; the hub verifies it. */
const HUB_ROUTES = new Set([
  'register',
  'rename',
  'me',
  'addFriend',
  'removeFriend',
  'friends',
  'leaderboard',
  // A profile reads its own history and sets its own avatar. Both are
  // authenticated inside the hub; this list only decides what is reachable
  // from the public surface at all.
  'history',
  'setAvatar',
  'invite',
  'invites',
  'dismissInvite',
]);

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — avoids look-alikes
const BOARD_SIZES: BoardSizeKey[] = ['small', 'medium', 'large'];

function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/** Quick match settings arrive from a client, so they are narrowed to known
 *  values before they can reach the queue and sit there poisoning matches. */
function sanitize(body: unknown): { mode: GameModeKey; boardSize: BoardSizeKey } {
  const raw = (body ?? {}) as { mode?: string; boardSize?: string };
  const mode = (raw.mode && GAME_MODES[raw.mode as GameModeKey]?.online ? raw.mode : 'classic') as GameModeKey;
  const boardSize = (BOARD_SIZES.includes(raw.boardSize as BoardSizeKey)
    ? raw.boardSize
    : 'medium') as BoardSizeKey;
  return { mode, boardSize };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/api/create' && request.method === 'POST') {
      const wait = await allow(env, request, 'create');
      if (wait) return tooMany(wait);
      const code = generateRoomCode();
      return Response.json({ code }, { headers: corsHeaders() });
    }

    // Quick match brokers a room code and nothing else: the caller then joins
    // it over the ordinary room socket. Keeping matchmaking to "which code" is
    // what stops it needing a second connection or any game state of its own.
    if (url.pathname === '/api/quickmatch' && request.method === 'POST') {
      const wait = await allow(env, request, 'quickmatch');
      if (wait) return tooMany(wait);
      const body = (await request.json().catch(() => ({}))) as { accountId?: unknown };
      const { mode, boardSize } = sanitize(body);

      // The rating used for matchmaking is read from the hub, never taken from
      // the request. A client that could name its own rating could pick which
      // opponents it is offered, and the whole point of banding is that it is
      // not the player's choice. An unknown or absent id simply gets the
      // starting rating, which is what an unranked player should be matched as.
      const accountId = typeof body.accountId === 'string' ? body.accountId.slice(0, 64) : '';
      let rating = 1000;
      if (accountId) {
        try {
          const hub = env.PLAYER_HUB.getByName(PLAYER_HUB_SINGLETON);
          const lookup = await hub.fetch('https://hub/rating', {
            method: 'POST',
            body: JSON.stringify({ id: accountId }),
          });
          rating = Number(((await lookup.json()) as { rating?: number }).rating) || 1000;
        } catch {
          // A hub hiccup should not stop someone getting a game; an unbanded
          // match is far better than no match.
        }
      }

      const stub = env.MATCHMAKER.getByName(MATCHMAKER_SINGLETON);
      const res = await stub.fetch('https://mm/queue', {
        method: 'POST',
        body: JSON.stringify({ code: generateRoomCode(), mode, boardSize, rating }),
      });
      const result = (await res.json()) as { code?: string; waiting?: boolean };

      // Mark the room ranked here, where the code provably came from the
      // matchmaker. Doing it from the client — or inferring it from the room's
      // own public flag — would let anyone declare their own room rated.
      // Idempotent: joining an already-queued room marks it a second time.
      if (result.code) {
        const room = env.GAME_ROOM.getByName(result.code);
        await room.fetch('https://room/rank', { method: 'POST' });
      }

      return Response.json(result, { headers: corsHeaders() });
    }

    // Leaving the queue without having been matched.
    if (url.pathname === '/api/quickmatch/cancel' && request.method === 'POST') {
      const { code } = (await request.json().catch(() => ({}))) as { code?: string };
      if (code) {
        const stub = env.MATCHMAKER.getByName(MATCHMAKER_SINGLETON);
        await stub.fetch('https://mm/dequeue', { method: 'POST', body: JSON.stringify({ code }) });
      }
      return Response.json({ ok: true }, { headers: corsHeaders() });
    }

    if (url.pathname === '/api/presence' && request.method === 'GET') {
      const stub = env.MATCHMAKER.getByName(MATCHMAKER_SINGLETON);
      const res = await stub.fetch('https://mm/presence');
      return Response.json(await res.json(), { headers: corsHeaders() });
    }

    if (url.pathname === '/api/rooms' && request.method === 'GET') {
      const stub = env.MATCHMAKER.getByName(MATCHMAKER_SINGLETON);
      const res = await stub.fetch('https://mm/rooms');
      return Response.json(await res.json(), { headers: corsHeaders() });
    }

    // Player accounts, friends and leaderboards.
    const hubMatch = url.pathname.match(/^\/api\/player\/([a-zA-Z]+)$/);
    if (hubMatch && HUB_ROUTES.has(hubMatch[1])) {
      const route = hubMatch[1];
      // Only the routes that create or mutate something are budgeted. Reading
      // your own profile or a leaderboard is cheap and happens on every visit.
      if (route in RATE_LIMITS) {
        const wait = await allow(env, request, route as keyof typeof RATE_LIMITS);
        if (wait) return tooMany(wait);
      }
      // `result` is deliberately absent from HUB_ROUTES: only the relay may
      // report a match outcome, and it reaches the hub object directly rather
      // than over this public surface.
      const stub = env.PLAYER_HUB.getByName(PLAYER_HUB_SINGLETON);
      const res = await stub.fetch(`https://hub/${route}`, {
        method: 'POST',
        body: JSON.stringify(await request.json().catch(() => ({}))),
      });
      return Response.json(await res.json(), { headers: corsHeaders() });
    }

    const match = url.pathname.match(/^\/api\/room\/([A-Z0-9]{4,8})$/i);
    if (match) {
      const wait = await allow(env, request, 'socket');
      if (wait) return tooMany(wait);
      const code = match[1].toUpperCase();
      const stub = env.GAME_ROOM.getByName(code);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  },
};
