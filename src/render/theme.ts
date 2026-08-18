export interface ColorTheme {
  name: string;
  base: number; // main orb color
  light: number; // highlight color
  css: string; // css hex string for DOM UI
}

export const PLAYER_THEMES: ColorTheme[] = [
  { name: 'Crimson', base: 0xff3b5c, light: 0xff9db0, css: '#ff3b5c' },
  { name: 'Azure', base: 0x2fb4ff, light: 0xa6e2ff, css: '#2fb4ff' },
  { name: 'Lime', base: 0x7bff3b, light: 0xd4ffb0, css: '#7bff3b' },
  { name: 'Gold', base: 0xffc23b, light: 0xffe4a3, css: '#ffc23b' },
  { name: 'Violet', base: 0xb35bff, light: 0xe0bfff, css: '#b35bff' },
  { name: 'Aqua', base: 0x3bffe0, light: 0xb0fff2, css: '#3bffe0' },
  { name: 'Pink', base: 0xff5bd4, light: 0xffc1ec, css: '#ff5bd4' },
  { name: 'Orange', base: 0xff7b3b, light: 0xffc3a3, css: '#ff7b3b' },
];

export const BOARD_BG_TOP = 0x120c24;
export const BOARD_BG_BOTTOM = 0x1c1240;
export const CELL_IDLE = 0x2a2050;
export const CELL_BORDER = 0x3d2f6e;
export const APP_BG = '#0a0718';
