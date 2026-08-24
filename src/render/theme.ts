export interface ColorTheme {
  name: string;
  base: number; // main orb color
  light: number; // highlight color
  css: string; // css hex string for DOM UI
}

/** Player colours are the flame-test emission colours of real elements. That
 *  isn't decoration — it's what keeps a six-way colour set from reading as
 *  arbitrary rainbow (which the art direction rules out) while still giving
 *  every player a channel that stays unmistakable against graphite. Ordered so
 *  the first four are maximally separated in hue for the common 2–4 player game. */
export const PLAYER_THEMES: ColorTheme[] = [
  { name: 'Caesium', base: 0x3ad9ff, light: 0xc2f2ff, css: '#3ad9ff' },
  { name: 'Strontium', base: 0xff3355, light: 0xffb3c0, css: '#ff3355' },
  { name: 'Barium', base: 0x5df08a, light: 0xc6ffd8, css: '#5df08a' },
  { name: 'Sodium', base: 0xffb020, light: 0xffe0a3, css: '#ffb020' },
  { name: 'Potassium', base: 0xa878ff, light: 0xdccaff, css: '#a878ff' },
  { name: 'Copper', base: 0x18e0c0, light: 0xb4fff2, css: '#18e0c0' },
  { name: 'Lithium', base: 0xff5cc0, light: 0xffc2e8, css: '#ff5cc0' },
  { name: 'Calcium', base: 0xff7a2f, light: 0xffcaa8, css: '#ff7a2f' },
];

/** Graphite lab bench, one cyan energy accent — no second hue in the chrome.
 *  The DOM side of the palette lives in style.css; only the values the WebGL
 *  scene needs are here, so there is one definition of each, not two. */
export const BOARD_BG_BOTTOM = 0x090c11;
export const CELL_IDLE = 0x161b23;
/** Etched frame, corner brackets and edge tick marks on the board substrate. */
export const GRID_LINE = 0x2b3542;
