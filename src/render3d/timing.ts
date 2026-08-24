/** How long an exploding cell winds up (spinning, accelerating) before it
 *  actually blasts. Kept short — this is a quick snap, not a deliberate
 *  charge-up hold, so a chain reaction reads as one continuous cascade rather
 *  than a series of "wait...blast, wait...blast" beats.
 *
 *  It lives in its own module, away from ThreeRenderer, so that callers who
 *  only need to sync sound and haptics to the real blast moment can import it
 *  without dragging the whole Three.js bundle onto the initial page load. */
export const EXPLOSION_SPIN_UP_MS = 70;
