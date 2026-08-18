// Emoji "mood" progression based on how many orbs remain before a cell explodes.
// remaining = criticalMass - orbs. 1 = the next orb placed here explodes it.
export const EMOJI_STAGES = ['🙂', '😬', '🤯'];

export function stageForRemaining(remaining: number): number {
  if (remaining <= 1) return 2; // about to blow
  if (remaining === 2) return 1; // nervous
  return 0; // calm
}

export const EXPLOSION_EMOJI = '💥';
