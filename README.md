# REACTON

A multiplayer orb-reaction strategy game. Charge cells past **critical mass**,
propagate the cascade, capture the field. Play locally on one device
(pass-and-play) or online with friends via a room code.

**Live:** https://chainreaction-sooty.vercel.app

The product direction — art direction, modes, platform plan, naming — lives in
[Chain_Reaction_Game_Product_Roadmap.md](Chain_Reaction_Game_Product_Roadmap.md).
REACTON is the shortlisted name from §17; the name is **not yet cleared** for
trademark, app store, domain or social handles, so treat it as a working brand
until that check is done (roadmap §15).

## Tech stack

- **Client:** TypeScript + Vite, [Three.js](https://threejs.org/) for the 3D
  board/orbs, [GSAP](https://gsap.com/) for animation, Web Audio API for
  synthesized sound effects (no audio assets), Vibration API for haptics.
- **Online relay:** Cloudflare Workers + Durable Objects — one Durable Object
  instance per game room, holding the authoritative game state and relaying
  moves over WebSockets.

No backend database, no webfonts, no build-time asset pipeline beyond Vite —
everything (sound, particle effects, emoji textures, the type stack) is either
generated at runtime or already on the device.

## Getting started

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run typecheck
```

To work on the online relay locally:

```bash
npx wrangler dev
```

The client defaults to the production relay. To work against a local one, put
this in a `.env.local` (gitignored) and restart the dev server:

```bash
echo "VITE_RELAY_URL=http://127.0.0.1:8787" > .env.local
```

Do that any time you change `src/net/protocol.ts` or the engine — client and
relay run the same rules and have to move together.

### Build & deploy

```bash
npm run build
```

```bash
npx wrangler deploy
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
                  server run the *identical* engine and stay in sync — and it
                  is also what lets ai.ts search by simply playing moves on a
                  clone. Also holds the mode table, the seeded special-cell
                  lattice generator, and the local player record.

                  Imports inside this folder carry explicit .ts extensions:
                  it is the one layer that has to resolve with no bundler in
                  front of it, since `node --test` runs it directly.

  render3d/       Three.js rendering layer. ThreeRenderer owns the scene,
                  camera, lighting, and per-cell meshes; it mirrors the
                  engine's state independently (renderState) so animations
                  can play out wave-by-wave without depending on the engine's
                  already-final post-move state. fx3d.ts holds the particle/
                  ring/camera-shake helpers. timing.ts exists so callers can
                  sync audio to the blast without importing Three.

  net/            NetClient (WebSocket client with heartbeat + auto-reconnect)
                  and the shared protocol.ts message types.

  sfx/            Sfx (synthesized sound) and Haptics (Vibration API).

  main.ts         Screen state machine (menu → lobby → game → win) and the
                  glue between input, the engine, and the renderer.

server/
  GameRoom.ts     One Durable Object per room code. Runs the same GameEngine
                  as the client to validate and apply moves authoritatively,
                  then broadcasts them to every connected socket. Also owns
                  seat tokens, the room's head-to-head, taunt rate limiting,
                  and reporting finished ranked matches to the hub.
  Matchmaker.ts   One object for the whole game: the quick-match queue and the
                  list of rooms that opted to be public. Holds no game state,
                  only pointers to rooms.
  PlayerHub.ts    One object for the whole game: guest accounts, friend codes,
                  friendships and leaderboards.
  index.ts        Worker entry point — room codes, matchmaking routes, the
                  player API, and routing to the right Durable Object.
```

### Online features

**Quick match** brokers a room code and nothing else; the caller then joins over
the ordinary room socket. Keeping matchmaking to "which code" is what stops it
needing a second connection, its own state, or a parallel join path. Whoever
arrives first becomes the room others are matched into, and the host's client
starts the game the moment it fills. Matching is on mode *and* board size —
being dropped into rules you did not pick is worse than waiting longer.

**Bots solve the cold start, honestly.** A new player who opens quick match and
finds an empty queue does not come back, so there is a standing roster of 18 AI
opponents (`game/bots.ts`) rated on the same scale as human accounts. Quick
match holds out for a person for twelve seconds, then *offers* a bot near the
player's rating — it does not silently substitute one, because a player who is
unsure whether the opponent they just beat was real has been cheated of the
win. Bots are labelled everywhere they appear, the match banner says
`bot · unranked` for the whole game, and bot matches never touch the ladder.

The players-online figure is the real count of people queued or in listed
rooms, and is allowed to read zero. Inflating it is tempting and worse than
useless: someone shown "18 online" who then waits two minutes without a match
learns the number was invented and stops believing anything else the game says.
Eighteen *actually playable* opponents solve the same problem and survive
contact with the player.

**Rooms are private by default.** A code shared with a friend must never reach a
public list because of a default. Quick-match rooms opt in, so the browser can
fill one still sitting in the queue. Listings are pushed by the room itself on
every roster change, so they can only be wrong for as long as one call takes to
land, and a dead room still expires on the matchmaker's TTL.

**Rematch is a vote.** Everyone connected has to ask, then the relay starts a
fresh board on the same settings without bouncing anyone through the lobby. The
relay keeps the head-to-head, because it is the only party that knows the real
result.

**Taunts** are a fixed palette of twelve, not free text. An open chat box in a
game played with strangers drags in moderation, reporting and an abuse surface;
a closed set gives the same feeling with none of that, and needs no
localisation. The cooldown is enforced on the relay — a client-side limit is
only a suggestion.

### Identity and ranking

Identity is a **guest account**: the relay mints an id and a secret the first
time someone opens the online screen. No email, no password, no OAuth — so no
login wall and no personal data to protect. The cost, which the UI should keep
saying out loud: clearing browser storage loses the account. A short friend code
makes it shareable; account linking is additive later.

Ranked results come from the relay, never from a client — `result` is
deliberately not in the hub's public route table. Seats identify themselves with
their account secret on connect, and a result is rejected wholesale if any seat
is unverified, or if two seats share an account.

**Only public rooms are ranked.** A private room is people who chose each other,
which is both an obvious farming vector and, between friends, something that
should not move anyone's rank. Rating is Elo at K=24 and only applies to
head-to-head results; a free-for-all counts towards wins and matches but leaves
the ladder alone rather than inventing a number.

### Why the client and server share `GameEngine`

Rather than the server sending pre-computed animation events, it broadcasts
just the raw move (`{row, col}`). Every client — including the one that made
the move — replays it through their own local `GameEngine` instance. Because
the engine is a pure, deterministic function of (grid state, move), every
client computes the identical result independently. This keeps the protocol
tiny and makes "what should this look like" entirely the renderer's problem,
not the network layer's.

The consequence: **any change to the engine's rules is a protocol change.**
Client and relay must be redeployed together, or they will silently disagree
about the board. `GameEngine.test.ts` has a determinism test guarding this.

### Cascade termination

A board where one player owns every orb and every cell is loaded is a genuine
non-terminating cascade — each cell keeps being pushed back over critical mass
by its neighbours forever. The engine cuts out as soon as one player owns every
orb *and* every player has placed at least once, which is exactly the point
after which no further wave can change the outcome. The "everyone has moved"
half matters: a player who has not placed yet is still alive with zero orbs,
so the cascade has to be played out in full until they have had a turn.

### Modes

All seven from roadmap §5. They are not seven separate systems — they are four
shared capabilities:

| Capability | Where | Unlocks |
| --- | --- | --- |
| Special cells (`game/cells.ts`) | Engine | Chaos, Power Cells, Survival |
| Teams (`PlayerConfig.team`) | Engine | Team Battle |
| Series wrapper (`main.ts`) | UI only — no engine change | Tournament |
| Opponent AI (`game/ai.ts`) | Above the engine | Survival |

**Special cells.** A `void` is simply absent from the lattice: it drops out of
`neighborsOf`, so every adjacent cell's critical mass falls by one on its own.
No new explosion rule and orb conservation is untouched — it just reshapes the
board. `catalyst` and `damper` shift critical mass by ±1, which *does* break
conservation (a catalyst ejects one more orb than it consumes). That is
bounded: catalysts drive the board towards saturation, which the cascade guard
above already terminates, and dampers only ever remove orbs. A catalyst's
critical mass is floored at 2, because a corner site that pops the instant you
touch it can never be held and stops being a position you can play around.

Chaos and Power Cells are the same layer tuned differently: Chaos re-rolls a
random scatter every match, Power Cells is one designed arrangement you can
actually learn. Both are 180°-rotationally symmetric — in a game where anyone
may play anywhere, that is what stops a "random" board handing one player a
better half.

**Teams.** Seats alternate sides (`team = seat % 2`), so turn order alternates
between sides without the engine needing a rule for it. A side is out only when
every player on it is.

**Whose turn it is lives on the board**, not only in the HUD: the substrate's
corner brackets, edge ticks and a faint wash under the lattice carry the active
player's emission, easing across on each hand-off and settling on the winner at
the end. The frame is the right surface for it because nothing is ever played
there — it stays legible in peripheral vision while you are looking at the
middle of the board. The plate glow is much lower than it looks like it should
be (0.014): it shows through every gap in the lattice, so it covers far more
screen than its area suggests.

**Blitz** auto-plays a legal move on expiry rather than skipping — skipping
would leave a player who has never placed a particle un-eliminable and stall
the win condition.

**Survival** is the only mode needing an AI. Because the engine is pure, cheap
and deterministic, the AI doesn't estimate: it plays every legal move on a
throwaway clone and scores the result (material, board control, and how much of
its own position is exposed to an enemy cell that is one orb from critical).
Difficulty narrows how far down the ranked list it will pick rather than
degrading the evaluation — a weak opponent that evaluates badly plays
*strangely*, which reads as broken rather than as easy.

### Disconnect recovery

A player who drops mid-match keeps their seat and comes back to the board.

- **Seat tokens.** The relay issues a secret per seat on join and keeps it in
  the roster. A returning socket presents it and reclaims the same player id,
  colour, turn order and position. Without one, a rejoin is refused while a
  game is running, exactly as before — the token is what distinguishes "I am
  player 2 coming back" from "I am a stranger trying to join a live match".
- **Resume by snapshot, not by replay.** The relay sends the whole
  `EngineSnapshot`. There is no move log to reconcile and no chance of a
  partial replay diverging.
- **Connection generations.** Reclaiming a seat closes the socket that held it,
  and that stale socket's `close` arrives *after* the new one is live. Each
  connection carries a generation number and the relay ignores a close from a
  superseded one, or the returning player would be marked offline again
  immediately.
- **Never trusting `close`.** A socket whose peer stops answering can sit in
  `CLOSING` indefinitely and never fire `close` at all — observed in local dev,
  where the relay saw the disconnect and updated the roster while the client
  still believed it was connected. The client therefore polls its own
  `readyState` once a second rather than waiting for an event, which is what
  takes detection from "never" to about 600 ms.

While someone is away their pill is marked offline and the HUD names who the
match is waiting on. Turn order stays authoritative on the relay, so a dropped
player's turn pauses the game rather than being skipped or auto-played.

### What's local-only, and why

Chaos, Power Cells and Team Battle run online: they are deterministic and the
relay validates them like any other match. The relay generates the lattice
**seed** and every client rebuilds the identical board from it, so the protocol
stays a bare `{row, col}` per move and the host can't re-roll until they like
the board.

Blitz, Tournament and Survival are local-only. A turn clock has to be enforced
by the relay to stay server-authoritative (client-side, every client gets its
own idea of when a turn expired), Tournament needs series state the room
doesn't persist, and Survival's AI has no opponent to be.

### On "carefully balanced"

The roadmap asks for carefully balanced special cells. The numbers here are
defensible defaults, not playtested ones — special-site density, the ±1
critical-mass shift, the catalyst floor and the Survival difficulty curve all
live in `game/cells.ts` and `game/ai.ts` so they are tunable in one place. A
test asserts special sites stay under 35% of any generated lattice, which
catches density drift but says nothing about whether the modes are *fun*. That
needs real games.

## Known follow-ups

- Blitz online, via a Durable Object alarm that plays the timed-out turn
  server-side.
- Tournament online — the relay would need to hold series score across
  restarts.
- The Survival AI is 1-ply. It plays a sound game but can be baited by a
  position that looks good one move out and collapses two moves later.
- No rate limiting on `/api/create`, `/api/quickmatch` or `/api/player/register`.
  Nothing stops a script minting accounts or flooding the queue.
- Guest accounts cannot be linked or recovered. Clearing storage loses the
  account, and there is no way to move one to a second device.
- The matchmaker and player hub are each a single Durable Object. Fine at this
  scale, and the escape hatch is sharding (matchmaker) or D1 (hub), but neither
  has been load-tested.
- Ranked play can still be farmed by two people agreeing to meet in a public
  room. Rating only ever moves on head-to-head results, so the exposure is
  bounded, but there is no collusion detection.
- No moderation path for display names beyond stripping control characters.
- Idle Durable Object rooms aren't cleaned up on a TTL.
- A player who never returns stalls the match on their turn forever. A DO alarm
  could forfeit or auto-play a seat after a grace period — the same alarm Blitz
  online needs.
- Host migration only happens pre-game. If the host drops mid-match and never
  returns, nobody can trigger a rematch.
- Seat tokens live in `sessionStorage`, so a reconnect survives a refresh but
  not a new tab.
- Player stats are device-local (`localStorage`); the roadmap puts profiles and
  match history on the server only after the multiplayer loop is reliable.
- Board sizes are all portrait-shaped, so a landscape screen letterboxes
  heavily. A landscape-oriented lattice would suit wide ratios better.
- No error/crash monitoring or analytics yet (launch quality bar, roadmap §14).
