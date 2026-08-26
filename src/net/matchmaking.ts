/**
 * Matchmaking policy: how far apart two ratings may be to be paired.
 *
 * Lives here rather than in the Durable Object so it can be tested without a
 * Workers runtime — the object itself imports `cloudflare:workers`, which is
 * not loadable outside one. The relay is the only caller; this is shared the
 * same way the game engine is.
 */

/** Where the rating scale starts, and what an unranked player is matched as. */
export const DEFAULT_RATING = 1000;

/** The band a player is offered the moment they press the button. */
export const BASE_BAND = 150;

/** How much wider the band gets for every second spent waiting. */
export const BAND_GROWTH_PER_SEC = 25;

/**
 * How far apart two ratings may be, given how long the waiting player has
 * already been queued.
 *
 * A fixed band is the wrong shape for a game this size: narrow enough to mean
 * something and it never matches anyone, wide enough to always match and it
 * means nothing. So it starts tight and opens up — which costs a close match
 * nothing, because a well-matched opponent nearby is taken immediately, and
 * costs a lonely player only time.
 *
 * The growth rate is set by a constraint from elsewhere in the product: the
 * client offers a practice bot after twelve seconds. The band therefore has to
 * be generous well before then, or the queue would be handing out bots while a
 * real opponent stood two hundred points away. At 12s it is ±450; by 60s it is
 * ±1650, which on this ladder is everybody.
 */
export function ratingBand(waitedMs: number): number {
  // A queue entry stamped slightly in the future — clocks move — must not
  // produce a band narrower than the base, which would exclude everyone.
  const seconds = Math.max(0, Math.floor(waitedMs / 1000));
  return BASE_BAND + seconds * BAND_GROWTH_PER_SEC;
}
