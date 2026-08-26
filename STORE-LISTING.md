# Play Store listing

Draft copy and form answers. The data-safety section is derived from what the
code actually does — if that changes, this has to change with it, because the
form is a declaration and Google checks it against observed behaviour.

> **Name: FISSILE.** Chosen after checking Reacton, Orbix, Popline, Blastix,
> Cellix, Kriton, Shockwave and Ripple Rush — all of which were taken or sat
> beside an existing mark in the same category. Casual searches found nothing
> for FISSILE in games; that is **not** a trademark clearance, and USPTO
> classes 9 and 41 remain the check that counts before the package id is
> locked at `bubblewrap init`.

---

## App name

Max 30 characters. Google counts the whole string including any subtitle.

```
FISSILE: Chain Reactor
```

22 of 30 characters. The subtitle is doing discovery work, not branding work:
"chain reaction" is the phrase people actually search for, and carrying it here
costs nothing while the name itself stays distinct and ownable. The wordmark,
the icon and the home-screen label stay the bare **FISSILE**.

## Short description

Max 80 characters. This is the line under the icon in search results, and it
sells the install more than the long description ever will.

```
Overload a cell, trigger the cascade, take the whole board. 1v1 or 4-player.
```

(75 characters.)

## Full description

Max 4000 characters.

```
Charge a cell past critical mass and watch it go.

FISSILE is a chain-reaction strategy game. Tap a cell to add a particle. Fill
it past its limit — 2 in a corner, 3 on an edge, 4 in the middle — and it
bursts, firing one particle into every neighbour and turning each of them
yours. Those cells can burst too. A single well-placed tap can roll across the
entire board.

Simple enough to understand in one move. Deep enough that corners, timing and
restraint decide games.

SEVEN MODES
• Classic — pure positioning and chain planning
• Blitz — ten seconds a turn, clock enforced by the server
• Chaos — a new lattice every match, with dead sites and catalysts
• Power Cells — one engineered board you can actually learn
• Team Battle — 2v2, turns alternating between sides
• Tournament — best of five, series score carried between games
• Survival — you against an AI that gets better every round

PLAY WITH ANYONE
• Ranked matches against real opponents, with a proper ladder
• Bronze through Master, with a rating that moves on every result
• Private rooms — share a code, play with friends, nothing rated
• Pass-and-play on one device, 2 to 6 players, with named seats
• Reconnect straight back into your match if your connection drops

BUILT TO FEEL GOOD
• Every explosion is real 3D, not a sprite
• Chain counters, screen feedback and haptics that scale with the cascade
• Board shapes itself to your screen — tall on a phone, wide on a monitor
• Works offline for local play

No ads. No energy timers. No paywall.
```

## Categorisation

| Field | Answer |
|---|---|
| App or game | Game |
| Category | Strategy |
| Tags | Board, Strategy, Multiplayer, Casual |
| Contains ads | **No** |
| In-app purchases | **No** |

## Data safety form

This is the section most likely to be wrong, so each answer below states why.

**Does your app collect or share any of the required user data types?**
Yes — but only if a player uses online mode.

| Data type | Collected | Shared | Required | Why |
|---|---|---|---|---|
| Name | Yes | No | Optional | The display name the player chooses. Shown to opponents and on leaderboards. Never a real name unless they type one. |
| User IDs | Yes | No | Required for online | A random guest account id. No email, no password, no sign-in. |
| In-app actions | Yes | No | Optional | Match results feeding the ladder: wins, losses, rating, best chain, and the last 25 ranked matches — each holding the opponent's display name, the rating change and a timestamp. |
| Approximate location | No | — | — | Never requested. |
| Personal info (email, phone, address) | No | — | — | There is no sign-up. |
| Financial info | No | — | — | No purchases. |
| Device or other IDs | No | — | — | No advertising id, no device fingerprint. |

**Avatars are generated, not uploaded.** A player picks one of 24 emblems
drawn in code and the relay stores a two-character key. No image ever leaves
the device, because none is ever chosen from it. This is what keeps **User-
generated content: display names only** true in the content rating
questionnaire, and keeps **Photos** off this form. Accepting real uploads would
change both answers, and would need a moderation and reporting path before it
could ship.

**Security practices**

