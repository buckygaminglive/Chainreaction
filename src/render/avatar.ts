/**
 * Player avatars, drawn rather than uploaded.
 *
 * A player picks one of a fixed set and the relay stores the key — `"c2"`,
 * four bytes — instead of an image. That is a deliberate trade, not a
 * shortcut: accepting uploaded pictures would mean object storage, resizing, a
 * moderation path, a reporting flow, and a Play listing that has to declare
 * user-generated content and collected photos. None of that buys a
 * chain-reaction game anything a generated emblem does not.
 *
 * The vocabulary is the mark's own: a charged core, a ring, and neighbours
 * arranged around it. Six hues × four arrangements = 24, which is enough for a
 * lobby to look varied without becoming a different design system.
 *
 * Every avatar is a pure function of its key, so the same key draws the same
 * emblem on every device and nothing has to be fetched.
 */

export interface AvatarHue {
  key: string;
  name: string;
  /** Core colour, and the ring/neighbour colour derived from it. */
  base: string;
  bright: string;
  deep: string;
}

/** Cyan first: it is the brand accent, and the default new players land on. */
export const AVATAR_HUES: AvatarHue[] = [
  { key: 'c', name: 'Cyan', base: '#3ad9ff', bright: '#c9f6ff', deep: '#0d5f7d' },
  { key: 'r', name: 'Crimson', base: '#ff3355', bright: '#ffc2cc', deep: '#7d1226' },
  { key: 'a', name: 'Amber', base: '#ffb43a', bright: '#ffe6bd', deep: '#7d5312' },
  { key: 'v', name: 'Violet', base: '#a06bff', bright: '#ddccff', deep: '#452a7d' },
  { key: 'g', name: 'Jade', base: '#3ce6a4', bright: '#c6ffe8', deep: '#0f6b48' },
  { key: 'm', name: 'Magenta', base: '#ff5ad0', bright: '#ffcdf1', deep: '#7d1f63' },
];

export interface AvatarForm {
  key: string;
  name: string;
  /** How many neighbours sit around the core. */
  nodes: number;
  /** Rotation of the neighbour ring, in degrees. */
  offset: number;
  /** Whether the orbit ring is drawn. */
  ring: boolean;
}

export const AVATAR_FORMS: AvatarForm[] = [
  { key: '1', name: 'Cross', nodes: 4, offset: 0, ring: true },
  { key: '2', name: 'Triad', nodes: 3, offset: -90, ring: false },
  { key: '3', name: 'Hex', nodes: 6, offset: 0, ring: true },
  { key: '4', name: 'Star', nodes: 8, offset: 22.5, ring: false },
];

/** Every legal key, in the order the picker shows them. */
export const AVATAR_KEYS: string[] = AVATAR_HUES.flatMap((h) => AVATAR_FORMS.map((f) => h.key + f.key));

export const DEFAULT_AVATAR = 'c1';

/** Whether `key` names an avatar this build knows how to draw. */
export function isAvatarKey(key: unknown): key is string {
  return typeof key === 'string' && AVATAR_KEYS.includes(key);
}

/**
 * A stable avatar for a player who has never chosen one.
 *
 * Derived from the id so a returning player keeps the same emblem, and so a
 * lobby of players who all skipped the picker still looks like several people
 * rather than one person six times.
 */
export function defaultAvatarFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_KEYS[hash % AVATAR_KEYS.length];
}

function parse(key: string): { hue: AvatarHue; form: AvatarForm } {
  const safe = isAvatarKey(key) ? key : DEFAULT_AVATAR;
  return {
    hue: AVATAR_HUES.find((h) => h.key === safe[0]) ?? AVATAR_HUES[0],
    form: AVATAR_FORMS.find((f) => f.key === safe[1]) ?? AVATAR_FORMS[0],
  };
}

/** The hue an avatar key names, for tinting the frame around it. */
export function avatarHue(key: string): AvatarHue {
  return parse(key).hue;
}

/** A readable name, for the picker's accessible labels. */
export function avatarName(key: string): string {
  const { hue, form } = parse(key);
  return `${hue.name} ${form.name}`;
}

/** Unique gradient ids per rendered instance: two avatars in one document
 *  would otherwise share a definition and the second would take the first's
 *  colours. */
let instance = 0;

/**
 * The avatar as standalone SVG markup, sized to `size` px.
 *
 * Drawn in the same 64-unit box as the brand mark so the geometry matches the
 * icon and the rank badges without anything having to be rescaled by eye.
 */
export function avatarSvg(key: string, size = 64): string {
  const { hue, form } = parse(key);
  const uid = `av${++instance}`;

  const nodes: string[] = [];
  for (let i = 0; i < form.nodes; i++) {
    const angle = ((form.offset + (360 / form.nodes) * i) * Math.PI) / 180;
    const nx = 32 + Math.cos(angle) * 20;
    const ny = 32 + Math.sin(angle) * 20;
    const r = form.nodes > 6 ? 2.4 : 3.2;
    nodes.push(
      `<line x1="${(32 + Math.cos(angle) * 10.5).toFixed(2)}" y1="${(32 + Math.sin(angle) * 10.5).toFixed(2)}" ` +
        `x2="${(32 + Math.cos(angle) * 16.6).toFixed(2)}" y2="${(32 + Math.sin(angle) * 16.6).toFixed(2)}" ` +
        `stroke="${hue.base}" stroke-width="1.7" stroke-linecap="round" opacity="0.75"/>`,
      `<circle cx="${nx.toFixed(2)}" cy="${ny.toFixed(2)}" r="${r}" fill="${hue.base}"/>`
    );
  }

  return [
    `<svg viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${avatarName(key)} avatar">`,
    '<defs>',
    `<radialGradient id="${uid}-core" cx="36%" cy="30%" r="72%">`,
    `<stop offset="0" stop-color="${hue.bright}"/>`,
    `<stop offset="0.45" stop-color="${hue.base}"/>`,
    `<stop offset="1" stop-color="${hue.deep}"/>`,
    '</radialGradient>',
    `<linearGradient id="${uid}-plate" x1="0" y1="0" x2="0" y2="1">`,
    '<stop offset="0" stop-color="#141a23"/>',
    '<stop offset="1" stop-color="#05070a"/>',
    '</linearGradient>',
    '</defs>',
    `<rect width="64" height="64" rx="16" fill="url(#${uid}-plate)"/>`,
    form.ring ? `<circle cx="32" cy="32" r="19" fill="none" stroke="${hue.base}" stroke-width="1" opacity="0.32"/>` : '',
    nodes.join(''),
    `<circle cx="32" cy="32" r="10" fill="url(#${uid}-core)"/>`,
    // The same upper-left hotspot the icon uses, so an avatar reads as the
    // same material as the mark it sits next to.
    `<ellipse cx="28.6" cy="28.0" rx="3.2" ry="2.1" fill="#ffffff" opacity="0.5" transform="rotate(-32 28.6 28)"/>`,
    '</svg>',
  ].join('');
}
