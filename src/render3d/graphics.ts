/**
 * The player's graphics settings: a preset (Auto, Low … Ultra) or a custom
 * mix of the individual controls, plus the frame-rate cap and the FPS meter.
 *
 * Stored on the device under its own key, and broadcast to every live
 * renderer when it changes, so a setting takes effect on the board you are
 * looking at — not on the next match.
 */
import {
  PRESETS,
  TIER_ORDER,
  initialTier,
  type GraphicsDetail,
  type OrbDetail,
  type ParticleLevel,
  type QualityTier,
  type ShadowLevel,
} from './quality.ts';

export type GraphicsPreset = 'auto' | QualityTier | 'custom';
/** 0 = no cap: draw at whatever rate the screen refreshes (90/120Hz panels). */
export type FpsCap = 30 | 60 | 0;

export interface GraphicsSettings {
  preset: GraphicsPreset;
  /** The individual controls, used when `preset` is 'custom'. */
  custom: GraphicsDetail;
  fps: FpsCap;
  showFps: boolean;
  /** The tier Auto settled on for this device, once measured. */
  autoTier: QualityTier | null;
}

const KEY = 'fissile.graphics.v1';

export const DEFAULT_GRAPHICS: GraphicsSettings = {
  preset: 'auto',
  custom: { ...PRESETS.high },
  fps: 60,
  showFps: false,
  autoTier: null,
};

const RESOLUTIONS = [0.5, 0.75, 1];
const SHADOWS: ShadowLevel[] = ['off', 'soft', 'sharp'];
const PARTICLES: ParticleLevel[] = ['low', 'medium', 'high'];
const ORBS: OrbDetail[] = ['standard', 'high', 'ultra'];
const PRESET_KEYS: GraphicsPreset[] = ['auto', ...TIER_ORDER, 'custom'];

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Validates a stored record field by field. Anything unrecognised falls
 *  back to the default, so an older or hand-edited record never breaks the
 *  renderer. */
export function sanitizeGraphics(raw: unknown): GraphicsSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const c = (r.custom && typeof r.custom === 'object' ? r.custom : {}) as Record<string, unknown>;
  const d = DEFAULT_GRAPHICS.custom;
  const res = Number(c.resolution);
  return {
    preset: pick(r.preset, PRESET_KEYS, DEFAULT_GRAPHICS.preset),
    custom: {
      resolution: RESOLUTIONS.includes(res) ? res : d.resolution,
      antialias: typeof c.antialias === 'boolean' ? c.antialias : d.antialias,
      shadows: pick(c.shadows, SHADOWS, d.shadows),
      glow: typeof c.glow === 'boolean' ? c.glow : d.glow,
      particles: pick(c.particles, PARTICLES, d.particles),
      orbDetail: pick(c.orbDetail, ORBS, d.orbDetail),
    },
    fps: pick(Number(r.fps) as FpsCap, [30, 60, 0] as const, DEFAULT_GRAPHICS.fps),
    showFps: r.showFps === true,
    autoTier: r.autoTier === null ? null : pick(r.autoTier, TIER_ORDER, null as unknown as QualityTier) ?? null,
  };
}

/** The detail actually drawn for these settings. */
export function resolveDetail(s: GraphicsSettings, detected: QualityTier = initialTier()): GraphicsDetail {
  if (s.preset === 'custom') return { ...s.custom };
  if (s.preset === 'auto') return { ...PRESETS[s.autoTier ?? detected] };
  return { ...PRESETS[s.preset] };
}

// ---------- device-local store ----------

let cached: GraphicsSettings | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function getGraphics(): GraphicsSettings {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    raw = JSON.parse(storage()?.getItem(KEY) ?? 'null');
  } catch {
    raw = null;
  }
  cached = sanitizeGraphics(raw);
  return cached;
}

export function setGraphics(patch: Partial<GraphicsSettings>) {
  const next = sanitizeGraphics({ ...getGraphics(), ...patch });
  cached = next;
  try {
    storage()?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — the setting still applies for this session */
  }
  for (const fn of listeners) fn();
}

/** Subscribes to changes; returns the unsubscribe. */
export function onGraphicsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The tier Auto is using on this device right now. */
export function currentAutoTier(): QualityTier {
  return getGraphics().autoTier ?? initialTier();
}

/** What the board is being drawn with right now. */
export function currentDetail(): GraphicsDetail {
  return resolveDetail(getGraphics());
}
