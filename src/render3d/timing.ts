/** How long an exploding cell winds up (straining, spinning) before it
 *  actually blasts, on the first wave of a cascade. Kept short — a quick snap,
 *  not a charge-up hold — so a chain reads as one continuous cascade rather
 *  than a series of "wait...blast" beats.
 *
 *  Lives in its own module, away from ThreeRenderer, so callers that only need
 *  the timing (sound, haptics) can import it without dragging the whole
 *  Three.js bundle onto the initial page load. */
export const EXPLOSION_SPIN_UP_MS = 70;

/**
 * How much faster wave `wave` (0-based) of a cascade plays than the first.
 *
 * A long chain used to play every wave at the same pace, so a 30-wave cascade
 * was fifteen seconds of the same beat — impressive once, a wait every time
 * after. Accelerating makes a big chain *feel* bigger (it builds, like a drum
 * roll) and keeps the longest ones to a few seconds. The first two waves stay
 * at full length so a small pop still reads clearly.
 */
export function waveSpeed(wave: number): number {
  if (wave <= 1) return 1;
  return Math.min(3.2, 1 + (wave - 1) * 0.16);
}
