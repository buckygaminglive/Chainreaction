# FISSILE: Chain Reactor 1.1.7 (version code 12)

File: `FISSILE-1.1.7-code12.aab` (signed release bundle, 16.4 MB)
Play Console "What's new" text: `play-store-whats-new.txt` (490 of 500 characters)

## New

- **Nova, the voiced guide.** A computer character with her own portrait and
  animated face (blinks, expressions, a mouth that follows her voice).
  - 396 voiced lines: greetings per difficulty, reactions to chains and
    captures, taunts, comebacks, near-wins, tips, and win/lose lines.
    Lines are drawn without repeats.
  - She comments on vs-computer and Survival matches, and her line appears on
    the result card.
  - Settings: Chatter (Lots / Some / Off) and Voice (On / Off). Music dips while
    she speaks.
- **Interactive lesson.** A 5-step, about one-minute tutorial on a real board,
  with hints and corrections for wrong taps. It is offered on first launch, and
  you can start it again from Home ("Learn with Nova") or Profile.
- **Typed chat in online matches.** The 💬 panel now has two tabs, **Quick**
  (the preset phrases) and **Type** (your own message, up to 80 characters).
  - Typed chat is off by default. A player turns it on from the Type tab or in
    Settings › Online chat, and can turn it off at any time during a match.
    While it's off, other players' typed messages are hidden from them too.
  - Every message is filtered on the relay before anyone sees it, and again in
    the app:
    - English and Hindi/Hinglish swear words are masked, including spellings
      like "sh1t", "fuuuck" and "f u c k".
    - Links, emails, phone numbers and social handles are removed.
  - Tap someone's message to **Mute** them for the rest of the room, or
    **Report** them. A report also mutes that player and is written to the
    relay's log.
  - Typed and quick messages share one 2.5-second cooldown.
  - **Needs the updated relay deployed** (`npx wrangler deploy`). Until then,
    typed messages are silently dropped and quick chat still works.
- **Settings during a match.** A gear button in the game's top bar opens
  Settings over the board. Volume, music, graphics quality and Nova changes
  apply right away, without leaving the match.
- **Full-screen app.** The status and navigation bars are hidden. Swipe from
  the edge to show them briefly.
- **New art.**
  - 12 crew avatars. Older avatar choices map onto them automatically.
  - Six-tier rank emblems.
  - Illustrated mode cards.
  - A redesigned Ranks page with a podium.
  - A friend-code card with Copy and Share.
- **Share card.** Wins and daily puzzles produce a poster-style image to share
  or save.
- **Random starting names.** New players get names like "NeonOtter" or
  "TurboQuark42" instead of "Player949". The name is kept until they change it.

## Changed

- **Reactive (emoji) orb style removed.** All games use the standard orbs. A
  room started from an older app version also shows standard orbs.
- **CPU difficulty has moods** (Chill, Focused, Ruthless, Unhinged). Your
  opponent is now named Nova.
- **"Play again" against the CPU** keeps the board size and mode.

## Technical

- Added the `@capacitor/filesystem` plugin, which saves the share image so it
  can be shared.
- `android/build.gradle` lets plugins that require JDK 21 build with Android
  Studio's bundled JDK. The output is still Java 21 bytecode.
- Relay: new `say` and `report` messages (server/GameRoom.ts) and a shared
  filter (src/net/chatFilter.ts). Older apps ignore `say`, so deploying the
  relay before players update is safe.
