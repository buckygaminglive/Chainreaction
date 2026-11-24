# FISSILE: Chain Reactor 2.0.5 (version code 14)

File: `FISSILE-2.0.5-code14.aab` (signed release bundle)
Play Console "What's new": `play-store-whats-new.txt`

**This version needs the updated relay deployed** (`npx wrangler deploy` from the project folder). Without it, ranked queues for 3 or 4 players and the Auto board size don't work, and online matches have no 20-second clock.

## Ranked

- **Points instead of rating.** Every account starts **Unranked at 0 points**.
  - The tiers are:

    | Tier | Points needed |
    |---|---|
    | Unranked | 0 |
    | Bronze | 100 |
    | Silver | 300 |
    | Gold | 600 |
    | Platinum | 1000 |
    | Diamond | 1500 |
    | Master | 2200 |

  - Points never go below 0.
  - Existing accounts start again at 0 points. Their old rating is kept hidden and only used for matchmaking.
  - The leaderboard starts fresh.
- **Choose how many players:** 1v1, 3 players or 4 players. Points depend on where you finish:

  | Match | 1st | 2nd | 3rd | 4th |
  |---|---|---|---|---|
  | 1v1 | +25 | −15 | | |
  | 3 players | +30 | +10 | −15 | |
  | 4 players | +35 | +15 | −5 | −20 |

  - **Leaving** a ranked match, or being removed for missed turns, costs **−30**. That is always worse than finishing last, so quitting never pays.
  - The points table is shown on the ranked screen before you search.
- **Auto board size.** You can be matched with players queued on any board size. If someone picked a size, the match uses it.
- **Ranked rooms are private.** They never appear in the public room list. The relay starts the match by itself once all players are in.
  - The ranked screen shows how many people are searching for each match size, and the count refreshes while you wait.
- Team Battle isn't offered in ranked, because it has no single finishing order.
- The result card shows your finishing place and the points change, for example "1st · 30 pts +30".

## Turn clock online

- Every online match now has **20 seconds per turn**. Blitz keeps its 10.
- When the clock runs out, a move is played for you and it counts as a strike. You get a warning, and a last-chance warning on the second strike.
- **On the third strike the player is out.** Their orbs are cleared and the match carries on without them. In ranked, this counts as leaving.

## Confirmations

- **Exit:** pressing Back on the home screen asks "Exit FISSILE?" before closing the app.
- **Leaving a match:** the back arrow or Back button asks first.
  - In a ranked match it warns that you will lose 30 points.
  - In an online match, leaving takes you out straight away, so the others don't wait out your turn clock.

## Sound

- The speaker button opens a menu with separate switches for **game sounds**, **music** and **Nova's voice**, plus "Mute everything". It works on the home screen and during a match.

## Settings

- Settings is split into five tabs: **Sound, Graphics, Nova, Chat and General**. The last tab you opened is remembered.
- On phones the tabs sit along the top of the sheet. On wide screens they become a side list with the settings beside them.

## Runs cooler (Auto graphics)

- When nothing is moving, the board draws at 30 frames per second. Moves, explosions and touches still run at full speed.
- Drawing is capped at 2× screen density. On 3× phone screens this roughly halves the pixels drawn, with no visible difference.
- The board behind the title screen runs at 24 frames per second and lower resolution.

## Technical

- `GameEngine.forfeit()` takes a player out deterministically. The relay and every app apply it in the same order as moves, so all screens stay in sync.
- Relay: new `leave`, `strike` and `forfeit` messages, plus a `/refill` matchmaker route that reopens a place if someone drops out before the start. Rank points are in `src/net/rankPoints.ts`, shared by the relay and the app.
- Tested with three players on a local relay:
  - A 3-player ranked match started on its own, and Auto took the 9×5 size one player had picked.
  - The idle player got two strikes, then was removed.
  - The second player left through the dialog and the third won: "Unranked · 1st · 30 pts +30".
