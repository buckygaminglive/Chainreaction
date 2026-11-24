/**
 * The Orb Crew — profile pictures, drawn as vector.
 *
 * Every character is the game piece itself: an orb, cel-shaded in two flat
 * tones, given a face and one signature prop. One construction for all twelve
 * (same body, same eye spacing, same ink, same light from the upper left) is
 * what makes them a set rather than twelve clip-art picks, and the hues are
 * the game's own element colours, so a player's portrait sits naturally
 * beside their orbs on the board.
 */

export interface CrewMember {
  key: string;
  name: string;
  hue: string;
}

export const CREW: CrewMember[] = [
  { key: 'volt', name: 'Volt', hue: '#3ad9ff' },
  { key: 'doc', name: 'Doc', hue: '#18e0c0' },
  { key: 'bit', name: 'Bit', hue: '#9fadbd' },
  { key: 'astro', name: 'Astro', hue: '#ffb020' },
  { key: 'neko', name: 'Neko', hue: '#ff5cc0' },
  { key: 'kit', name: 'Kit', hue: '#ff7a2f' },
  { key: 'zorp', name: 'Zorp', hue: '#5df08a' },
  { key: 'shade', name: 'Shade', hue: '#ff3355' },
  { key: 'beat', name: 'Beat', hue: '#a878ff' },
  { key: 'pan', name: 'Pan', hue: '#e8edf4' },
  { key: 'hoot', name: 'Hoot', hue: '#c98a4b' },
  { key: 'cap', name: 'Cap', hue: '#6fc0ff' },
];

/** Nova — the game's guide, and the computer you play against. Drawn with
 *  the crew's construction but kept out of the picker: she is a character,
 *  not a costume. */
export const NOVA: CrewMember = { key: 'nova', name: 'Nova', hue: '#ffb79e' };

const INK = '#0b0e13';
const HAIR = '#2b2456';
const HAIR_LIT = '#4d4296';
const WHITE = '#ffffff';
const CX = 64;
const CY = 70;
const R = 34;

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

interface Tones {
  base: string;
  shade: string;
  light: string;
  bg: string;
  ring: string;
}

function tones(hue: string): Tones {
  return {
    base: hue,
    shade: mix(hue, '#000000', 0.3),
    light: mix(hue, '#ffffff', 0.6),
    bg: mix(hue, '#0b0e13', 0.82),
    ring: mix(hue, '#0b0e13', 0.7),
  };
}

const eye = (x: number, y: number, rx = 4.6, ry = 6.2): string =>
  `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${INK}"/><circle cx="${x + 1.7}" cy="${y - 2.6}" r="1.8" fill="${WHITE}"/>`;
const eyes = (y = 72): string => eye(54, y) + eye(74, y);
const smile = (y = 84, w = 5): string =>
  `<path d="M${CX - w} ${y}Q${CX} ${y + 4.6} ${CX + w} ${y}" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`;
const cheeks = (): string =>
  `<ellipse cx="45" cy="83" rx="4.4" ry="2.7" fill="#ff7aa0" opacity="0.5"/><ellipse cx="83" cy="83" rx="4.4" ry="2.7" fill="#ff7aa0" opacity="0.5"/>`;

/** Each character: what sits behind the body, and what sits on it. */
interface Parts {
  back?: (t: Tones) => string;
  /** Skip the body's glint — for characters whose hair covers that spot. */
  noShine?: boolean;
  face: (t: Tones, clip: string) => string;
}

