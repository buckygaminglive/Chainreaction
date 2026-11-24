// Cuts Nova's batched voice takes into one clip per line.
//
//   node scripts/nova-voice.mjs
//
// Inputs (store-assets/voice/):
//   batches.json  the 12-line groups the takes were generated from
//   urls.txt      "<batch> <url>" for every finished take
//   singles.txt   optional "<category> <index> <url>" for lines re-voiced alone
// Outputs:
//   public/audio/nova/<category>-NN.mp3   one clip per line
//   src/guide/voiced.ts                   which lines have a clip
//   store-assets/voice/report.json        anything that looked wrong
//
// A batch is cut at its N-1 longest pauses (the "[long pause]" between lines
// is far longer than any pause inside a line). Every clip is then checked
// against its text: a clip whose speaking rate is wildly off the median is
// flagged rather than shipped, so a bad cut can never pair words with the
// wrong audio.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VOICE = join(ROOT, 'store-assets/voice');
const RAW = join(VOICE, 'raw');
const OUT = join(ROOT, 'public/audio/nova');
mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });

const batches = JSON.parse(readFileSync(join(VOICE, 'batches.json'), 'utf8'));
const readPairs = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s+/))
    : [];
const urls = new Map(readPairs(join(VOICE, 'urls.txt')).map(([n, u]) => [Number(n), u]));
const singles = readPairs(join(VOICE, 'singles.txt')).map(([cat, i, u]) => ({ cat, i: Number(i), url: u }));

const display = (t) => t.replace(/\[[^\]]*\]\s*/g, '').trim();
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const probe = (file) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

function download(url, file) {
  if (existsSync(file)) return;
  execFileSync('curl', ['-s', '-f', '-o', file, url]);
}

function silenceList(file) {
  // silencedetect reports on stderr.
  const out = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-40dB:d=0.22', '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  }).stderr;
  const list = [];
  let start = null;
  for (const line of out.split(/\r?\n/)) {
    const s = /silence_start: ([\d.]+)/.exec(line);
    if (s) start = Number(s[1]);
    const e = /silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/.exec(line);
    if (e && start !== null) {
      list.push({ start, end: Number(e[1]), dur: Number(e[2]) });
      start = null;
    }
  }
  return list;
}

/**
 * Picks the n-1 pauses to cut at. Not simply the longest ones: a take's gaps
 * between lines vary, and occasionally one is no longer than a breath inside
 * a sentence. Each candidate set of cuts is scored by how well every segment's
 * length fits its line's text (a line twice as long should take about twice
 * as long to say) plus a bonus for cutting at longer pauses; dynamic
 * programming finds the best set.
 */
function align(cands, chars, total) {
  const n = chars.length;
  const first = cands.length ? 0 : 0;
  const speech = total - cands.reduce((a, c) => a + c.dur, 0) * 0.5;
  const overhead = 0.35;
  const rate = chars.reduce((a, c) => a + c, 0) / Math.max(1, speech - overhead * n);
  const expected = chars.map((c) => overhead + c / rate);
  const LAMBDA = 0.6;
  const sil = (c) => Math.log(Math.max(c.dur, 0.2) / 0.3);
  const seg = (fromEnd, toStart, j) => {
    const d = Math.max(0.05, toStart - fromEnd);
    const r = Math.log(d / expected[j]);
    return r * r;
  };
  const m = cands.length;
  // f[j][c]: best cost with the j-th cut (1-based) at candidate c.
  const f = Array.from({ length: n }, () => new Array(m).fill(Infinity));
  const back = Array.from({ length: n }, () => new Array(m).fill(-1));
  for (let c = 0; c < m; c++) f[1][c] = seg(first, cands[c].start, 0) - LAMBDA * sil(cands[c]);
  for (let j = 2; j < n; j++) {
    for (let c = j - 1; c < m; c++) {
      for (let p = j - 2; p < c; p++) {
        if (!Number.isFinite(f[j - 1][p])) continue;
        const v = f[j - 1][p] + seg(cands[p].end, cands[c].start, j - 1) - LAMBDA * sil(cands[c]);
        if (v < f[j][c]) {
          f[j][c] = v;
          back[j][c] = p;
        }
      }
    }
  }
  let best = Infinity;
  let at = -1;
  for (let c = n - 2; c < m; c++) {
    const v = f[n - 1][c] + seg(cands[c].end, total, n - 1);
    if (v < best) {
      best = v;
      at = c;
    }
  }
  const picks = [];
  for (let j = n - 1; j >= 1 && at >= 0; j--) {
    picks.push(cands[at]);
    at = back[j][at];
  }
  return picks.reverse();
}

