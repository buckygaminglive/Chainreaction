import { layoutForMode } from '../game/cells';
import { GAME_MODES, type GameModeKey } from '../game/modes';
import { PLAYER_THEMES } from './theme';

/** Drawn from the same generator the match will use, rather than from artwork.
 *  A picture of a mode can drift from what the mode actually does; a render of
 *  its real lattice cannot. It also costs a couple of kB of inline SVG instead
 *  of an image request, which the load budget cares about. */

const CELL = 9;
const GAP = 1.6;
const PITCH = CELL + GAP;

/** A stable seed so the Chaos preview doesn't flicker to a new board on every
 *  repaint. The real match re-rolls — the caption says so. */
const SAMPLE_SEED = 20260824;

const KIND_STYLE: Record<string, { fill: string; stroke: string }> = {
  normal: { fill: 'rgba(255,255,255,0.05)', stroke: 'none' },
  void: { fill: 'rgba(0,0,0,0.55)', stroke: 'none' },
  catalyst: { fill: 'rgba(255,202,122,0.10)', stroke: '#ffca7a' },
  damper: { fill: 'rgba(95,112,138,0.12)', stroke: '#5f708a' },
};

/** Which seats the preview tints, so Team Battle reads as two sides rather
 *  than as another plain grid. */
const TEAM_PREVIEW_INDICES = [0, 5, 1, 7];

export interface ModePreview {
  svg: string;
  caption: string;
  /** Whether this particular lattice actually contains special sites. Survival
   *  round 1 is a clean board, so the legend would be explaining nothing. */
  hasSpecials: boolean;
}

export function modePreview(
  mode: GameModeKey,
  rows: number,
  cols: number,
  round = 1
): ModePreview {
  const spec = GAME_MODES[mode];
  const kinds = layoutForMode(mode, rows, cols, SAMPLE_SEED, round);

  const w = cols * PITCH - GAP;
  const h = rows * PITCH - GAP;
  // Room under the lattice for the timer bar / series pips.
  const footer = spec.turnSeconds !== null || spec.seriesLength > 1 ? 9 : 0;

  const parts: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const style = KIND_STYLE[kinds[r][c]] ?? KIND_STYLE.normal;
      const x = c * PITCH;
      const y = r * PITCH;
      const stroke = style.stroke === 'none' ? '' : ` stroke="${style.stroke}" stroke-width="0.9"`;
      parts.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="1.4" fill="${style.fill}"${stroke}/>`);
    }
  }

  // Team Battle: show which corners the four sides start from.
  if (spec.teams) {
    const spots: [number, number][] = [
      [0, 0],
      [rows - 1, cols - 1],
      [0, cols - 1],
      [rows - 1, 0],
    ];
    spots.forEach(([r, c], i) => {
      const theme = PLAYER_THEMES[TEAM_PREVIEW_INDICES[i]];
      const x = c * PITCH + CELL / 2;
      const y = r * PITCH + CELL / 2;
      parts.push(`<circle cx="${x}" cy="${y}" r="2.6" fill="${theme.css}"/>`);
    });
  }

  // Survival / Chaos already say everything through the lattice itself.
  if (spec.turnSeconds !== null) {
    const filled = w * 0.42;
    parts.push(`<rect x="0" y="${h + 5}" width="${w}" height="1.6" rx="0.8" fill="rgba(255,255,255,0.1)"/>`);
    parts.push(`<rect x="0" y="${h + 5}" width="${filled}" height="1.6" rx="0.8" fill="#3ad9ff"/>`);
  }

  if (spec.seriesLength > 1) {
    const won = Math.ceil(spec.seriesLength / 2) - 1;
    const pitch = w / spec.seriesLength;
    for (let i = 0; i < spec.seriesLength; i++) {
      const filled = i < won;
      parts.push(
        `<rect x="${i * pitch}" y="${h + 5}" width="${pitch - 2}" height="1.6" rx="0.8" fill="${
          filled ? '#3ad9ff' : 'rgba(255,255,255,0.1)'
        }"/>`
      );
    }
  }

  const svg =
    `<svg viewBox="0 0 ${w} ${h + footer}" xmlns="http://www.w3.org/2000/svg" role="img" ` +
    `aria-label="${spec.name} lattice preview" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;

  return {
    svg,
    caption: captionFor(mode, round),
    hasSpecials: kinds.some((row) => row.some((k) => k !== 'normal')),
  };
}

function captionFor(mode: GameModeKey, round: number): string {
  switch (mode) {
    case 'chaos':
      return 'sample lattice — re-rolled every match';
    case 'power':
      return 'catalysts ring the centre · dampers hold the corners';
    case 'survival':
      return round > 1 ? `round ${round} lattice` : 'round 1 — a clean lattice';
    case 'team':
      return 'two sides, alternating turns';
    case 'tournament':
      return 'first to three games';
    case 'blitz':
      return 'ten seconds a turn';
    default:
      return 'a plain lattice — nothing but position';
  }
}
