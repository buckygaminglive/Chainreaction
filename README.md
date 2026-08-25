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
  synthesized sound effects, a licensed background track, Vibration API for
  haptics.
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

                  Also holds the device-local player record (stats.ts) and
                  the menu's remembered choices (prefs.ts).

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

  net/            NetClient (WebSocket client with heartbeat + auto-reconnect),
                  the shared protocol.ts message types, the guest account, and
                  telemetry.ts — instrumentation with no vendor attached.

  sfx/            Sfx (synthesized effects + the background track) and
                  Haptics (Vibration API).

  main.ts         Screen state machine (title → lobby → game → win) and the
                  glue between input, the engine, and the renderer. Also
                  owns attract mode and the victory lap — both of which are
                  the same engine and renderer, driven by nobody.

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

### The title screen

**One decision, and the rest one level down.** The menu used to be the whole
match configuration, expanded: seven mode chips, a lattice preview, a player
stepper, board size, particle style and four colour swatches — eighteen
controls, with "Start reaction" below the fold on every phone *and* on a
1280×800 desktop. The title screen now carries a mark, a wordmark, **Play**, and
one line saying what Play will start (`Classic · 11×6 · 2 players`) which is
also the way in to change it. Nothing was removed; the setup sheet holds all of
it. The screen is `overflow: hidden` on purpose — everything it offers has to be
reachable without a gesture, at every size, and it can only promise that
because it carries one decision.

**Preferences are remembered** (`game/prefs.ts`), which is what makes the above
possible: defaulting Play to "whatever you played last" needs a last. Mode,
board size, player count, particle style and mute survive a visit. Values are
validated on read rather than trusted — a record written by an older build can
name a mode this one no longer has.

**Attract mode** runs a real match behind the title screen: a live `GameEngine`,
two `ai.ts` seats, and the same `ThreeRenderer` the game uses, held at low
opacity under a scrim. It does three things at once, which is why it is worth a
WebGL context on the menu:

- it is the brief's motion language (§18) on a screen that previously had a
  single CSS keyframe on it,
- it shows a first-time player the mechanic before they have read a word,
- and it pulls the ~600 KB renderer chunk in while they are still looking at the
  menu, so the first **Play** no longer waits on a download behind a screen that
  has already switched to an empty board.

Two seats, not four: §18 asks for one or two controlled energy accents and rules
out a rainbow. It is skipped entirely under `prefers-reduced-motion`, stops
scheduling moves while the tab is hidden (a throttled `requestAnimationFrame`
would leave every queued move stacked behind an animation that never settles),
and is torn down before a real board mounts — two WebGL contexts for one board
is one too many.

**The mark is the favicon's geometry**, animated, rather than a second mark
invented for the screen: the core charges, goes critical and fires into its four
neighbours. The logo demonstrates the mechanic. Previously the screen showed a
dot with two expanding rings while the actual brand mark sat unused in
`favicon.svg`.

### The victory lap

The board used to freeze the instant the result card appeared, which is the
least celebratory thing a chain-reaction game can do. It keeps reacting instead:
the winner's own cells are pushed over critical roughly once a second and
allowed to cascade under the card.

It runs on a **copy** of the final position with the game-over flag cleared,
because `canPlay` — correctly — refuses every move once a winner exists. Every
pop is still a real engine move on that copy, so the cascade rules stay in one
place, and the live engine keeps the exact position the match ended on for the
result card and the statistics to read. It prefers cells one particle short of
critical so most placements actually pop, but not every time: an unbroken string
of explosions reads as a stuck animation rather than a board still alive.

The result itself is typeset in two parts — who it was, then what they did —
because a single run-on line in the UI font read as a dialog label rather than a
result. The winner's emission colour is set once as a custom property on the
card and drives the name, its glow and the rule beneath it.

### Sound, haptics and motion

Two buses hang off the master gain rather than one. Effects and the ambient
bed have to be mixable against each other: a player who wants the room tone
without the explosions, or the reverse, has no way to say so if they share a
fader.

The **background track** is `public/audio/quantum-lab-protocol.mp3`, streamed
through a `MediaElementAudioSourceNode` into the same graph as the effects
rather than played from a bare `<audio>` tag — that's what lets one mute
switch and one duck apply to both. It ducks to 45% over a live board, because
it exists to keep a screen from being silent, not to play over the game.
`preload="none"` keeps the ~5MB file off the critical path entirely until a
match is actually wanted; it is never started before a user gesture either —
building an `AudioContext` earlier only earns an autoplay warning and a
suspended context, so `startBed()` sets a flag and the first `unlock()`
brings it up. The graph (element, gain node) is built once and reused —
`createMediaElementSource` throws if called twice on the same element, so
starting and stopping the track from then on is `play()`/`pause()`, not a
rebuild.

