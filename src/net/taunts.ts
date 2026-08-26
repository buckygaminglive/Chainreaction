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

/**
 * Quick chat: short preset phrases, sent as an index rather than as text.
 *
 * The same reasoning as the emoji palette above, and worth restating because
 * it is the kind of decision that gets quietly reversed later. Free-text chat
 * between strangers obliges the store listing to declare user-generated
 * content, and obliges the app to ship per-message reporting, per-player
 * blocking and a stated moderation policy before it can pass review. A closed
 * set of phrases gives players a conversation without any of that, needs no
 * profanity filter, and cannot be used to abuse anyone — which matters more
 * here than usual, because the game carries an all-ages rating.
 *
 * Grouped so the picker can be scanned rather than read. Kept short: a bubble
 * that covers the board is worse than no bubble.
 */
export interface ChatGroup {
  label: string;
  phrases: string[];
}

export const CHAT_GROUPS: ChatGroup[] = [
  { label: 'Hello', phrases: ['Hi!', 'Good luck!', 'Ready?', 'Nice to meet you'] },
  { label: 'Praise', phrases: ['Nice chain!', 'Well played', 'How did you do that?', 'Great move'] },
  { label: 'Banter', phrases: ['Watch this', 'Not so fast', 'Too close!', 'I saw that coming'] },
  { label: 'Match', phrases: ['Your turn', 'Take your time', 'Sorry!', 'Oops'] },
  { label: 'End', phrases: ['Good game!', 'Rematch?', 'Thanks for the game', 'Well deserved'] },
];

/** Flattened, because the wire format is an index into this one list. Order is
 *  therefore part of the protocol: append new phrases, never reorder existing
 *  ones, or an old client renders a different sentence than was sent. */
export const CHAT_PHRASES: string[] = CHAT_GROUPS.flatMap((g) => g.phrases);

/** Longer than the emoji cooldown. Emoji are punctuation; sentences read as
 *  someone talking at you, and land harder when repeated. */
export const CHAT_COOLDOWN_MS = 2500;

export function isValidChat(index: unknown): index is number {
  return Number.isInteger(index) && (index as number) >= 0 && (index as number) < CHAT_PHRASES.length;
}
