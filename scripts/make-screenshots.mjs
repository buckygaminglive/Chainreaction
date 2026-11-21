/**
 * Captures the Play Store phone screenshots from the real game.
 *
 *   npm run dev            (in another terminal)
 *   node scripts/make-screenshots.mjs
 *
 * These have to be genuine captures. Play's metadata policy is explicit that
 * screenshots represent actual app content, and a mock-up is grounds for
 * rejection — so this drives a real Chrome over the DevTools Protocol against
 * the real app, plays real moves through the real engine, and photographs
 * whatever comes out of it.
 *
 * Chrome runs headful on purpose: the board is WebGL, and software
 * rasterisation gives up the bloom and the specular highlights on the orbs,
 * which is most of what makes a board worth screenshotting.
 *
 * No dependencies — Node has had a global WebSocket since 22, and that is the
 * only thing a CDP client actually needs.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Raw captures. The picks that go to Play are copied up a level by hand,
// one folder per form factor, after looking at them.
const OUT = join(ROOT, 'store-assets', 'screenshots', 'raw');
const ORIGIN = process.env.SHOT_ORIGIN ?? 'http://localhost:5173';
const PORT = 9333;

// 540×960 CSS at dpr 2 is exactly the 1080×1920 Play wants, and stays under
// the 700px breakpoint so it is the phone layout that gets photographed.
/**
 * One entry per Play form factor that wants its own screenshots.
 *
 * The CSS viewport and the device pixel ratio are chosen together so the
 * capture lands exactly on a 9:16 or 16:9 pixel size inside Play's per-slot
 * range, while the CSS width still resolves to the layout a real device of
 * that class would get. That second half matters: emulating 1920 CSS pixels
 * on a "7-inch tablet" would photograph the desktop layout and call it a
 * tablet.
 *
 * The landscape profiles are also the ones that show off the wide lattice,
 * which is the whole reason the board has an orientation setting.
 */
const PROFILES = [
  {
    key: 'phone',
    view: { width: 540, height: 960, deviceScaleFactor: 2, mobile: true },
    out: '1080×1920 (9:16)',
  },
  {
    key: 'tablet-7',
    // 320–3,840 px per side.
    view: { width: 960, height: 540, deviceScaleFactor: 2, mobile: true },
    out: '1920×1080 (16:9)',
  },
  {
    key: 'tablet-10',
    // 1,080–7,680 px per side.
    view: { width: 1280, height: 720, deviceScaleFactor: 2, mobile: true },
    out: '2560×1440 (16:9)',
  },
  {
    key: 'desktop',
    // Serves both Play Games on PC (720–7,680) and Chromebook (1,080–7,680).
    view: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false },
    out: '1920×1080 (16:9)',
  },
];

/** Set per profile; `shot` writes here. */
let outDir = null;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(existsSync);
if (!CHROME) throw new Error('Chrome not found');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (path) => fetch(`http://127.0.0.1:${PORT}${path}`).then((r) => r.json());

/** A CDP session over one page target. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP socket failed'));
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.rej(new Error(msg.error.message));
    else slot.res(msg.result);
  };

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

  /**
   * Runs an expression in the page. A page-side throw is rethrown here rather
   * than coming back as undefined: a step that silently did nothing would
   * otherwise be photographed as though it had worked.
   */
  const evaluate = async (expression, timeoutMs = 240_000) => {
    // A page-side promise that never settles would otherwise hang the run with
    // no output at all — silence that looks identical to slow progress. The
    // deadline turns it into a failure that says which step stalled.
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error(`page evaluate stalled after ${timeoutMs / 1000}s: ${expression.trim().slice(0, 80)}…`)),
          timeoutMs
        )
      ),
    ]);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const buf = Buffer.from(data, 'base64');
    writeFileSync(join(outDir, name), buf);
    console.log(`  ${name.padEnd(24)} ${(buf.length / 1024).toFixed(0)} kB`);
  };

  return { send, evaluate, shot, close: () => ws.close() };
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(ORIGIN, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`${ORIGIN} never answered — is the dev server running?`);
}

// ---------- page-side helpers ----------
// Injected once and then called by name, so the driving logic below reads as
// one program rather than as a pile of string literals.

