/**
 * Render quality: the four presets, what each one costs, and the automatic
 * tier chosen by measurement.
 *
 * There is no reliable way to ask a browser how fast its GPU is, so Auto
 * starts from a guess and then watches real frame times, stepping down only
 * when they are bad. Stepping is one-way: a renderer that climbs back up the
 * moment things improve oscillates between tiers, and a quality change is far
 * more noticeable than the quality itself.
 *
 * The presets are ordered so that crispness goes last. Drawing below the
 * screen's own pixel density is what makes a board look blurred, and turning
 * multisampling off is what gives orbs jagged rims — both are far more
 * visible than a missing shadow or a dimmer glow. So shadows, glow, particle
 * counts and the costly clearcoat on the orbs are all given up before
 * resolution or anti-aliasing are touched; only the bottom tier draws below
 * native resolution.
 */

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';
export type ShadowLevel = 'off' | 'soft' | 'sharp';
export type ParticleLevel = 'low' | 'medium' | 'high';
/** standard = plain lit sphere; high = clearcoat; ultra = clearcoat on a
 *  denser sphere with full texture filtering. */
export type OrbDetail = 'standard' | 'high' | 'ultra';

export interface GraphicsDetail {
  /** Fraction of the screen's own pixel density to draw at. 1 draws every
   *  physical pixel; less is cheaper and softer. */
  resolution: number;
  /** Multisampled edges. Fixed when a WebGL context is created, so changing
   *  it rebuilds the renderer. */
  antialias: boolean;
  shadows: ShadowLevel;
  /** The light spill under orbs and the capture flares. */
  glow: boolean;
  particles: ParticleLevel;
  orbDetail: OrbDetail;
}

export const PRESETS: Record<QualityTier, GraphicsDetail> = {
  ultra: { resolution: 1, antialias: true, shadows: 'sharp', glow: true, particles: 'high', orbDetail: 'ultra' },
  high: { resolution: 1, antialias: true, shadows: 'soft', glow: true, particles: 'high', orbDetail: 'high' },
  // Still native resolution with smooth edges: this is where most phones
  // that cannot hold High should land, and it should still look sharp.
  medium: { resolution: 1, antialias: true, shadows: 'off', glow: true, particles: 'medium', orbDetail: 'standard' },
  // A shadow pass is a second render of the whole scene; the bottom tier
  // drops it entirely, along with everything else optional.
  low: { resolution: 0.75, antialias: false, shadows: 'off', glow: false, particles: 'low', orbDetail: 'standard' },
};

export const TIER_ORDER: QualityTier[] = ['ultra', 'high', 'medium', 'low'];

export const SHADOW_MAP_SIZE: Record<ShadowLevel, number> = { off: 0, soft: 1024, sharp: 2048 };
export const PARTICLE_DENSITY: Record<ParticleLevel, number> = { low: 0.45, medium: 0.75, high: 1 };
/** Sphere width/height segments per orb detail level. */
export const ORB_SEGMENTS: Record<OrbDetail, [number, number]> = {
  standard: [22, 16],
  high: [32, 22],
  ultra: [48, 32],
};

/** Past 3× nobody can see more detail and the cost keeps climbing with the
 *  square of it. */
export const MAX_PIXEL_RATIO = 3;

/** The drawing-buffer pixel ratio for a detail level on a given screen. */
export function pixelRatioFor(detail: GraphicsDetail, devicePixelRatio: number): number {
  const native = Math.min(MAX_PIXEL_RATIO, devicePixelRatio > 0 ? devicePixelRatio : 1);
  return Math.max(0.5, native * detail.resolution);
}

/** The next tier down, or null at the bottom. */
export function nextTierDown(tier: QualityTier): QualityTier | null {
  return TIER_ORDER[TIER_ORDER.indexOf(tier) + 1] ?? null;
}

/**
 * Where Auto starts before any frames have been measured.
 *
 * Optimistic now, where it used to start every phone in a reduced tier. A
 * blurred, jagged board is a worse first impression than a few seconds of a
 * sharp one that then steps down — and the tier it settles on is remembered,
 * so a phone that cannot hold High only finds that out once.
 */
export function initialTier(): QualityTier {
  // Reached through `globalThis` rather than the DOM globals directly: this
  // module is imported by a Node test, which has no DOM library.
  const env = globalThis as unknown as {
    matchMedia?: (query: string) => { matches: boolean };
    navigator?: { deviceMemory?: number; hardwareConcurrency?: number };
  };
  if (!env.navigator) return 'high';

  const coarse = env.matchMedia?.('(pointer: coarse)').matches ?? false;
  const memory = env.navigator.deviceMemory;
  const cores = env.navigator.hardwareConcurrency ?? 8;

  // Both of these indicate a genuinely small device, not merely a touch one.
  if (memory !== undefined && memory <= 2) return 'low';
  if ((memory !== undefined && memory <= 3) || (cores <= 4 && coarse)) return 'medium';

  return coarse ? 'high' : 'ultra';
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
   * renderer should step down a tier. `badFrameMs` is the average frame time
   * that counts as struggling — raised when a frame-rate cap makes slower
   * frames intentional.
   */
  sample(now: number, badFrameMs = FrameWatcher.BAD_FRAME_MS): boolean {
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

    return mean > badFrameMs;
  }

  /** Forgets what it has seen. Called after a step-down so the next verdict is
   *  reached on how the *new* settings actually perform. */
  reset() {
    this.times.length = 0;
    this.last = 0;
    this.windowsSeen = 0;
  }
}
