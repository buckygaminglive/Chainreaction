/**
 * The launch quality bar (roadmap §14) asks for analytics on session length,
 * retention, match completion, disconnects and mode popularity, plus crash and
 * error monitoring. None of that was observable, so no balance decision could
 * be evidence-based.
 *
 * This is the instrumentation, not a vendor. It is deliberately
 * provider-agnostic and **off until an endpoint is configured**:
 *
 *   echo "VITE_TELEMETRY_URL=https://…/collect" >> .env.local
 *
 * With no URL set, events are counted and (in dev) logged, and nothing leaves
 * the device. That ordering matters — the events have to exist and be correct
 * before choosing where to send them, and picking a vendor first is how
 * analytics ends up shaped by whatever the SDK happened to make easy.
 *
 * The wire format is one POST of `{ session, sentAt, events: [...] }`, batched,
 * with `sendBeacon` on the way out so the last batch of a session is not the
 * one that gets lost.
 *
 * What is deliberately never collected: no display names, no room codes, no
 * account secrets, no board positions, no IP-derived anything the receiver does
 * not already see. Everything here is a count, a duration or an enum.
 */

const ENDPOINT: string | undefined = import.meta.env.VITE_TELEMETRY_URL;
const OPT_OUT_KEY = 'reacton.telemetry.optout.v1';

/** Flushed when the batch reaches this, or on the way out. */
const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 30_000;
/** A runaway error loop must not turn into a runaway upload loop. */
const MAX_ERRORS_PER_SESSION = 8;

type Props = Record<string, string | number | boolean | undefined>;

interface Event {
  name: string;
  at: number;
  props?: Props;
}

/** Random per session, never persisted: enough to stitch one visit's events
 *  together, not enough to follow anyone between visits. Retention has to be
 *  measured on the receiving side from the account id the relay already has. */
const sessionId = Math.random().toString(36).slice(2, 12);
const startedAt = Date.now();

let queue: Event[] = [];
let errorCount = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let optedOut = readOptOut();

function readOptOut(): boolean {
  try {
    // Do Not Track is a request, and honouring it is free.
    if (navigator.doNotTrack === '1' || (window as any).doNotTrack === '1') return true;
    return localStorage.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

function post(events: Event[], beacon: boolean) {
  if (!ENDPOINT || events.length === 0) return;
  const body = JSON.stringify({ session: sessionId, sentAt: Date.now(), events });
  try {
    if (beacon && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      /* telemetry must never surface as a problem the player can see */
    });
  } catch {
    /* same */
  }
}

export const telemetry = {
  /** False while no endpoint is configured — the settings sheet says so rather
   *  than offering a switch over something that is not happening. */
  get configured() {
    return Boolean(ENDPOINT);
  },

  get enabled() {
    return !optedOut;
  },

  set enabled(value: boolean) {
    optedOut = !value;
    try {
      if (optedOut) localStorage.setItem(OPT_OUT_KEY, '1');
      else localStorage.removeItem(OPT_OUT_KEY);
    } catch {
      /* storage disabled — the choice holds for this session */
    }
    if (optedOut) queue = [];
  },

  event(name: string, props?: Props) {
    if (optedOut) return;
    queue.push({ name, at: Date.now() - startedAt, props });
    if (import.meta.env.DEV) console.debug('[telemetry]', name, props ?? '');
    if (queue.length >= BATCH_SIZE) telemetry.flush();
  },

  /** Errors go through the same pipe: a separate crash reporter would be a
   *  second vendor, a second consent story and a second thing to be down. */
  error(kind: string, message: string, stack?: string) {
    if (errorCount >= MAX_ERRORS_PER_SESSION) return;
    errorCount++;
    telemetry.event('error', {
      kind,
      message: message.slice(0, 300),
      // Enough frames to locate it, not enough to be a payload of its own.
      stack: stack?.split('\n').slice(0, 4).join(' | ').slice(0, 500),
    });
  },

  flush(beacon = false) {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    post(batch, beacon);
  },

  /** Called once at boot. Installs the global error hooks and the session
   *  lifecycle events §14 asks for. */
  start() {
    telemetry.event('session_start', {
      // Which shapes the game actually gets played at, for the responsive work.
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      standalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
    });

    window.addEventListener('error', (e) => {
      telemetry.error('uncaught', e.message, e.error?.stack);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason: unknown = e.reason;
      telemetry.error(
        'unhandled_rejection',
        reason instanceof Error ? reason.message : String(reason),
        reason instanceof Error ? reason.stack : undefined
      );
    });

    // pagehide, not beforeunload: it is the one that fires reliably on mobile
    // Safari, where a backgrounded tab is often never "unloaded" at all.
    window.addEventListener('pagehide', () => {
      telemetry.event('session_end', { seconds: Math.round((Date.now() - startedAt) / 1000) });
      telemetry.flush(true);
    });

    flushTimer ??= setInterval(() => telemetry.flush(), FLUSH_INTERVAL_MS);
  },
};