**Settings** live behind the gear on the title screen: master level, ambience,
haptics and motion. Haptics used to fire unconditionally, which left the
players who dislike vibration no way out except muting a different sense
entirely; where the device has no vibration motor at all the sheet says so
rather than offering a switch that does nothing.

**Reduced motion is a class on the document**, not a bare media query, so the
in-app Motion setting and the operating system's drive exactly the same CSS.
It starts on `auto` — following the system — and a change there is picked up
live while the player has not overridden it. A system-wide motion preference
is a blunt instrument; someone may want the cascades here and nowhere else.

### Brand assets

PWA install icons, the maskable icon and the Open Graph card are generated by
`scripts/make-icons.mjs` (`npm run icons`) — signed distance fields
composited into a buffer and written out through the zlib that ships with
Node, no dependencies. They are drawn in code for the same reason the game
synthesises its own sound: there is then one definition of the mark, in text,
that regenerates identically. `public/favicon.svg` is the geometry it mirrors,
so the two move together.

The wordmark on the share card is drawn rather than set. Seven letters is the
whole alphabet it needs, and a geometric monoline matches §18 better than
whichever face happens to be installed on the machine running the script —
and renders the same everywhere, which a system font would not.

The share card has to be a raster at an absolute URL: a relative path resolves
against the crawler, and almost no platform renders SVG. The origin is written
into `index.html` and has to change with the deployed domain.

### Ranks

Named tiers (roadmap §9) over the Elo the relay already keeps, in
`game/rank.ts`. The rating was always there and always invisible: "1043"
tells a player nothing about whether they are doing well, and a tier is the
same number with a meaning attached. It costs no new server state — a pure
function of a number that already exists, with a test pinning the bands to
the scale in `PlayerHub.ts` (accounts start at 1000) and `bots.ts` (the
roster spans 780–1500) so every tier is reachable and a new account starts
*inside* Bronze rather than on a boundary it falls off after one loss.

The tier colours are metals rather than hues. §18 rules out a rainbow, and
six new accent colours is exactly that; bronze through diamond reads as a
progression on its own.

The **emblems** (`render/rankBadge.ts`) are drawn in code for the same reason
the app icons are: one definition that scales to any size and recolours from
the tier's own metal. They escalate on a single visual axis rather than being
six unrelated shapes — a charged core, then orbital rings, then emission
nodes, then a corona. That is the game’s own subject matter climbing, so a
Diamond badge reads as *more of the same thing* as a Silver one, which is
what makes a ladder legible at a glance. A shield, a crown and a star would
each be prettier alone and meaningless as a sequence.

**A rating that only ever shows a total is one nobody can feel themselves
climbing.** The hub returns the *delta* alongside the new rating — captured
before the Elo update, because recomputing it on the client would mean
trusting a client to remember what its own rating used to be — and the room
maps account ids back to seat ids and broadcasts a `rated` message. The
result card shows the emblem, the tier and what the match just did to get you
there. Only public rooms send it; a private game has nothing to report.

### Telemetry

`net/telemetry.ts` is the instrumentation §14 asks for — session length,
mode popularity, match completion, disconnects, and uncaught errors — and
deliberately **not** a vendor. With no `VITE_TELEMETRY_URL` set it collects
nothing and sends nothing.

That ordering is the point. The events have to exist and be right before
choosing where they go; picking an SDK first is how analytics ends up shaped
by whatever that SDK made easy. Errors go down the same pipe rather than to a
second vendor with its own consent story and its own outages, capped per
session so a runaway error loop cannot become a runaway upload loop.

Nothing identifying is collected: no display names, no room codes, no account
secrets, no board positions — counts, durations and fixed labels only. The
session id is random per visit and never persisted, so retention has to be
measured on the receiving side from the account id the relay already holds.
Do Not Track is honoured, and the switch is in Settings, kept outside `prefs`
so that resetting game settings cannot quietly reset a consent choice.

### How to play

Five pages, one idea each, replacing a single card with four rules on it. The
diagrams are the board’s own geometry and palette — cells, particles and the
same cyan and red emissions — so nothing has to be re-learned the moment the
player closes the overlay and taps a cell. The last page starts a game rather
than returning to the title screen: someone who has just read how to play
wants to play.

### Installable, and packageable

`public/sw.js` is the service worker. It exists for two reasons, in this order:
Chrome will not offer installation without a fetch handler, and a Play Store
Trusted Web Activity *is* an installed PWA in a native wrapper — so without it
there is no Android app. Second, everything except online play runs on the
device, so a bad connection has no business producing a browser error page.

It is registered in production builds only: in dev it would serve yesterday's
bundle over Vite's, which looks exactly like a broken hot reload.

Two routes are deliberately left alone. Relay calls are cross-origin and every
answer is about right now, so a cached room list is a wrong one. The soundtrack
is served with Range requests, and answering one from the cache with a full 200
is how audio breaks in ways that are very hard to trace.

