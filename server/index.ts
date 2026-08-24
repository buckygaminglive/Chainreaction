import { GameRoom, MATCHMAKER_SINGLETON, PLAYER_HUB_SINGLETON, type Env } from './GameRoom';
import { Matchmaker } from './Matchmaker';
import { PlayerHub } from './PlayerHub';
import type { BoardSizeKey } from '../src/net/protocol';
import { GAME_MODES, type GameModeKey } from '../src/game/modes';

export { GameRoom, Matchmaker, PlayerHub };

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
      const code = generateRoomCode();
      return Response.json({ code }, { headers: corsHeaders() });
    }

    // Quick match brokers a room code and nothing else: the caller then joins
    // it over the ordinary room socket. Keeping matchmaking to "which code" is
    // what stops it needing a second connection or any game state of its own.
    if (url.pathname === '/api/quickmatch' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { mode, boardSize } = sanitize(body);
      const stub = env.MATCHMAKER.getByName(MATCHMAKER_SINGLETON);
      const res = await stub.fetch('https://mm/queue', {
        method: 'POST',
        body: JSON.stringify({ code: generateRoomCode(), mode, boardSize }),
      });
      const result = await res.json();
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
      const code = match[1].toUpperCase();
      const stub = env.GAME_ROOM.getByName(code);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  },
};
