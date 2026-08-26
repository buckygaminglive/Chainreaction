/**
 * The dimensional FISSILE mark, as vector.
 *
 * Split out of `make-icon-3d.mjs` so that every consumer — the store icon, the
 * PWA set, the Android adaptive layers — draws the mark from one definition
 * instead of from a copy. Two implementations of one mark is two marks, and
 * they drift.
 *
 * Shading is built as *overlays on the flat brand colour* rather than as one
 * big gradient replacing it. Replacing it drained the mark: a highlight
 * spanning the whole sphere leaves almost no #3ad9ff on screen, and the accent
 * is the half of this mark people actually recognise.
 */
// Straight from brand-kit.mjs / favicon.svg. The mark has one palette.
const INK = '#0b0e13';
const EDGE = '#232b36';
const ACCENT = '#3ad9ff';
const CORE_HOT = '#e8fbff';
const CORE_MID = '#6ee6ff';
const CORE_COLD = '#12a8d4';
const DEEP = '#032330'; // the colour the accent falls into in shadow

// The 64-unit box the mark has always been drawn in.
const BOX = 64;
const C = 32;
const CORE_R = 10;
const NODE_R = 3.4;
const NODE_D = 20; // node centre distance from the core
const RING_R = 19;
const TRACE_IN = 9.4;
const TRACE_OUT = 16.6;

/** The four neighbours a critical cell fires into. */
const DIRS = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

const n = (v) => Number(v.toFixed(3));

function defs(p) {
  const traces = DIRS.map((d, i) => {
    const x1 = n(C + d.x * TRACE_IN);
    const y1 = n(C + d.y * TRACE_IN);
    const x2 = n(C + d.x * TRACE_OUT);
    const y2 = n(C + d.y * TRACE_OUT);
    // Brightest where it leaves the core and falling off outward, so the
    // energy reads as travelling rather than as a static spoke.
    return `<linearGradient id="${p}-trace${i}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
      <stop offset="0" stop-color="${CORE_MID}" stop-opacity="0.95"/>
      <stop offset="0.35" stop-color="${ACCENT}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0.45"/>
    </linearGradient>`;
  }).join('\n    ');

  return `<defs>
    <!-- Base colour of the sphere: the favicon's own gradient, untouched. -->
    <radialGradient id="${p}-core" cx="38%" cy="32%" r="70%">
      <stop offset="0" stop-color="${CORE_HOT}"/>
      <stop offset="0.40" stop-color="${CORE_MID}"/>
      <stop offset="1" stop-color="${CORE_COLD}"/>
    </radialGradient>

    <!-- Directional shading. Centred up-left, so the far side of the sphere
         sits at the high offsets and goes dark: form shadow, not a vignette. -->
    <radialGradient id="${p}-shade" cx="30%" cy="25%" r="98%">
      <stop offset="0.42" stop-color="${DEEP}" stop-opacity="0"/>
      <stop offset="0.78" stop-color="${DEEP}" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#01141d" stop-opacity="0.72"/>
    </radialGradient>

    <!-- Fresnel: a bright lip right at the edge, which is what actually sells
         a sphere. Transparent through the middle so it only touches the rim. -->
    <radialGradient id="${p}-rim" cx="50%" cy="50%" r="50%">
      <stop offset="0.72" stop-color="#8df2ff" stop-opacity="0"/>
      <stop offset="0.94" stop-color="#b9f7ff" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#b9f7ff" stop-opacity="0.10"/>
    </radialGradient>

    <radialGradient id="${p}-spec" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.98"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>

    <!-- Nodes keep the flat accent as their body and are shaded on top, for
         the same reason as the core. -->
    <radialGradient id="${p}-nodeShade" cx="32%" cy="26%" r="96%">
      <stop offset="0.30" stop-color="${DEEP}" stop-opacity="0"/>
      <stop offset="0.72" stop-color="${DEEP}" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#01141d" stop-opacity="0.78"/>
    </radialGradient>

    <radialGradient id="${p}-shadow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#000000" stop-opacity="0.6"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>

    <!-- The orbit ring, lit where the key light grazes it. -->
    <linearGradient id="${p}-ring" gradientUnits="userSpaceOnUse" x1="${C - RING_R}" y1="${C - RING_R}" x2="${C + RING_R}" y2="${C + RING_R}">
      <stop offset="0" stop-color="#8df2ff" stop-opacity="0.72"/>
      <stop offset="0.5" stop-color="${ACCENT}" stop-opacity="0.26"/>
      <stop offset="1" stop-color="#8df2ff" stop-opacity="0.6"/>
    </linearGradient>

    <!-- A plate lit from above rather than filled flat. -->
    <linearGradient id="${p}-plate" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${BOX}">
      <stop offset="0" stop-color="#141a23"/>
      <stop offset="0.55" stop-color="${INK}"/>
      <stop offset="1" stop-color="#04060a"/>
    </linearGradient>

    <radialGradient id="${p}-vignette" cx="50%" cy="45%" r="64%">
      <stop offset="0.5" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.5"/>
    </radialGradient>

    ${traces}
  </defs>`;
}

