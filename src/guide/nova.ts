/**
 * Nova, the voice — picks a line, shows it, plays it, and animates her face.
 *
 * Where she appears is a "stage": any element holding a `.nova-pfp` and a
 * `.nova-text`. The game dock, the result card, the welcome sheet and the
 * lesson each have one; `attach()` points her at whichever is on screen.
 *
 * Variety is the whole point, so lines are drawn from a shuffle bag per
 * category: every line in a category plays once before any repeats, the bag
 * survives restarts, and a refill never opens with the line that just played.
 */
import { LINES, audioPath, displayText, type LineCategory } from './lines.ts';
import { expressionFor, novaFaceSvg } from './novaFace.ts';
import { hasClip } from './voiced.ts';

export type Chatter = 'lots' | 'some' | 'off';

export interface NovaPrefs {
  chatter: Chatter;
  voice: boolean;
}

/** The slice of the audio engine Nova needs. */
export interface NovaSpeaker {
  speak(url: string): Promise<number | null>;
  stopSpeech(): void;
  speechLevel(): number;
}

export interface SayOptions {
  /** 0 filler · 1 reaction · 2 big moment · 3 must play (lesson, result). */
  priority?: number;
  /** Keep the words on screen after she finishes (lesson steps). */
  persist?: boolean;
  /** A specific line rather than the next one from the bag. */
  index?: number;
}

const PREFS_KEY = 'fissile.nova.v1';
const BAGS_KEY = 'fissile.nova.bags.v1';
/** Quiet time after a line before a low-priority one may start. */
const GAP_MS = 2200;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: variety resets next launch, nothing breaks */
  }
}