const PARTS: Record<string, Parts> = {
  volt: {
    face: () =>
      eyes() + smile() + cheeks() +
      `<path d="M70 14L52 42H63L57 58L78 30H66L73 14Z" fill="#ffd23a"/><path d="M70 14L73 14L66 30H78L57 58L63 42Z" fill="#e0a51c" opacity="0.55"/>`,
  },
  doc: {
    face: (_t, clip) =>
      eyes(76) + smile(87) +
      `<rect x="26" y="50" width="76" height="8" fill="${INK}" clip-path="url(#${clip})"/>` +
      `<circle cx="52" cy="54" r="10" fill="#e8edf4"/><circle cx="76" cy="54" r="10" fill="#e8edf4"/>` +
      `<circle cx="52" cy="54" r="6.6" fill="#ffb020"/><circle cx="76" cy="54" r="6.6" fill="#ffb020"/>` +
      `<circle cx="49.6" cy="51.6" r="2" fill="${WHITE}"/><circle cx="73.6" cy="51.6" r="2" fill="${WHITE}"/>` +
      `<rect x="61" y="51.5" width="6" height="5" rx="1.5" fill="#e8edf4"/>`,
  },
  bit: {
    back: (t) =>
      `<rect x="62.5" y="20" width="3" height="18" fill="${INK}"/><circle cx="64" cy="18" r="5" fill="#ff3355"/><circle cx="62.4" cy="16.4" r="1.6" fill="${WHITE}"/>` +
      `<rect x="25" y="62" width="8" height="18" rx="3" fill="${t.shade}"/><rect x="95" y="62" width="8" height="18" rx="3" fill="${t.shade}"/>`,
    face: () =>
      `<rect x="42" y="61" width="44" height="20" rx="10" fill="${INK}"/>` +
      `<rect x="49" y="67" width="11" height="8" rx="4" fill="#3ad9ff"/><rect x="68" y="67" width="11" height="8" rx="4" fill="#3ad9ff"/>` +
      `<g stroke="${INK}" stroke-width="2.4" stroke-linecap="round"><path d="M56 89H72"/><path d="M58 94H70"/></g>`,
  },
  astro: {
    face: () =>
      eyes() + smile() + cheeks() +
      `<circle cx="64" cy="68" r="43" fill="#ffffff" fill-opacity="0.07" stroke="#e8edf4" stroke-width="5"/>` +
      `<path d="M33 52A36 36 0 0 1 52 32" fill="none" stroke="${WHITE}" stroke-width="4" stroke-linecap="round" opacity="0.75"/>` +
      `<path d="M30 64A36 36 0 0 1 31 59" fill="none" stroke="${WHITE}" stroke-width="4" stroke-linecap="round" opacity="0.75"/>`,
  },
  neko: {
    back: (t) =>
      `<path d="M36 56L35 24L60 40Z" fill="${t.base}"/><path d="M92 56L93 24L68 40Z" fill="${t.shade}"/>` +
      `<path d="M40 48L40 32L53 40Z" fill="#ffd0ea"/><path d="M88 48L88 32L75 40Z" fill="#ffd0ea"/>`,
    face: () =>
      eyes() + cheeks() +
      `<path d="M61.5 80.5H66.5L64 83.5Z" fill="${INK}"/>` +
      `<path d="M58 85Q61 88.5 64 85Q67 88.5 70 85" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>` +
      `<g stroke="${INK}" stroke-width="2" stroke-linecap="round" opacity="0.55"><path d="M38 79L26 77"/><path d="M38 84L27 86"/><path d="M90 79L102 77"/><path d="M90 84L101 86"/></g>`,
  },
  kit: {
    back: (t) =>
      `<path d="M34 60L30 18L62 42Z" fill="${t.base}"/><path d="M94 60L98 18L66 42Z" fill="${t.shade}"/>` +
      `<path d="M30 18L36 30L42 26Z" fill="${INK}"/><path d="M98 18L92 30L86 26Z" fill="${INK}"/>`,
    face: (_t, clip) =>
      `<ellipse cx="64" cy="94" rx="24" ry="17" fill="#fff4ea" clip-path="url(#${clip})"/>` +
      eye(54, 70, 4.4, 5.6) + eye(74, 70, 4.4, 5.6) +
      `<ellipse cx="64" cy="81" rx="4" ry="3" fill="${INK}"/>` +
      `<path d="M59 86Q64 90 69 86" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`,
  },
  zorp: {
    back: (t) =>
      `<g stroke="${INK}" stroke-width="3" stroke-linecap="round" fill="none"><path d="M52 42Q46 30 40 20"/><path d="M76 42Q82 30 88 20"/></g>` +
      `<circle cx="40" cy="19" r="5.5" fill="${t.light}"/><circle cx="88" cy="19" r="5.5" fill="${t.light}"/>`,
    face: () =>
      eye(64, 60, 6, 7.6) + eye(49, 75, 4, 5.2) + eye(79, 75, 4, 5.2) +
      `<path d="M56 87Q64 93 72 87" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`,
  },
  shade: {
    back: () => `<path d="M96 66L118 58L112 70Z" fill="${INK}"/><path d="M96 74L116 82L106 72Z" fill="${INK}"/>`,
    face: (_t, clip) =>
      `<rect x="26" y="61" width="76" height="20" fill="${INK}" clip-path="url(#${clip})"/>` +
      `<path d="M45 72Q53 63.5 62 69.5Q54 77 45 72Z" fill="${WHITE}"/><path d="M83 72Q75 63.5 66 69.5Q74 77 83 72Z" fill="${WHITE}"/>` +
      `<circle cx="55.5" cy="71" r="3.1" fill="${INK}"/><circle cx="72.5" cy="71" r="3.1" fill="${INK}"/>` +
      `<path d="M59 90H69" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`,
  },
  beat: {
    face: () =>
      eye(54, 72, 4.6, 3.4) + eye(74, 72, 4.6, 3.4) + smile(85, 6) + cheeks() +
      `<path d="M30 66A34 34 0 0 1 98 66" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>` +
      `<rect x="22" y="58" width="15" height="26" rx="7.5" fill="${INK}"/><rect x="91" y="58" width="15" height="26" rx="7.5" fill="${INK}"/>` +
      `<rect x="26" y="64" width="4" height="14" rx="2" fill="#3ad9ff"/><rect x="98" y="64" width="4" height="14" rx="2" fill="#3ad9ff"/>`,
  },
  pan: {
    back: () => `<circle cx="38" cy="42" r="11" fill="${INK}"/><circle cx="90" cy="42" r="11" fill="${INK}"/>`,
    face: () =>
      `<ellipse cx="52" cy="72" rx="8.5" ry="11" fill="#1c222b" transform="rotate(28 52 72)"/>` +
      `<ellipse cx="76" cy="72" rx="8.5" ry="11" fill="#1c222b" transform="rotate(-28 76 72)"/>` +
      `<circle cx="53" cy="71" r="3.4" fill="${WHITE}"/><circle cx="75" cy="71" r="3.4" fill="${WHITE}"/>` +
      `<ellipse cx="64" cy="82" rx="4" ry="2.8" fill="${INK}"/>` +
      `<path d="M59 87Q64 90.5 69 87" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>` + cheeks(),
  },
  hoot: {
    back: (t) => `<path d="M38 48L30 26L54 40Z" fill="${t.shade}"/><path d="M90 48L98 26L74 40Z" fill="${t.shade}"/>`,
    face: (t, clip) =>
      `<ellipse cx="64" cy="100" rx="20" ry="14" fill="${t.light}" clip-path="url(#${clip})"/>` +
      `<circle cx="52" cy="68" r="11" fill="#fff4dc"/><circle cx="76" cy="68" r="11" fill="#fff4dc"/>` +
      `<circle cx="53" cy="69" r="5.6" fill="${INK}"/><circle cx="75" cy="69" r="5.6" fill="${INK}"/>` +
      `<circle cx="54.8" cy="66.6" r="1.8" fill="${WHITE}"/><circle cx="76.8" cy="66.6" r="1.8" fill="${WHITE}"/>` +
      `<path d="M59 80H69L64 88Z" fill="#ffb020"/>`,
  },
  nova: {
    noShine: true,
    back: () => `<path d="M27 74Q24 33 64 30Q104 33 101 74V99Q93 105 86 97H42Q35 105 27 99Z" fill="${HAIR}"/>`,
    face: (_t, clip) =>
      eyes(74) + smile(86, 5.5) + cheeks() +
      `<path d="M50 71.6L46.6 70.4M78 71.6L81.4 70.4" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>` +
      `<path d="M24 68Q26 29 66 29Q102 31 104 64Q90 49 74 52Q65 41 51 52Q38 50 24 68Z" fill="${HAIR}" clip-path="url(#${clip})"/>` +
      `<path d="M41 45Q52 37 67 36.5" stroke="${HAIR_LIT}" stroke-width="3.2" fill="none" stroke-linecap="round"/>` +
      `<path d="M29 70A35 38 0 0 1 99 70" fill="none" stroke="#e8edf4" stroke-width="4" stroke-linecap="round"/>` +
      `<rect x="22.5" y="60" width="11" height="20" rx="5.5" fill="#e8edf4"/><rect x="94.5" y="60" width="11" height="20" rx="5.5" fill="#e8edf4"/>` +
      `<circle cx="100" cy="70" r="2.6" fill="#3ad9ff"/>` +
      `<path d="M98.5 79Q97 92 81 93.5" fill="none" stroke="#e8edf4" stroke-width="3" stroke-linecap="round"/><circle cx="79" cy="93.5" r="3.8" fill="#3ad9ff"/>` +
      `<path d="M87 36Q88.3 42.7 95 44Q88.3 45.3 87 52Q85.7 45.3 79 44Q85.7 42.7 87 36Z" fill="#3ad9ff"/>`,
  },
  cap: {
    face: (_t, clip) =>
      eyes(74) + smile(86) + cheeks() +
      `<rect x="20" y="20" width="88" height="34" fill="#ff3355" clip-path="url(#${clip})"/>` +
      `<rect x="20" y="49" width="88" height="5" fill="#c41f3d" clip-path="url(#${clip})"/>` +
      `<path d="M70 54Q92 50 104 56Q92 60 70 58Z" fill="#c41f3d"/>` +
      `<circle cx="64" cy="37" r="3" fill="#c41f3d"/>`,
  },
};

