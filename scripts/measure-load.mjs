/**
 * Measures first paint against when the 3D engine is requested, under CPU
 * throttling that stands in for a mid-range phone.
 *
 *   npm run build && npx vite preview --port 4175
 *   node scripts/measure-load.mjs http://localhost:4175 6
 *
 * On a fast desktop the main thread goes idle immediately, so deferring work
 * to idle proves nothing — the deferred work simply runs at once. Throttling
 * is the only way to see whether the menu actually gets the main thread
 * first, and it is how the attract-mode deferral was found to be firing
 * before first paint rather than after it.
 *
 * `menuPaintedFirst` is the number that matters: false means the player is
 * waiting on the 3D engine before they can see anything at all.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = 9340;
const URL_UNDER_TEST = process.argv[2] ?? 'http://localhost:4175';
const RATE = Number(process.argv[3] ?? 6);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(existsSync);
if (!CHROME) throw new Error('Chrome not found');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (p) => fetch(`http://127.0.0.1:${PORT}${p}`).then((r) => r.json());

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(tmpdir(), 'fissile-perf')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

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
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP socket failed'));
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const slot = pending.get(m.id);
    if (!slot) return;
    pending.delete(m.id);
    m.error ? slot.rej(new Error(m.error.message)) : slot.res(m.result);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setCPUThrottlingRate', { rate: RATE });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 393,
    height: 786,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await send('Page.navigate', { url: URL_UNDER_TEST });
  await sleep(12_000);

  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify((() => {
      const fcp = performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint');
      const three = performance.getEntriesByType('resource').find(r => /ThreeRenderer/.test(r.name));
      const nav = performance.getEntriesByType('navigation')[0];
      return {
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
        firstContentfulPaint: fcp ? Math.round(fcp.startTime) : null,
        engineRequestedAt: three ? Math.round(three.startTime) : 'never',
        engineArrivedAt: three ? Math.round(three.responseEnd) : 'never',
        menuPaintedFirst: fcp && three ? three.startTime > fcp.startTime : null,
      };
    })())`,
    returnByValue: true,
  });

  console.log(`CPU throttled ${RATE}x — ${URL_UNDER_TEST}`);
  console.log(r.result.value);
  ws.close();
} finally {
  chrome.kill();
}