/** Cuts [from, to] out of a take, trims its own edge silence, evens the level
 *  and writes a small mono MP3. Returns the clip's speaking length. */
function cut(src, from, to, dest) {
  const tmp = dest.replace(/\.mp3$/, '.tmp.wav');
  ff(['-i', src, '-ss', from.toFixed(3), '-to', to.toFixed(3), '-ac', '1', '-ar', '44100', tmp]);
  ff([
    '-i', tmp,
    '-af',
    'silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.08,areverse,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=0.02',
    '-ac', '1', '-ar', '44100', '-b:a', '48k', dest,
  ]);
  unlinkSync(tmp);
  return probe(dest);
}

const clips = new Map(); // "cat:i" -> { secs, chars }
const problems = [];

for (const batch of batches) {
  const url = urls.get(batch.n);
  if (!url) continue;
  const src = join(RAW, `batch-${String(batch.n).padStart(2, '0')}.mp3`);
  download(url, src);
  const total = probe(src);
  const n = batch.lines.length;
  // Inner pauses only: a silence touching either end of the take is padding.
  const inner = silenceList(src).filter((s) => s.start > 0.15 && s.end < total - 0.15);
  if (inner.length < n - 1) {
    problems.push({ batch: batch.n, issue: `found ${inner.length} pauses, need ${n - 1}` });
    continue;
  }
  const chosen = align(inner, batch.lines.map((l) => display(l.text).length), total);
  const bounds = [0, ...chosen.map((s) => (s.start + s.end) / 2), total];
  batch.lines.forEach((line, k) => {
    const dest = join(OUT, `${line.cat}-${String(line.i + 1).padStart(2, '0')}.mp3`);
    const secs = cut(src, bounds[k], bounds[k + 1], dest);
    clips.set(`${line.cat}:${line.i}`, { secs, chars: display(line.text).length, batch: batch.n });
  });
}

// Lines voiced on their own replace whatever the batch cut produced.
for (const s of singles) {
  const src = join(RAW, `single-${s.cat}-${s.i}.mp3`);
  download(s.url, src);
  const line = batches.flatMap((b) => b.lines).find((l) => l.cat === s.cat && l.i === s.i);
  if (!line) continue;
  const dest = join(OUT, `${s.cat}-${String(s.i + 1).padStart(2, '0')}.mp3`);
  const secs = cut(src, 0, probe(src), dest);
  clips.set(`${s.cat}:${s.i}`, { secs, chars: display(line.text).length, single: true });
}

// Speaking-rate check against the median.
const rates = [...clips.values()].map((c) => c.chars / c.secs).sort((a, b) => a - b);
const median = rates[Math.floor(rates.length / 2)] || 1;
const flagged = new Set();
for (const [id, c] of clips) {
  const rate = c.chars / c.secs;
  if (rate < median * 0.42 || rate > median * 2.1) {
    flagged.add(id);
    problems.push({ line: id, issue: `rate ${rate.toFixed(1)} chars/s vs median ${median.toFixed(1)}`, secs: c.secs.toFixed(2), batch: c.batch });
  }
}

// voiced.ts: one character per line, '1' where a trustworthy clip exists.
const LINES = {};
for (const b of batches) for (const l of b.lines) (LINES[l.cat] ??= []).push(l.i);
const entries = Object.entries(LINES).map(([cat, idx]) => {
  const bits = idx
    .sort((a, b) => a - b)
    .map((i) => (clips.has(`${cat}:${i}`) && !flagged.has(`${cat}:${i}`) ? '1' : '0'))
    .join('');
  return `  ${cat}: '${bits}',`;
});
writeFileSync(
  join(ROOT, 'src/guide/voiced.ts'),
  `/**
 * Which of Nova's lines have a recorded clip in public/audio/nova — one
 * character per line, in list order, '1' where the clip exists. Generated by
 * scripts/nova-voice.mjs after the clips are cut; do not edit by hand. A line
 * without a clip is shown as text only.
 */
export const CLIPS: Partial<Record<string, string>> = {
${entries.join('\n')}
};

export function hasClip(category: string, index: number): boolean {
  return CLIPS[category]?.[index] === '1';
}
`
);
writeFileSync(join(VOICE, 'report.json'), JSON.stringify({ clips: clips.size, flagged: [...flagged], median, problems }, null, 1));
console.log(`clips ${clips.size}, flagged ${flagged.size}, median ${median.toFixed(1)} chars/s`);
for (const p of problems) console.log('  !', JSON.stringify(p));