const HELPERS = `
(async () => {
  // The game's own opponent, imported straight from source — Vite serves the
  // module in dev. A hand-rolled heuristic produced boards no real game would
  // ever reach (everything stacked down one column), and a screenshot of a
  // position nobody would play is a worse advert than no screenshot.
  const ai = await import('/src/game/ai.ts');
  const { GameEngine } = await import('/src/game/GameEngine.ts');
  const clone = (v) => JSON.parse(JSON.stringify(v));

  window.__shot = {
    engine: () => window.__debug && window.__debug.engine,

    /** One move from the AI, awaited to the end of its animation. */
    async play(skill) {
      const e = this.engine();
      if (e.gameOver) return false;
      const m = ai.chooseMove(e, e.currentPlayer().id, skill === undefined ? 0.8 : skill);
      if (!m) return false;
      await window.__debug.onCellTapLocal(m.row, m.col);
      return true;
    },

    /**
     * The legal move that sets off the longest chain.
     *
     * Every candidate is played out on a scratch engine loaded from a copy of
     * the real one, never on the live board. Playing and rolling back in place
     * would be shorter, but the renderer is a separate copy of the same state
     * and any imperfection in the rollback shows up as a board drawing cells
     * that the rules say cannot exist — which is precisely the sort of thing
     * that must not reach a store listing.
     */
    bestChain() {
      const live = this.engine();
      const snapshot = clone(live.getSnapshot());
      const ranked = [];
      for (const m of live.legalMoves()) {
        const scratch = new GameEngine({
          rows: live.rows,
          cols: live.cols,
          players: clone(live.players),
          kinds: clone(live.kinds),
        });
        scratch.loadSnapshot(clone(snapshot));
        ranked.push({ row: m.row, col: m.col, chain: scratch.applyMove(m.row, m.col).chain });
      }
      ranked.sort((a, b) => b.chain - a.chain);
      return ranked[0] ?? null;
    },

    /**
     * Whether the board being drawn still matches the board being played.
     *
     * The whole point of these captures is that they show the real game, so
     * this is checked rather than assumed — a divergence would photograph as a
     * cell sitting above its own critical mass.
     */
    consistent() {
      const e = this.engine();
      const view = window.__debug.renderer.renderState;
      const wrong = [];
      for (let r = 0; r < e.rows; r++) {
        for (let c = 0; c < e.cols; c++) {
          const cell = e.getCell(r, c);
          const seen = view[r][c];
          if (cell.orbs !== seen.orbs || cell.owner !== seen.owner) {
            wrong.push(r + ',' + c + ' engine ' + cell.owner + '/' + cell.orbs + ' view ' + seen.owner + '/' + seen.orbs);
          }
          if (cell.owner !== null && cell.orbs >= e.criticalMass(r, c)) {
            wrong.push(r + ',' + c + ' is over critical mass in the engine');
          }
        }
      }
      return wrong;
    },

    /** Starts a move and returns at once, leaving the orbs in flight. */
    fire(m) {
      window.__debug.onCellTapLocal(m.row, m.col);
    },
  };
  return true;
})()
`;

// ---------- the run ----------

async function load(page) {
  await page.send('Page.navigate', { url: ORIGIN });
  await sleep(2500);
  // A previous run's prefs, puzzle progress and computer level would otherwise
  // decide what these screenshots show.
  await page.evaluate('localStorage.clear()');
  await page.send('Page.reload', { ignoreCache: true });
  await sleep(3500);
  // Silence the capture run; the screenshots are the same either way.
  await page.evaluate(`document.getElementById('mute-btn-menu').click(); true`);
}

async function startLocalGame(page) {
  await page.evaluate(`document.getElementById('setup-start-btn').click()`);
  await sleep(3200);
  await page.evaluate(HELPERS);
  await page.evaluate(
    `if (!window.__debug) { throw new Error('__debug missing — point SHOT_ORIGIN at the dev server, not a production build'); } true;`
  );
}

/** The chain depth the on-board callout is showing, or 0 when hidden. */
const CHAIN_DEPTH = `(() => {
  const el = document.getElementById('chain-readout');
  if (!el.classList.contains('show')) return 0;
  return parseInt((el.querySelector('.cv')?.textContent || '').replace(/\\D/g, ''), 10) || 0;
})()`;

/**
 * Photographs the moment a cascade reaches `depth`. Polled rather than timed:
 * waves accelerate as a chain deepens, so a fixed delay lands on a different
 * wave every run.
 */
async function shotAtDepth(page, name, depth, timeoutMs = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await page.evaluate(CHAIN_DEPTH)) >= depth) break;
    await sleep(30);
  }
  await page.shot(name);
}

async function waitUntil(page, expr, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(expr)) return true;
    await sleep(80);
  }
  return false;
}