Packaging steps live in [ANDROID.md](ANDROID.md).

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

### Credentials never travel in a URL

The account secret is sent as an `auth` **message** over the open socket, not
as a query parameter on the socket URL. A URL is not a secret: it lands in the
edge provider's access logs, in browser history, and in any error report that
captures the request — and this credential is permanent, so losing it means
losing the account. A message body is inside the TLS session and is not logged
by default.

The seat token is the deliberate exception and stays in the URL. It has to be
read during the HTTP upgrade, before a socket exists, because it is what
decides whether a rejoin mid-match is allowed at all. It is also worth far
less: room-scoped, and dead when the room is.

Secrets are compared with a constant-time helper. `===` on strings returns at
the first differing byte, so how long it takes is a function of how much of the
secret the caller guessed. Over the open internet, jitter dwarfs that signal —
this is hardening, not a fix for a live hole — but it costs microseconds and
the failure mode is somebody's account.

The room also refuses to seat one account twice. That is the cheap half of
collusion prevention, and it has to happen in the room because only the room
knows who else is sitting down.

### Rate limiting

One `RateLimiter` object **per client IP** rather than one global object — a
single limiter would put every request in the game through one lock, which is a
worse bottleneck than the abuse it prevents.

Budgets are per IP per window and only cover routes that *create or mutate*
something (`register`, `create`, `quickmatch`, `addFriend`, `rename`, plus
socket upgrades). Reading a profile or a leaderboard is unbudgeted — those
happen on every visit. Limits are deliberately loose: carrier-grade NAT and
school networks put many genuine players behind one address, so every limit
sits far above what a person can produce and far below what a script does in a
second. Account creation is the one that really matters, since unbounded
registration grows storage forever and floods the ladder with rows nobody
played.

It **fails open**. A limiter that takes the whole game down when it has a bad
day is a worse outage than the abuse it exists to prevent, so an error in the
check allows the request and logs it.

Moves are never rate limited — they travel over the already-open WebSocket, and
only the upgrade is budgeted. That budget is generous on purpose, because the
reconnect ladder makes up to nine attempts on a bad connection and cutting
someone off mid-match for having poor wifi would be a far worse bug.

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

Tournament and Survival are local-only. Tournament needs series state the room
doesn't persist, and Survival's AI has no opponent to be. Blitz was here too
until the room alarm gave the relay a clock of its own to keep.

### On "carefully balanced"

The roadmap asks for carefully balanced special cells. The numbers here are
defensible defaults, not playtested ones — special-site density, the ±1
critical-mass shift, the catalyst floor and the Survival difficulty curve all
live in `game/cells.ts` and `game/ai.ts` so they are tunable in one place. A
test asserts special sites stay under 35% of any generated lattice, which
catches density drift but says nothing about whether the modes are *fun*. That
needs real games.

## Known follow-ups

- Tournament online — the relay would need to hold series score across
  restarts.
- The Survival AI is 1-ply. It plays a sound game but can be baited by a
  position that looks good one move out and collapses two moves later.
- Guest accounts cannot be linked or recovered. Clearing storage loses the
  account, and there is no way to move one to a second device.
- The matchmaker and player hub are each a single Durable Object. Fine at this
  scale, and the escape hatch is sharding (matchmaker) or D1 (hub), but neither
  has been load-tested.
- Ranked play can still be farmed by two people agreeing to meet in a public
  room. Rating only ever moves on head-to-head results, so the exposure is
  bounded, but there is no collusion detection.
- No moderation path for display names beyond stripping control characters,
  zero-width characters and bidi overrides.
- The Content-Security-Policy in `vercel.json` hard-codes the relay origin in
  `connect-src`. Moving or renaming the relay means editing it there too, or
  online play breaks with no console error the player can act on.
- Host migration only happens pre-game. If the host drops mid-match and never
  returns, nobody can trigger a rematch.
- Seat tokens live in `sessionStorage`, so a reconnect survives a refresh but
  not a new tab.
- Player stats are device-local (`localStorage`); the roadmap puts profiles and
  match history on the server only after the multiplayer loop is reliable.
- Board sizes are all portrait-shaped, so a landscape screen letterboxes
  heavily. A landscape-oriented lattice would suit wide ratios better.
- Telemetry has no collection endpoint configured, so nothing is actually
  being gathered yet — the events exist and are correct, the destination is
  a decision that has not been made.
- The privacy notice and terms are accurate drafts with bracketed values to
  fill in, and have not been through a lawyer.
- Rank tiers are cosmetic over the existing Elo. There are no rewards, no
  seasons and no decay.
- Attract mode holds a WebGL context on the title screen. It is torn down
  before a match mounts and skipped under reduced motion, but it has not been
  profiled on a low-end phone.