- Data is encrypted in transit — HTTPS and WSS throughout.
- Users can request deletion — via the contact address in the privacy policy.
- Data collection is optional — local play contacts no server at all.

**Diagnostics — read this before answering**

The app contains a telemetry module (`src/net/telemetry.ts`), but it is
**inert**: with no `VITE_TELEMETRY_URL` configured it collects nothing and
sends nothing. As shipped today, answer **no** to diagnostics collection.

**The moment you configure an endpoint, this form becomes wrong** and has to be
updated to declare app activity and crash logs. That is a compliance issue, not
a formality.

## Content rating questionnaire

Answer honestly and it lands at the lowest rating. The relevant answers:

- Violence: none. Abstract shapes; nothing is depicted as harm.
- Sexuality, drugs, gambling, profanity: none.
- **User interaction: yes** — players can play online with strangers.
- **Do users share personal information: no** — no free-text chat, no profile
  fields beyond a display name.
- **User-generated content: display names only.** Players can send emoji
  reactions and short quick-chat phrases, but both are fixed lists chosen at
  build time. Neither can be extended by a player.

That last point matters, and it is enforced by the wire format rather than by
policy: a reaction is sent as `{ type: 'taunt', emoji: 3 }` and a message as
`{ type: 'chat', phrase: 12 }` — an index into a list the relay validates
against. There is no field anywhere in the protocol that carries player-authored
text, so there is nothing to moderate and no way for one player to put arbitrary
words on another's screen.

Adding real free-text chat would change three answers on this page at once —
user-generated content, messages collected, and the content rating tier — and
Play would additionally require per-message reporting, per-player blocking and a
stated moderation policy before it would pass review. That is the trade being
made here, not an omission.

## Required assets

| Asset | File |
|---|---|
| App icon 512×512 | `store-assets/play-icon-512.png` |
| Feature graphic 1024×500 | `store-assets/feature-graphic-a.png` or `-b.png` — pick one |
| Phone screenshots (2–8) | `store-assets/screenshots/` — five, 1080×1920 |
| Tablet screenshots | Optional, but improves tablet placement |
| Privacy policy URL | `https://YOUR-DOMAIN/privacy.html` |

### App icon

Upload `store-assets/play-icon-512.png`, **not** `public/icon-512.png`.

They are deliberately different assets. The manifest icon draws its own
rounded plate, which is correct for a PWA install prompt but breaks Play's
rules — Play applies a 30% corner mask and a drop shadow itself, so a
pre-rounded asset arrives as a rounded rectangle sitting inside another one.
The store icon is therefore full-bleed and shadowless.

`npm run icons:app` regenerates the whole named set from one vector source
and asserts every hard requirement — 512×512, 32-bit PNG, sRGB, under 1024 KB,
fully opaque, square corners, and the mark inside the adaptive safe zone —
exiting non-zero if any of them stops being true. Cheaper to fail here than to
find out from a rejection days later.

`store-assets/icon-candidates/play-icon-generated-art-512.png` is the
alternative built from generated key art. It also passes the spec; it is just
not the vector mark.

### The icon set, and why the names matter

`scripts/make-app-icons.mjs` owns every file below. The names are not
decorative — the manifest, the HTML head, Apple's touch-icon lookup and
Android's mipmap resolver all match on them, so a tidier name is a missing
icon.

| File | Where it is used |
|---|---|
| `public/favicon-16x16.png`, `-32x32`, `-48x48` | browser tabs, bookmarks |
| `public/apple-touch-icon.png` | iOS home screen, 180×180, full-bleed |
| `public/icon-192.png`, `icon-512.png` | manifest `purpose:any`, plated |
| `public/icon-maskable-192.png`, `-512` | manifest `purpose:maskable` |
| `store-assets/play-icon-512.png` | Play Console store listing |
| `store-assets/android/ic_launcher_*.png` | adaptive icon layers, 432×432 |
| `store-assets/android/mipmap-*/` | legacy + round launcher densities |

Two things are worth knowing before changing any of it:

**`icon-512.png` and `icon-maskable-512.png` are fetched over HTTP by
`twa-manifest.json` at build time.** The Android launcher icon therefore comes
from `public/`, one deploy later — editing them locally does nothing until the
site is redeployed and `bubblewrap build` is re-run.