function marks(p, { shadow }) {
  const traces = DIRS.map((d, i) => {
    const x1 = n(C + d.x * TRACE_IN);
    const y1 = n(C + d.y * TRACE_IN);
    const x2 = n(C + d.x * TRACE_OUT);
    const y2 = n(C + d.y * TRACE_OUT);
    return `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="url(#${p}-trace${i})" stroke-width="2.1" stroke-linecap="round" fill="none"/>`;
  }).join('\n  ');

  const nodes = DIRS.map((d) => {
    const cx = n(C + d.x * NODE_D);
    const cy = n(C + d.y * NODE_D);
    const hx = n(cx - NODE_R * 0.32);
    const hy = n(cy - NODE_R * 0.38);
    return `<g>
    <circle cx="${cx}" cy="${cy}" r="${NODE_R}" fill="${ACCENT}"/>
    <circle cx="${cx}" cy="${cy}" r="${NODE_R}" fill="url(#${p}-nodeShade)"/>
    <ellipse cx="${hx}" cy="${hy}" rx="${n(NODE_R * 0.40)}" ry="${n(NODE_R * 0.27)}" fill="url(#${p}-spec)" transform="rotate(-32 ${hx} ${hy})"/>
  </g>`;
  }).join('\n  ');

  const contact = shadow
    ? `<ellipse cx="${C}" cy="${n(C + CORE_R + 3.2)}" rx="${n(CORE_R * 1.02)}" ry="${n(CORE_R * 0.24)}" fill="url(#${p}-shadow)"/>`
    : '';

  const hx = n(C - CORE_R * 0.36);
  const hy = n(C - CORE_R * 0.42);

  return `${contact}
  <circle cx="${C}" cy="${C}" r="${RING_R}" fill="none" stroke="url(#${p}-ring)" stroke-width="1"/>
  ${traces}
  ${nodes}
  <circle cx="${C}" cy="${C}" r="${CORE_R}" fill="url(#${p}-core)"/>
  <circle cx="${C}" cy="${C}" r="${CORE_R}" fill="url(#${p}-shade)"/>
  <circle cx="${C}" cy="${C}" r="${CORE_R}" fill="url(#${p}-rim)"/>
  <ellipse cx="${hx}" cy="${hy}" rx="${n(CORE_R * 0.32)}" ry="${n(CORE_R * 0.21)}" fill="url(#${p}-spec)" transform="rotate(-32 ${hx} ${hy})"/>`;
}

/**
 * `variant` is one of 'plate' | 'flat' | 'bare'.
 *
 * `markScale` shrinks the mark about the centre without touching the ground,
 * which is what maskable and adaptive icons need: the background must still go
 * edge to edge, but the mark itself has to survive an aggressive crop. See
 * MARK_EXTENT for how the numbers are worked out.
 */
function icon(variant, size, { markScale = 1 } = {}) {
  const p = variant;
  let ground = '';
  if (variant === 'plate') {
    ground = `<rect width="${BOX}" height="${BOX}" rx="14" fill="url(#${p}-plate)"/>
  <rect width="${BOX}" height="${BOX}" rx="14" fill="url(#${p}-vignette)"/>
  <rect x="4.5" y="4.5" width="55" height="55" rx="11" fill="none" stroke="${EDGE}" stroke-width="1"/>`;
  } else if (variant === 'flat') {
    // Square to the edge: Play masks the corners itself, so rounding here
    // would land as a rounded rectangle inside a rounded rectangle.
    ground = `<rect width="${BOX}" height="${BOX}" fill="url(#${p}-plate)"/>
  <rect width="${BOX}" height="${BOX}" fill="url(#${p}-vignette)"/>`;
  }

  // markScale 0 means ground only — an adaptive icon's background layer, which
  // carries no mark at all. Handled here rather than as scale(0), which
  // collapses to a degenerate transform renderers treat inconsistently.
  const art = markScale === 0 ? '' : marks(p, { shadow: variant !== 'bare' });
  const scaled =
    markScale === 1 || markScale === 0
      ? art
      : `<g transform="translate(${n(C * (1 - markScale))} ${n(C * (1 - markScale))}) scale(${n(markScale)})">
  ${art}
  </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}" width="${size}" height="${size}">
  <!-- FISSILE mark, dimensionalised. Variant: ${variant}. Generated from scripts/icon-3d.mjs -->
  ${defs(p)}
  ${ground}
  ${scaled}
</svg>`;
}

/**
 * How much of the box the mark actually covers, as a fraction of the width.
 *
 * The outermost thing in the mark is a node: its centre sits NODE_D from the
 * middle and it has radius NODE_R, so the mark spans 2*(NODE_D + NODE_R). At
 * the stock geometry that is 46.8 of 64, or about 73% — already wider than an
 * adaptive icon's guaranteed-visible area, which is why maskable variants need
 * scaling rather than just cropping.
 */
const MARK_EXTENT = (2 * (NODE_D + NODE_R)) / BOX;

/**
 * The mark scale that keeps the whole mark inside a guaranteed-visible area of
 * `fraction` of the icon's width.
 *
 * Android adaptive icons guarantee the central 72 of 108dp (66.7%); the W3C
 * maskable safe zone is a circle of 80% diameter. Passing the tighter of the
 * two satisfies both at once.
 */
const scaleForSafeZone = (fraction) => Number((fraction / MARK_EXTENT).toFixed(4));


export { BOX, C, ACCENT, INK, icon, MARK_EXTENT, scaleForSafeZone };
