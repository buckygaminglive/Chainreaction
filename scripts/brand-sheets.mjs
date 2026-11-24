// Renders the vector brand kit (src/art/*) into review sheets in
// store-assets/review/brand/. Run: node scripts/brand-sheets.mjs [part]
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { rankEmblemSvg, RANK_KEYS } from '../src/art/rankEmblem.ts';

const OUT = 'store-assets/review/brand';
mkdirSync(OUT, { recursive: true });
const part = process.argv[2] ?? 'all';

const BG = '#07090c';
const label = (x, y, text, size = 22, fill = '#7d8899', anchor = 'middle', weight = 500) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Segoe UI, Arial" font-weight="${weight}" font-size="${size}" fill="${fill}">${text}</text>`;
const inner = (svg) => svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
const place = (svg, x, y, s, vb = 128) => `<g transform="translate(${x} ${y}) scale(${s / vb})">${inner(svg)}</g>`;

async function sheet(name, w, h, body, title) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${BG}"/>${
    title ? label(48, 64, title, 30, '#e8edf4', 'start', 600) : ''
  }${body}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(`${OUT}/${name}.png`);
  console.log('wrote', `${OUT}/${name}.png`);
}

if (part === 'all' || part === 'ranks') {
  const names = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master'];
  let body = '';
  RANK_KEYS.forEach((k, i) => {
    const x = 48 + i * 250;
    body += place(rankEmblemSvg(k), x, 110, 220);
    body += label(x + 110, 362, names[i], 26, '#e8edf4');
  });
  // Small-size check row: the same emblems at list and chip sizes.
  RANK_KEYS.forEach((k, i) => {
    const x = 48 + i * 250;
    body += place(rankEmblemSvg(k), x + 40, 420, 64);
    body += place(rankEmblemSvg(k), x + 130, 436, 32);
  });
  await sheet('1-rank-emblems', 1560, 520, body, 'Rank emblems');
}

if (part === 'all' || part === 'crew') {
  const { crewSvg, CREW } = await import('../src/art/crew.ts');
  let body = '';
  CREW.forEach((c, i) => {
    const col = i % 6;
    const row = Math.floor(i / 6);
    const x = 48 + col * 250;
    const y = 110 + row * 300;
    body += place(crewSvg(c.key), x + 10, y, 200);
    body += label(x + 110, y + 240, c.name, 26, '#e8edf4');
  });
  // Lobby-size check: how they read at 40 px in a row of players.
  CREW.forEach((c, i) => {
    body += place(crewSvg(c.key), 48 + i * 56, 720, 44);
  });
  await sheet('2-profile-pictures', 1560, 800, body, 'Profile pictures');
}

if (part === 'all' || part === 'modes') {
  const { modeArtSvg, MODE_ART_KEYS } = await import('../src/art/modeArt.ts');
  const names = { classic: 'Classic', blitz: 'Blitz', chaos: 'Chaos', power: 'Power Cells', team: 'Team Battle', tournament: 'Tournament', survival: 'Survival' };
  let body = '';
  MODE_ART_KEYS.forEach((k, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = 48 + col * 370;
    const y = 110 + row * 290;
    body += place(modeArtSvg(k), x, y, 340, 320);
    body += label(x, y + 250, names[k], 26, '#e8edf4', 'start', 600);
  });
  await sheet('3-mode-artwork', 1560, 720, body, 'Mode artwork');
}

if (part === 'all' || part === 'share') {
  const { shareCardSvg } = await import('../src/art/shareCard.ts');
  // A plausible late-game board: mostly the winner's, a few holdouts.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const board = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 6 }, (_, c) => {
      const v = rnd();
      if (v < 0.12) return { owner: -1, count: 0 };
      const owner = v > 0.86 ? 1 : 0;
      const limit = (r === 0 || r === 8 ? 1 : 0) + (c === 0 || c === 5 ? 1 : 0);
      return { owner, count: 1 + Math.floor(rnd() * (3 - limit)) };
    })
  );
  const svg = shareCardSvg({
    tag: 'VS INSANE CPU',
    heroLabel: 'LONGEST CHAIN',
    hero: '×7',
    headline: 'I beat the Insane computer.',
    sub: 'Think you can top it?',
    board,
    colors: ['#3ad9ff', '#ff3355'],
    stats: [
      { label: 'RESULT', value: 'Win' },
      { label: 'CELLS', value: '41' },
      { label: 'TURNS', value: '23' },
    ],
    playerName: 'orbit_ace',
    avatarKey: 'volt',
    rankKey: 'gold',
    rankLine: 'Gold · 1,180 rating',
    cta: 'Beat my chain',
    url: 'chainreaction-sooty.vercel.app',
  });
  await sharp(Buffer.from(svg)).png().toFile(`${OUT}/4-share-card.png`);
  console.log('wrote', `${OUT}/4-share-card.png`);
}

if (part === 'nova') {
  const { crewSvg } = await import('../src/art/crew.ts');
  const body = place(crewSvg('nova'), 48, 100, 320) + place(crewSvg('nova'), 420, 180, 128) + place(crewSvg('nova'), 590, 220, 48);
  await sheet('5-nova', 700, 460, body, 'Nova');
}
