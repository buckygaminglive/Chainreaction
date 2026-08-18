import { GameRoom, type Env } from './GameRoom';

export { GameRoom };

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — avoids look-alikes

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

    const match = url.pathname.match(/^\/api\/room\/([A-Z0-9]{4,8})$/i);
    if (match) {
      const code = match[1].toUpperCase();
      const stub = env.GAME_ROOM.getByName(code);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  },
};
