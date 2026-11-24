/**
 * Nova's live portrait — the crew drawing, split into layers that can move.
 *
 * Same geometry as her static portrait in art/crew.ts, but the face parts are
 * separate, classed groups so CSS and a little script can animate them:
 *
 *   .nv-bob     the whole character; bobs while she talks
 *   .nv-eyes    normal eyes; blink on a loop
 *   .nv-laugh   closed ^ ^ eyes, for laughing lines
 *   .nv-lids    half-closed lids, for smug lines
 *   .nv-brows   worried brows and a sweat drop, for nervous lines
 *   .nv-smile / .nv-smirk / .nv-o / .nv-open   mouths
 *
 * The root gets `ex-<expression>` and `talking` classes; `--mouth` (0–1) is
 * set every frame from the voice's loudness and opens .nv-open.
 */

export type Expression = 'happy' | 'smug' | 'surprised' | 'laugh' | 'nervous';

const INK = '#0b0e13';
const HAIR = '#2b2456';
const HAIR_LIT = '#4d4296';
const SKIN = '#ffb79e';
const SKIN_SHADE = '#b3806f';
const HEADSET = '#e8edf4';
const CYAN = '#3ad9ff';
const MOUTH = '#3b1222';
const CX = 64;
const CY = 70;
const R = 34;

/** Which face a line's opening tag calls for. */
export function expressionFor(line: string): Expression {
  const tag = /^\s*\[([^\]]+)\]/.exec(line)?.[1]?.toLowerCase() ?? '';
  if (/laugh|giggl/.test(tag)) return 'laugh';
  if (/gasp|surpris|shout|dramatic|impressed/.test(tag)) return 'surprised';
  if (/mischiev|teas|confident|sarcas|smug|whisper/.test(tag)) return 'smug';
  if (/nervous|whin|sigh|cautious|sad/.test(tag)) return 'nervous';
  return 'happy';
}

let instance = 0;

export function novaFaceSvg(size = 64): string {
  const uid = `nv${++instance}`;
  const body = `${uid}b`;
  const eye = (x: number): string =>
    `<ellipse cx="${x}" cy="74" rx="4.6" ry="6.2" fill="${INK}"/><circle cx="${x + 1.7}" cy="71.4" r="1.8" fill="#fff"/>`;
  return [
    `<svg class="nova-face ex-happy" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}" aria-hidden="true">`,
    `<defs><clipPath id="${uid}f"><circle cx="64" cy="64" r="64"/></clipPath><clipPath id="${body}"><circle cx="${CX}" cy="${CY}" r="${R}"/></clipPath></defs>`,
    `<g clip-path="url(#${uid}f)">`,
    `<rect width="128" height="128" fill="#0a2730"/>`,
    `<circle class="nv-ring" cx="64" cy="64" r="52" fill="none" stroke="#135566" stroke-width="1.5"/>`,
    `<ellipse cx="64" cy="112" rx="30" ry="5" fill="#000" opacity="0.35"/>`,
    `<g class="nv-bob">`,
    `<g transform="translate(${CX} ${CY}) scale(1.12) translate(${-CX} ${-CY})">`,
    // Hair behind, then the face.
    `<path d="M27 74Q24 33 64 30Q104 33 101 74V99Q93 105 86 97H42Q35 105 27 99Z" fill="${HAIR}"/>`,
    `<circle cx="${CX}" cy="${CY}" r="${R}" fill="${SKIN_SHADE}"/>`,
    `<circle cx="${CX - 4}" cy="${CY - 5}" r="${R}" fill="${SKIN}" clip-path="url(#${body})"/>`,
    `<ellipse cx="45" cy="83" rx="4.4" ry="2.7" fill="#ff7aa0" opacity="0.5"/><ellipse cx="83" cy="83" rx="4.4" ry="2.7" fill="#ff7aa0" opacity="0.5"/>`,
    // Eyes, in four moods.
    `<g class="nv-eyes">${eye(54)}${eye(74)}<path d="M50 71.6L46.6 70.4M78 71.6L81.4 70.4" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/></g>`,
    `<g class="nv-laugh" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"><path d="M49.5 76Q54 69.5 58.5 76"/><path d="M69.5 76Q74 69.5 78.5 76"/></g>`,
    `<g class="nv-lids"><path d="M48.6 66.5H59.4V73H48.6Z" fill="${SKIN}"/><path d="M68.6 66.5H79.4V73H68.6Z" fill="${SKIN}"/><path d="M48.8 73H59.2M68.8 73H79.2" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/></g>`,
    `<g class="nv-brows"><path d="M48 66.2L57.6 63.8M70.4 63.8L80 66.2" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/><path d="M89 52Q92.4 57.6 89 60Q85.6 57.6 89 52Z" fill="#9fe6ff"/></g>`,
    // Mouths.
    `<path class="nv-smile" d="M58.5 86Q64 90.6 69.5 86" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`,
    `<path class="nv-smirk" d="M58.5 87.6Q65 89.6 70 84.8" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`,
    `<ellipse class="nv-o" cx="64" cy="88.4" rx="3.4" ry="4.2" fill="${MOUTH}"/>`,
    `<g class="nv-open"><path d="M57.2 85.2Q64 83.6 70.8 85.2Q70.4 95 64 95Q57.6 95 57.2 85.2Z" fill="${MOUTH}"/><ellipse cx="64" cy="92.6" rx="3.8" ry="2" fill="#ff7a95"/></g>`,
    // Hair over the brow, headset, mic and star clip.
    `<path d="M24 68Q26 29 66 29Q102 31 104 64Q90 49 74 52Q65 41 51 52Q38 50 24 68Z" fill="${HAIR}" clip-path="url(#${body})"/>`,
    `<path d="M41 45Q52 37 67 36.5" stroke="${HAIR_LIT}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`,
    `<path d="M29 70A35 38 0 0 1 99 70" fill="none" stroke="${HEADSET}" stroke-width="4" stroke-linecap="round"/>`,
    `<rect x="22.5" y="60" width="11" height="20" rx="5.5" fill="${HEADSET}"/><rect x="94.5" y="60" width="11" height="20" rx="5.5" fill="${HEADSET}"/>`,
    `<circle cx="100" cy="70" r="2.6" fill="${CYAN}"/>`,
    `<path d="M98.5 79Q97 92 81 93.5" fill="none" stroke="${HEADSET}" stroke-width="3" stroke-linecap="round"/>`,
    `<circle class="nv-mic" cx="79" cy="93.5" r="3.8" fill="${CYAN}"/>`,
    `<path class="nv-star" d="M87 36Q88.3 42.7 95 44Q88.3 45.3 87 52Q85.7 45.3 79 44Q85.7 42.7 87 36Z" fill="${CYAN}"/>`,
    `</g></g></g></svg>`,
  ].join('');
}
