/**
 * Render quality tiers, chosen by measurement rather than by guesswork.
 *
 * There is no reliable way to ask a browser how fast its GPU is. Core count
 * says nothing — the phone that prompted this work reports eight cores and
 * still cannot hold thirty frames with soft shadows on. `deviceMemory` is
 * coarse and often absent, and user-agent sniffing is a list that is wrong the
 * day after it is written.
 *
 * So the starting tier is a conservative guess from the little that *is*
 * meaningful, and the real decision is made by watching actual frame times and
 * stepping down when they are bad. Stepping is one-way on purpose: a renderer
 * that climbs back up the moment things improve oscillates between tiers, and
 * a quality change is far more noticeable than the quality itself.
 */

export type QualityTier = 'high' | 'medium' | 'low';

export interface QualitySettings {
  /** Upper bound on the device pixel ratio. The single biggest lever there
   *  is: cost scales with the square of it. */
  maxPixelRatio: number;
  /** Multisampling. Fixed at context creation, so it can never be part of the
   *  runtime step-down — which is exactly why mobile does not start with it. */
  antialias: boolean;
  shadows: boolean;
  /** Ignored when `shadows` is false. */
  shadowMapSize: number;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  high: { maxPixelRatio: 2, antialias: true, shadows: true, shadowMapSize: 1024 },
  medium: { maxPixelRatio: 1.5, antialias: false, shadows: true, shadowMapSize: 512 },
  // Shadows off entirely: a shadow pass is a second render of the whole scene,
  // and no amount of shrinking the map changes that.
  low: { maxPixelRatio: 1, antialias: false, shadows: false, shadowMapSize: 256 },
};

const ORDER: QualityTier[] = ['high', 'medium', 'low'];

/** The next tier down, or null at the bottom. */
export function nextTierDown(tier: QualityTier): QualityTier | null {
  return ORDER[ORDER.indexOf(tier) + 1] ?? null;
}

/**
 * Where to start before any frames have been measured.
 *
 * Deliberately pessimistic on touch devices. Starting high and stepping down
 * means the first seconds of the first match — the ones that decide whether
 * the game feels good — are the worst ones, which is precisely backwards.
 */
export function initialTier(): QualityTier {
  // Reached through `globalThis` rather than the DOM globals directly: this
  // module is imported by a Node test, which has no DOM library, and pulling
  // one in just to typecheck a browser-only branch would be the wrong fix.
  const env = globalThis as unknown as {
    matchMedia?: (query: string) => { matches: boolean };
    navigator?: { deviceMemory?: number; hardwareConcurrency?: number };
  };
  if (!env.navigator) return 'high';

  const coarse = env.matchMedia?.('(pointer: coarse)').matches ?? false;
  const memory = env.navigator.deviceMemory;
  const cores = env.navigator.hardwareConcurrency ?? 8;

  // These two are worth believing when present, because both indicate a
  // genuinely small device rather than merely a touch screen.
  if (memory !== undefined && memory <= 3) return 'low';
  if (cores <= 4 && coarse) return 'low';

  return coarse ? 'medium' : 'high';
}

/**
 * Watches frame times and says when the renderer should drop a tier.
 *
 * Samples are taken over a window rather than per frame: one slow frame is a
 * garbage collection or a texture upload, not a verdict on the device. A whole
 * window of slow frames is.
 *
 * The first window is skipped entirely — startup does shader compilation and
 * texture decoding, and judging the device on that would demote everybody.
 */
export class FrameWatcher {
  private times: number[] = [];
  private last = 0;
  private windowsSeen = 0;

  /** Frames per sampling window. About a second and a half at 60fps, and
   *  proportionally longer when things are slow, which is the right way round:
   *  a struggling device gets more evidence gathered before it is judged. */
  private static readonly WINDOW = 90;
  /** Average milliseconds per frame above which a window counts as bad.
   *  22ms is roughly 45fps — comfortably below smooth, comfortably above the
   *  jitter of a healthy 60. */
  private static readonly BAD_FRAME_MS = 22;

  /**
   * Call once per rendered frame. Returns true when the evidence says the
   * renderer should step down a tier.
   */
  sample(now: number): boolean {
    if (this.last === 0) {
      this.last = now;
      return false;
    }
    const delta = now - this.last;
    this.last = now;

    // A tab that was backgrounded, or a breakpoint, produces one enormous gap
    // that would otherwise poison the whole window.
    if (delta > 500) return false;

    this.times.push(delta);
    if (this.times.length < FrameWatcher.WINDOW) return false;

    const mean = this.times.reduce((a, b) => a + b, 0) / this.times.length;
    this.times.length = 0;
    this.windowsSeen++;

    // Skip the first window: shader compilation and texture uploads happen
    // there, and they are not what the device will be doing for the rest of
    // the match.
    if (this.windowsSeen === 1) return false;

    return mean > FrameWatcher.BAD_FRAME_MS;
  }

  /** Forgets what it has seen. Called after a step-down so the next verdict is
   *  reached on how the *new* settings actually perform. */
  reset() {
    this.times.length = 0;
    this.last = 0;
  }
}