async function run(page) {
  await load(page);

  console.log('home');
  await sleep(2500); // let the attract board build a reaction behind the type
  await page.shot('01-home.png');

  console.log('cascade');
  await page.evaluate(`document.getElementById('play-btn').click()`);
  await sleep(900);
  await startLocalGame(page);
  // Let two AI players build a position first. A board worth photographing is
  // one a real game would actually reach.
  const setup = await page.evaluate(`
    (async () => {
      for (let i = 0; i < 44; i++) {
        await window.__shot.play(0.8);
        if (window.__shot.engine().gameOver) break;
      }
      // Keep playing until a chain deep enough to earn a named callout is on
      // offer, rather than settling for whatever the last move left behind.
      let best = window.__shot.bestChain();
      for (let tries = 0; tries < 40 && best && best.chain < 8; tries++) {
        await window.__shot.play(0.8);
        if (window.__shot.engine().gameOver) break;
        best = window.__shot.bestChain();
      }
      return { best: best, wrong: window.__shot.consistent() };
    })()
  `);
  if (setup.wrong.length) {
    throw new Error(`board and renderer disagree:\n  ${setup.wrong.join('\n  ')}`);
  }
  const depth = setup.best.chain;
  console.log(`  firing a ${depth}-wave chain at ${setup.best.row},${setup.best.col}`);
  await page.evaluate(`window.__shot.fire(${JSON.stringify(setup.best)})`);
  await shotAtDepth(page, '02-cascade-a.png', Math.min(3, depth));
  await shotAtDepth(page, '02-cascade-b.png', Math.min(5, depth));
  await shotAtDepth(page, '02-cascade-c.png', Math.max(2, depth - 1));

  console.log('board once the chain settles');
  await sleep(3500);
  await page.shot('03-board.png');

  console.log('endgame');
  const moves = await page.evaluate(`
    (async () => {
      for (let i = 0; i < 300; i++) {
        if (window.__shot.engine().gameOver) return i;
        await window.__shot.play(0.85);
      }
      return -1;
    })()
  `);
  console.log(`  game ended after ${moves} more moves`);
  await sleep(2800);
  await page.shot('04-victory.png');

  console.log('daily page');
  await page.evaluate(`document.getElementById('win-menu-btn').click(); true`);
  await sleep(900);
  await page.evaluate(`document.querySelector('.tab[data-tab=daily]').click(); true`);
  await sleep(1400);
  await page.shot('05-daily.png');

  console.log('daily blast');
  await page.evaluate(`document.getElementById('dp-play-btn').click(); true`);
  await sleep(3600);
  // The puzzle's deepest move, found on scratch copies of the live board and
  // played through the board's own tap handler — the same path a finger takes.
  const daily = await page.evaluate(`
    (() => {
      const best = window.__shot.bestChain();
      window.__debug.renderer.onCellTap(best.row, best.col);
      return best;
    })()
  `);
  console.log(`  solving with the ×${daily.chain} move at ${daily.row},${daily.col}`);
  await shotAtDepth(page, '06-daily-blast.png', Math.max(2, daily.chain - 1));
  await waitUntil(page, `!document.getElementById('screen-daily').classList.contains('hidden')`);
  await sleep(700);
  await page.shot('07-daily-result.png');

  console.log('vs computer');
  await page.evaluate(`
    (async () => {
      document.getElementById('daily-close-btn').click();
      await new Promise((r) => setTimeout(r, 700));
      document.querySelector('.tab[data-tab=play]').click();
      await new Promise((r) => setTimeout(r, 700));
      document.getElementById('cpu-btn').click();
      await new Promise((r) => setTimeout(r, 500));
      document.querySelector('.cpu-level[data-level="3"]').click();
    })()
  `);
  await sleep(900);
  await page.shot('08-vs-computer.png');

  console.log('how to play');
  await page.evaluate(`
    (async () => {
      document.getElementById('cpu-close-btn').click();
      await new Promise((r) => setTimeout(r, 600));
      document.getElementById('howto-btn').click();
    })()
  `);
  await sleep(1600);
  await page.shot('09-howto.png');
}

await waitForServer();

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(tmpdir(), 'fissile-shots')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    // Without these, Chrome throttles requestAnimationFrame the moment its
    // window is covered by another one. GSAP then stops advancing, the promise
    // an animated move returns never settles, and the run hangs forever with
    // no error — which is exactly what happened the first time this was left
    // to work in the background.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=620,1040',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let page;
try {
  for (let i = 0; i < 60; i++) {
    try {
      await json('/json/version');
      break;
    } catch {
      await sleep(500);
    }
  }
  const target = (await json('/json/list')).find((t) => t.type === 'page');
  page = await connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  // Which form factors to shoot. `SHOT_PROFILES=phone,desktop` narrows it —
  // a full run plays four complete games and is not quick.
  const wanted = process.env.SHOT_PROFILES?.split(',').map((s) => s.trim());
  const profiles = wanted ? PROFILES.filter((p) => wanted.includes(p.key)) : PROFILES;
  if (!profiles.length) throw new Error(`no profiles matched ${process.env.SHOT_PROFILES}`);

  for (const profile of profiles) {
    outDir = join(OUT, profile.key);
    mkdirSync(outDir, { recursive: true });
    console.log(`\n=== ${profile.key} — ${profile.out} ===`);
    await page.send('Emulation.setDeviceMetricsOverride', profile.view);
    await run(page);
  }

  console.log(`\nwrote ${OUT}`);
} finally {
  page?.close();
  chrome.kill();
}
