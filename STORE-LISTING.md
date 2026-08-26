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
| In-app actions | Yes | No | Optional | Match results feeding the ladder: wins, losses, rating, best chain. |
| Approximate location | No | — | — | Never requested. |
| Personal info (email, phone, address) | No | — | — | There is no sign-up. |
| Financial info | No | — | — | No purchases. |
| Device or other IDs | No | — | — | No advertising id, no device fingerprint. |

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
- **User-generated content: display names only.** There is no chat; in-game
  reactions are a fixed set of twelve icons that cannot be extended.

That last point matters: a fixed reaction palette rather than open chat is what
keeps this out of the "user-generated content" rating tier, and it was a
deliberate design decision, not an omission.

## Required assets

| Asset | Status |
|---|---|
| App icon 512×512 | `public/icon-512.png` |
| Feature graphic 1024×500 | `public/feature-graphic.png` |
| Phone screenshots (2–8) | **Not taken** — capture from a real device |
| Tablet screenshots | Optional, but improves tablet placement |
| Privacy policy URL | `https://YOUR-DOMAIN/privacy.html` — fill in its bracketed values first |

Screenshots to take, in this order — the first two are what people actually
look at:

1. A board mid-cascade, orbs in flight
2. The result card after a long chain
3. The title screen
4. The ranked profile showing a tier emblem
5. Team Battle or Power Cells, to show the modes exist
