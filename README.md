# Chain Reaction — Orb Wars

A 3D take on the classic *Chain Reaction* strategy game. Place orbs, trigger
cascading chain-reaction explosions, and capture the whole board. Play locally
on one device (pass-and-play) or online with friends via a room code.

**Live:** https://chainreaction-sooty.vercel.app

## Tech stack

- **Client:** TypeScript + Vite, [Three.js](https://threejs.org/) for the 3D
  board/orbs, [GSAP](https://gsap.com/) for animation, Web Audio API for
  synthesized sound effects (no audio assets), Vibration API for haptics.
- **Online relay:** Cloudflare Workers + Durable Objects — one Durable Object
  instance per game room, holding the authoritative game state and relaying
  moves over WebSockets.

No backend database, no build-time asset pipeline beyond Vite — everything
(sound, particle effects, emoji textures) is generated at runtime.

## Getting started

```bash
npm install
npm run dev      # client dev server (Vite)
```

To work on the online relay locally:

```bash
npx wrangler dev  # runs the Worker + Durable Object locally
```

The deployed client currently points at a fixed production relay URL
(`src/net/NetClient.ts`). Point it at your local `wrangler dev` instance if
you need to test protocol changes end-to-end before deploying.

### Build & deploy

```bash
npm run build            # client → dist/
npx wrangler deploy      # relay server → Cloudflare
```

The client (`dist/`) is deployed to Vercel; the relay is deployed to
Cloudflare Workers independently. They can be redeployed on different
schedules — the protocol in `src/net/protocol.ts` is the contract between
them.

## Architecture

```
src/
  game/           Pure game logic — no rendering, no DOM. GameEngine holds
                  the grid, resolves chain-reaction explosions wave by wave,
                  tracks eliminations/win condition. Fully deterministic:
                  same starting state + same move sequence → same result.
                  This determinism is what lets the client and the relay
                  server run the *identical* engine and stay in sync.

  render3d/       Three.js rendering layer. ThreeRenderer owns the scene,
                  camera, lighting, and per-cell meshes; it mirrors the
                  engine's state independently (renderState) so animations
                  can play out wave-by-wave without depending on the engine's
                  already-final post-move state. fx3d.ts holds the particle/
                  ring/camera-shake helpers.

  net/            NetClient (WebSocket client with heartbeat + auto-reconnect)
                  and the shared protocol.ts message types.

  sfx/            Sfx (synthesized sound) and Haptics (Vibration API).

  main.ts         Screen state machine (menu → lobby → game → win) and the
                  glue between input, the engine, and the renderer.

server/
  GameRoom.ts     The Durable Object. One instance per room code. Runs the
                  same GameEngine as the client to validate and apply moves
                  authoritatively, then broadcasts them to every connected
                  socket.
  index.ts        Worker entry point — room-code generation and routing
                  requests to the right Durable Object.
```

### Why the client and server share `GameEngine`

Rather than the server sending pre-computed animation events, it broadcasts
just the raw move (`{row, col}`). Every client — including the one that made
the move — replays it through their own local `GameEngine` instance. Because
the engine is a pure, deterministic function of (grid state, move), every
client computes the identical result independently. This keeps the protocol
tiny and makes "what should this look like" entirely the renderer's problem,
not the network layer's.

## Known follow-ups

- No automated tests yet — `GameEngine` is pure logic and a good first
  target.
- No code-splitting — Three.js loads on initial page load rather than only
  when entering the game screen.
- No rate limiting on `/api/create` (room creation).
- Idle Durable Object rooms aren't cleaned up on a TTL.