function shuffled(n: number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Next index from a shuffle bag. Exported for the tests. */
export function drawFromBag(bag: number[] | undefined, size: number, last: number | undefined): { index: number; bag: number[] } {
  let next = (bag ?? []).filter((i) => i >= 0 && i < size);
  if (next.length === 0) {
    next = shuffled(size);
    // A fresh bag must not start with the line that ended the last one.
    if (size > 1 && next[next.length - 1] === last) {
      [next[0], next[next.length - 1]] = [next[next.length - 1], next[0]];
    }
  }
  const index = next.pop()!;
  return { index, bag: next };
}

export class Nova {
  prefs: NovaPrefs;
  private bags: Record<string, number[]>;
  private last: Record<string, number> = {};
  private stage: HTMLElement | null = null;
  private face: SVGElement | null = null;
  private current: { priority: number; token: number } | null = null;
  private token = 0;
  private quietUntil = 0;
  private raf = 0;
  private hideTimer = 0;
  private typeTimer = 0;
  private saveTimer = 0;

  private speaker: NovaSpeaker;

  constructor(speaker: NovaSpeaker) {
    this.speaker = speaker;
    const p = readJson<Partial<NovaPrefs>>(PREFS_KEY, {});
    this.prefs = {
      chatter: p.chatter === 'some' || p.chatter === 'off' ? p.chatter : 'lots',
      voice: p.voice !== false,
    };
    this.bags = readJson<Record<string, number[]>>(BAGS_KEY, {});
  }

  setPrefs(next: Partial<NovaPrefs>) {
    this.prefs = { ...this.prefs, ...next };
    writeJson(PREFS_KEY, this.prefs);
    if (!this.prefs.voice) this.speaker.stopSpeech();
  }

  /** How often optional chatter should fire, scaled by the player's setting. */
  chance(p: number): boolean {
    const scale = this.prefs.chatter === 'lots' ? 1 : this.prefs.chatter === 'some' ? 0.45 : 0;
    return Math.random() < p * scale;
  }

  get speaking(): boolean {
    return this.current !== null;
  }

  /** Points Nova at a stage, drawing her face into it the first time. */
  attach(stage: HTMLElement) {
    if (this.stage !== stage) this.stop();
    this.stage = stage;
    const pfp = stage.querySelector<HTMLElement>('.nova-pfp');
    if (pfp && !pfp.firstElementChild) pfp.innerHTML = novaFaceSvg(128);
    this.face = pfp?.querySelector('svg') ?? null;
  }

  /** Says the next line from a category. Resolves when she has finished (or
   *  was cut off, or decided not to speak). */
  async say(category: LineCategory, opts: SayOptions = {}): Promise<void> {
    const priority = opts.priority ?? 1;
    if (!this.stage) return;
    if (this.prefs.chatter === 'off' && priority < 3) return;
    const now = performance.now();
    if (this.current) {
      // Only something more important cuts her off mid-sentence.
      if (priority <= this.current.priority) return;
    } else if (priority < 2 && now < this.quietUntil) {
      return;
    }

    const lines = LINES[category];
    let index = opts.index ?? -1;
    if (index < 0) {
      const drawn = drawFromBag(this.bags[category], lines.length, this.last[category]);
      index = drawn.index;
      this.bags[category] = drawn.bag;
      this.scheduleSave();
    }
    this.last[category] = index;
    const raw = lines[index];
    const text = displayText(raw);

    this.stopVisuals();
    this.speaker.stopSpeech();
    const token = ++this.token;
    this.current = { priority, token };

    const stage = this.stage;
    const textEl = stage.querySelector<HTMLElement>('.nova-text');
    stage.classList.add('nova-live');
    stage.classList.remove('nova-quiet');
    this.setExpression(expressionFor(raw));

    const voiced = this.prefs.voice && hasClip(category, index);
    const duration = voiced ? await this.speaker.speak(audioPath(category, index)) : null;
    if (token !== this.token) return;
    const seconds = duration ?? Math.min(6, 1.2 + text.length * 0.055);
    this.typeOut(textEl, text, Math.min(seconds * 0.8, text.length * 0.032));
    this.animate(duration !== null, seconds);

    await new Promise<void>((resolve) => {
      this.hideTimer = window.setTimeout(resolve, seconds * 1000 + 250);
    });
    if (token !== this.token) return;
    this.current = null;
    this.quietUntil = performance.now() + GAP_MS;
    this.face?.classList.remove('talking');
    this.setExpression('happy');
    if (!opts.persist) {
      this.hideTimer = window.setTimeout(() => {
        if (token === this.token) stage.classList.add('nova-quiet');
      }, 1300);
    }
  }

  /** Cuts her off and clears the stage. */
  stop() {
    this.token++;
    this.current = null;
    this.speaker.stopSpeech();
    this.stopVisuals();
    this.stage?.classList.add('nova-quiet');
  }

  private stopVisuals() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.hideTimer);
    clearInterval(this.typeTimer);
    this.face?.classList.remove('talking');
    this.face?.style.setProperty('--mouth', '0');
  }

  private setExpression(ex: string) {
    if (!this.face) return;
    this.face.classList.remove('ex-happy', 'ex-smug', 'ex-surprised', 'ex-laugh', 'ex-nervous');
    this.face.classList.add(`ex-${ex}`);
  }

  /** Typewriter reveal: the words arrive at roughly the pace she says them. */
  private typeOut(el: HTMLElement | null, text: string, seconds: number) {
    if (!el) return;
    clearInterval(this.typeTimer);
    if (seconds <= 0.05 || document.documentElement.classList.contains('reduce-motion')) {
      el.textContent = text;
      return;
    }
    const start = performance.now();
    el.textContent = '';
    this.typeTimer = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / (seconds * 1000));
      el.textContent = text.slice(0, Math.ceil(text.length * t));
      if (t >= 1) clearInterval(this.typeTimer);
    }, 30);
  }

  /** Mouth and bob. With a voice the mouth follows the real loudness; without
   *  one it flaps to a syllable-ish rhythm for as long as the text would take
   *  to say. */
  private animate(fromAudio: boolean, seconds: number) {
    const face = this.face;
    if (!face) return;
    face.classList.add('talking');
    const start = performance.now();
    let smooth = 0;
    const step = (now: number) => {
      const t = (now - start) / 1000;
      if (t > seconds + 0.1) {
        face.classList.remove('talking');
        face.style.setProperty('--mouth', '0');
        return;
      }
      let level: number;
      if (fromAudio) {
        level = this.speaker.speechLevel();
      } else {
        const syllable = Math.max(0, Math.sin(t * Math.PI * 2 * 4.6));
        const phrase = 0.55 + 0.45 * Math.sin(t * Math.PI * 2 * 0.9);
        level = t < seconds - 0.15 ? syllable * phrase : 0;
      }
      // Opens fast, closes a little slower — reads as speech, not flicker.
      smooth += (level - smooth) * (level > smooth ? 0.6 : 0.3);
      face.style.setProperty('--mouth', smooth.toFixed(3));
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => writeJson(BAGS_KEY, this.bags), 800);
  }
}