let instance = 0;

export function crewSvg(key: string, size = 128): string {
  const member = CREW.find((c) => c.key === key) ?? (key === NOVA.key ? NOVA : CREW[0]);
  const t = tones(member.hue);
  // Nova sits on the brand's own cyan rather than a tint of her colour, which
  // marks her as the game's voice wherever her portrait appears.
  if (member === NOVA) {
    t.bg = '#0a2730';
    t.ring = '#135566';
  }
  const parts = PARTS[member.key];
  const uid = `cr${++instance}`;
  const clip = `${uid}b`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}" role="img" aria-label="${member.name}">`,
    `<defs><clipPath id="${uid}f"><circle cx="64" cy="64" r="64"/></clipPath><clipPath id="${clip}"><circle cx="${CX}" cy="${CY}" r="${R}"/></clipPath></defs>`,
    `<g clip-path="url(#${uid}f)">`,
    `<rect width="128" height="128" fill="${t.bg}"/>`,
    `<circle cx="64" cy="64" r="52" fill="none" stroke="${t.ring}" stroke-width="1.5"/>`,
    `<ellipse cx="64" cy="112" rx="30" ry="5" fill="#000000" opacity="0.35"/>`,
    // The character is drawn at 1.12× about its own centre so it fills the
    // frame; props are allowed to break the inner ring, which gives depth.
    `<g transform="translate(${CX} ${CY}) scale(1.12) translate(${-CX} ${-CY})">`,
    parts.back ? parts.back(t) : '',
    `<circle cx="${CX}" cy="${CY}" r="${R}" fill="${t.shade}"/>`,
    `<circle cx="${CX - 4}" cy="${CY - 5}" r="${R}" fill="${t.base}" clip-path="url(#${clip})"/>`,
    parts.noShine ? '' : `<ellipse cx="49" cy="52" rx="7" ry="4.2" fill="${t.light}" transform="rotate(-38 49 52)"/>`,
    parts.face(t, clip),
    '</g>',
    '</g>',
    '</svg>',
  ].join('');
}