**Maskable is not the same asset as `any`.** A launcher crops a maskable icon
to a shape of its choosing. Android guarantees only the central 66.7% of an
adaptive icon; the W3C maskable safe zone is a circle of 80% diameter. The mark
spans 73% of its box unscaled, so it clears 80% but is clipped by 66.7% — the
maskable variants shrink it to fit, and the build measures the rendered pixels
to prove it rather than trusting the transform.

### Feature graphic

Two variants, both 1024×500. The key art is generated; the FISSILE lockup on
top is the real one, drawn by `scripts/make-store-graphics.mjs` from the same
`brand-kit.mjs` geometry as the icon and the favicon. Type is never left to an
image model — the one word that has to survive being scaled to a thumbnail is
the name.

- **A** — a 3D lattice caught mid-burst. Warmer, more depth, more obviously a
  game. The stronger of the two at thumbnail size.
- **B** — the flat top-down lattice, much closer to what the game actually
  looks like in play.

### Form factors beyond the phone

Play asks for a separate screenshot set per form factor, and the tablet slots
are marked required once those form factors are declared. The game earns them:
the board has a wide orientation, so a landscape capture is not a stretched
phone screenshot but a genuinely different layout.

`npm run shots` captures all four. `SHOT_PROFILES=desktop npm run shots`
narrows it — a full run plays four complete games and is not quick.

| Slot | Folder | Size | Play's limits |
|---|---|---|---|
| Phone | `screenshots/phone/` | 1080×1920 | 9:16, sides 320–3,840 |
| 7-inch tablet | `screenshots/tablet-7/` | 1920×1080 | 16:9, sides 320–3,840 |
| 10-inch tablet | `screenshots/tablet-10/` | 2560×1440 | 16:9, sides 1,080–7,680 |
| Play Games on PC | `screenshots/desktop/` | 1920×1080 | 16:9, sides 720–7,680, 4–8 shots |
| Chromebook | `screenshots/desktop/` | 1920×1080 | 16:9, sides 1,080–7,680, 4–8 shots |

PC and Chromebook share one set deliberately. They are the same application at
the same resolution on the same class of screen; producing two identical sets
under different names would be busywork, not diligence.

The CSS viewport and device pixel ratio are chosen together per profile so the
capture lands exactly on the target pixel size *and* the CSS width resolves to
the layout that class of device would really get. Emulating 1920 CSS pixels and
filing it as a 7-inch tablet would photograph the desktop layout under the
wrong label.

### Play Games on PC: logo and feature graphic

`npm run assets` builds both into `store-assets/play-games-pc/`.

Play composites them into one **game card** — the logo centred on top of the
feature graphic — which is what drives their otherwise odd constraints:

- `pc-logo-600x400.png` — transparent PNG, exactly 600×400, carrying the
  wordmark because the slot must represent the name of the game.
- `pc-feature-graphic-1920x1080.png` — 16:9, and **no text**, because the logo
  is landing on top of it. This is why it does not reuse
  `feature-graphic-a.png`: that one has the lockup composited in for the main
  store listing, which is precisely what this slot forbids.

The first attempt resized the key art straight to 16:9 and it was wrong. The
burst sits dead centre in the source and Play centres the logo, so the wordmark
landed on the brightest pixels in the frame and stopped being readable. The art
is now panned to put the burst in the upper right, with a soft darkening across
the middle for the type to sit on. `preview-game-card.png` is the composite
Play will actually build — check that one, not the two halves.

### Phone screenshots

Real captures, not mock-ups: `scripts/make-screenshots.mjs` drives Chrome over
the DevTools Protocol against the running app, has the game's own AI play a
real match, and photographs it. Play's metadata policy requires screenshots to
represent actual app content, and this is the cheapest way to keep that true
every time the UI changes.

Upload in this order — Play shows the first two in search results, so the
gameplay leads and the branding follows:

1. `01-chain-reaction.png` — a contested board mid-cascade, chain counter live
2. `02-victory.png` — the result card, reaction still running behind it
3. `03-modes.png` — the setup sheet: seven modes, named seats, board shape
4. `04-how-to-play.png` — page 1 of the paged tutorial
5. `05-title.png` — the title screen

`store-assets/screenshots/alternates/` holds the frames that were not chosen,
including two other moments in the same cascade and a settled mid-game board.
