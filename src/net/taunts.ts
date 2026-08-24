/** A fixed palette rather than free text.
 *
 *  Deliberate: an open chat box in a game played with strangers needs
 *  moderation, reporting and a whole abuse surface behind it. A closed set of
 *  emoji gives the same "wind up your opponent" feeling with none of that, and
 *  needs no localisation either. */
export const TAUNTS = [
  { emoji: '😂', label: 'Laughing' },
  { emoji: '😎', label: 'Too easy' },
  { emoji: '🤯', label: 'Mind blown' },
  { emoji: '😱', label: 'Panic' },
  { emoji: '😭', label: 'Crying' },
  { emoji: '🔥', label: 'On fire' },
  { emoji: '💀', label: 'Finished' },
  { emoji: '👏', label: 'Nice one' },
  { emoji: '🤝', label: 'Good game' },
  { emoji: '⚡', label: 'Too slow' },
  { emoji: '🐌', label: 'Hurry up' },
  { emoji: '🎯', label: 'Called it' },
] as const;

/** Minimum gap between one player's taunts. Enforced on the relay, because a
 *  client-side limit is a suggestion — and taunt spam is the single easiest way
 *  to make a match miserable. */
export const TAUNT_COOLDOWN_MS = 1500;

export function isValidTaunt(index: unknown): index is number {
  return Number.isInteger(index) && (index as number) >= 0 && (index as number) < TAUNTS.length;
}
