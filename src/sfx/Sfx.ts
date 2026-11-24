/** Sound effects are synthesized via Web Audio — no assets. The background
 *  track is the one exception (public/audio/quantum-lab-protocol.mp3),
 *  streamed through the same graph rather than a bare <audio> tag so it
 *  shares the mute switch, the volume sliders and the in-match duck with
 *  everything else here.
 *
 *  Two buses hang off the master gain rather than one: effects and the music
 *  have to be mixable against each other, and a player who wants the track
 *  without the explosions (or the reverse) has no way to say so if they share
 *  a fader. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private fxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;

  private _muted = false;
  private _volume = 0.8;
  private _musicVolume = 0.5;
  /** Pulled down while a match is on: the bed is there to keep a screen from
   *  being silent, not to play over the game. */
  private duck = 1;

  private bedWanted = false;
  /** Built once, lazily, on the first attempt to play it — an <audio> element
   *  can only ever be handed to createMediaElementSource one time, so unlike
   *  the old oscillator bed this graph is created once and started/stopped
   *  rather than torn down and rebuilt on every play. */
  private musicEl: HTMLAudioElement | null = null;
  private musicGain: GainNode | null = null;
  /** Shared white-noise source for every burst. */
  private noise: AudioBuffer | null = null;
  /** True while the app is backgrounded — nothing sounds until resume(). */
  private suspended = false;

  /** Nova's lines: decoded clips played through their own bus, metered so her
   *  portrait can move its mouth to the actual loudness of the voice. */
  private speechBus: GainNode | null = null;
  private speechMeter: AnalyserNode | null = null;
  private speechSource: AudioBufferSourceNode | null = null;
  private speechClips = new Map<string, Promise<AudioBuffer | null>>();
  private meterBuf: Float32Array<ArrayBuffer> | null = null;
  /** Music dips under speech the way it dips under a match. */
  private speechDuck = 1;

  get muted() {
    return this._muted;
  }
  set muted(value: boolean) {
    this._muted = value;
    if (value) this.stopSpeech();
    this.applyGains();
  }

  /** Game sound effects on their own (orbs, blasts, buttons), separate from
   *  the music and Nova's voice. */
  private _fxMuted = false;
  get fxMuted() {
    return this._fxMuted;
  }
  set fxMuted(value: boolean) {
    this._fxMuted = value;
    this.applyGains();
  }

  /** The music bed on its own. Muting keeps it loaded, so turning it back on
   *  is instant. */
  private _musicMuted = false;
  get musicMuted() {
    return this._musicMuted;
  }
  set musicMuted(value: boolean) {
    this._musicMuted = value;
    this.applyGains();
  }

  /** Master level, 0–1. */
  get volume() {
    return this._volume;
  }
  set volume(value: number) {
    this._volume = clamp01(value);
    this.applyGains();
  }

  /** Music level relative to master, 0–1. Zero pauses playback outright
   *  rather than leaving the track running into a silent gain node. */
  get musicVolume() {
    return this._musicVolume;
  }
  set musicVolume(value: number) {
    this._musicVolume = clamp01(value);
    this.applyGains();
    if (this._musicVolume <= 0) this.teardownBed();
    else this.tryStartBed();
  }

  private ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.fxBus = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      // A limiter on the way out. A wide wave detonates a dozen voices in the
      // same instant, and summed raw they clip into a harsh crackle on phone
      // speakers — exactly at the moment that should sound best.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 8;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.18;
      this.fxBus.connect(this.master);
      this.musicBus.connect(this.master);
      this.master.connect(limiter);
      limiter.connect(this.ctx.destination);
      this.applyGains();
    }
    if (this.ctx.state === 'suspended') {
      // Autoplay policy: nothing sounds until a gesture has resumed the
      // context, so the bed has to be (re)started on the far side of it
      // rather than at the moment something asked for it.
      void this.ctx.resume().then(() => this.tryStartBed());
    } else {
      this.tryStartBed();
    }
    return this.ctx;
  }

  /** Call on first user gesture to unlock audio on mobile browsers. */
  unlock() {
    this.ensure();
  }

  private applyGains() {
    if (!this.ctx || !this.master || !this.musicBus || !this.fxBus) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this._muted ? 0 : 0.5 * this._volume, t, 0.02);
    this.fxBus.gain.setTargetAtTime(this._fxMuted ? 0 : 0.8, t, 0.02);
    // Slow ramp: a bed that jumps level is more noticeable than the bed itself.
    this.musicBus.gain.setTargetAtTime(this._musicMuted ? 0 : this._musicVolume * this.duck * this.speechDuck, t, this._musicMuted ? 0.05 : 0.4);
  }

  // ---------- Speech ----------
  private ensureSpeechGraph(ctx: AudioContext) {
    if (this.speechBus || !this.master) return;
    this.speechBus = ctx.createGain();
    this.speechBus.gain.value = 1.15;
    this.speechMeter = ctx.createAnalyser();
    this.speechMeter.fftSize = 512;
    this.speechMeter.smoothingTimeConstant = 0.2;
    this.speechMeter.connect(this.speechBus);
    this.speechBus.connect(this.master);
  }

  /** Fetched and decoded once per clip; a repeat play comes from memory. A
   *  missing or undecodable file resolves to null, never throws. */
  private speechClip(ctx: AudioContext, url: string): Promise<AudioBuffer | null> {
    let clip = this.speechClips.get(url);
    if (!clip) {
      clip = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((data) => ctx.decodeAudioData(data))
        .catch(() => null);
      this.speechClips.set(url, clip);
      // Bounded: a long session would otherwise end up holding every line.
      if (this.speechClips.size > 48) {
        const oldest = this.speechClips.keys().next().value;
        if (oldest !== undefined) this.speechClips.delete(oldest);
      }
    }
    return clip;
  }

  /** Plays one spoken line. Resolves with its length in seconds, or null when
   *  it cannot be heard — muted, backgrounded, audio still locked, or no clip
   *  for this line — so the caller can fall back to timing the text. */
  async speak(url: string): Promise<number | null> {
    if (this._muted || this.suspended) return null;
    const ctx = this.ensure();
    this.ensureSpeechGraph(ctx);
    const buf = await this.speechClip(ctx, url);
    if (!buf || this._muted || this.suspended || ctx.state !== 'running' || !this.speechMeter) return null;
    this.stopSpeech();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.speechMeter);
    src.onended = () => {
      if (this.speechSource !== src) return;
      this.speechSource = null;
      this.setSpeechDuck(false);
    };
    this.speechSource = src;
    this.setSpeechDuck(true);
    src.start();
    return buf.duration;
  }

  stopSpeech() {
    const src = this.speechSource;
    if (!src) return;
    this.speechSource = null;
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
    this.setSpeechDuck(false);
  }

  /** Loudness of the line playing now, 0–1. Zero when nothing is speaking. */
  speechLevel(): number {
    if (!this.speechSource || !this.speechMeter) return 0;
    if (!this.meterBuf) this.meterBuf = new Float32Array(new ArrayBuffer(this.speechMeter.fftSize * 4));
    this.speechMeter.getFloatTimeDomainData(this.meterBuf);
    let sum = 0;
    for (const v of this.meterBuf) sum += v * v;
    const rms = Math.sqrt(sum / this.meterBuf.length);
    // Clips are levelled to about -16 LUFS; this maps a quiet syllable to a
    // small opening and a stressed one to full, with a gate for breaths.
    return Math.min(1, Math.max(0, rms * 3.4 - 0.06));
  }

  private setSpeechDuck(on: boolean) {
    this.speechDuck = on ? 0.4 : 1;
    this.applyGains();
  }

  // ---------- Background music ----------
  /** §6 asks for restrained background music. `startBed`/`stopBed` are the
   *  same two calls the old synthesized drone answered to — main.ts starts
   *  the track once at boot and never has to know what changed. */
  startBed() {
    this.bedWanted = true;
    // Deliberately not ensure(): building an AudioContext before a user
    // gesture only earns an autoplay warning and a suspended context. The
    // track comes up on the first unlock() like everything else.
    this.tryStartBed();
  }

  stopBed() {
    this.bedWanted = false;
    this.teardownBed();
  }

  /** 'menu' lets the track sit forward; 'match' pushes it under the effects. */
  setBedMood(mood: 'menu' | 'match') {
    this.duck = mood === 'match' ? 0.45 : 1;
    this.applyGains();
  }

  /** Builds the <audio> element and routes it into musicBus exactly once.
   *  `createMediaElementSource` throws if called twice on the same element,
   *  so the graph is assembled lazily on first use and reused after that —
   *  starting and stopping the track from here on is play()/pause(), not a
   *  rebuild. */
  private ensureMusicGraph() {
    if (this.musicEl || !this.ctx || !this.musicBus) return;
    const el = new Audio('/audio/quantum-lab-protocol.mp3');
    el.loop = true;
    // Nothing about the title screen should wait on a 5MB download — the
    // element only starts fetching once a match is actually wanted to play,
    // via the explicit load() in tryStartBed.
    el.preload = 'none';
    const source = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(this.musicBus);
    this.musicEl = el;
    this.musicGain = gain;
  }

  private tryStartBed() {
    if (!this.bedWanted || this._musicVolume <= 0 || this.suspended) return;
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.ensureMusicGraph();
    if (!this.musicEl || !this.musicGain || !this.ctx) return;
    if (!this.musicEl.paused) return; // already playing — nothing to do

    const t0 = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(t0);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, t0);
    this.musicGain.gain.linearRampToValueAtTime(1, t0 + 2.2);
    if (this.musicEl.readyState === 0) this.musicEl.load();
    // Blocked without a gesture on some browsers — unlock() calls back in on
    // every button tap until one lands, so a rejection here is not an error.
    void this.musicEl.play().catch(() => {});
  }

  private teardownBed() {
    if (!this.musicEl || !this.musicGain || !this.ctx) return;
    const el = this.musicEl;
    const t = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(t);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, t);
    this.musicGain.gain.linearRampToValueAtTime(0, t + 0.6);
    setTimeout(() => el.pause(), 650);
  }

  // ---------- Lifecycle ----------
  /** The app went to the background (or the tab was hidden). Everything goes
   *  quiet at once — an installed game that keeps playing music from a
   *  locked phone gets uninstalled. */
  suspend() {
    this.suspended = true;
    this.stopSpeech();
    if (this.musicEl && !this.musicEl.paused) this.musicEl.pause();
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => {});
  }

  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().then(() => this.tryStartBed()).catch(() => {});
    } else {
      this.tryStartBed();
    }
  }

  // ---------- Effects ----------
  private voice(
    freq: number | number[],
    duration: number,
    type: OscillatorType,
    gainStart: number,
    opts: { delay?: number; attack?: number; detune?: number; pan?: number } = {}
  ) {
    if (this._muted || this.suspended) return;
    const ctx = this.ensure();
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    if (Array.isArray(freq)) osc.frequency.setValueCurveAtTime(new Float32Array(freq), t0, duration);
    else osc.frequency.setValueAtTime(freq, t0);
    if (opts.detune) osc.detune.setValueAtTime(opts.detune, t0);
    const attack = opts.attack ?? Math.min(0.012, duration * 0.2);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(gainStart, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    let out: AudioNode = gain;
    if (opts.pan && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, opts.pan)), t0);
      gain.connect(panner);
      out = panner;
    }
    out.connect(this.fxBus!);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  }

  private tone(freq: number, duration: number, type: OscillatorType, gainStart: number, delay = 0) {
    this.voice(freq, duration, type, gainStart, { delay });
  }

  private curveTone(freqPoints: number[], duration: number, type: OscillatorType, gainStart: number, delay = 0) {
    this.voice(freqPoints, duration, type, gainStart, { delay, attack: Math.min(0.05, duration * 0.3) });
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise && this.noise.sampleRate === ctx.sampleRate) return this.noise;
    // One second of white noise, made once and sliced by every burst — a
    // fresh buffer per explosion was the most expensive line in a cascade.
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buffer;
    return buffer;
  }

  private noiseBurst(duration: number, gainStart: number, delay = 0, filterFreq = 900, type: BiquadFilterType = 'lowpass') {
    if (this._muted || this.suspended) return;
    const ctx = this.ensure();
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterFreq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(gainStart, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.fxBus!);
    src.start(t0, Math.random() * 0.5, duration + 0.05);
  }

  /** Placing an orb: a soft "bloop" that rises with how full the cell is, so
   *  loading a cell towards critical audibly builds tension. `fill` is 0–1. */
  place(fill = 0.33) {
    const base = 300 + fill * 360;
    this.curveTone([base * 0.7, base * 1.25, base], 0.14, 'sine', 0.22);
    this.tone(base * 2, 0.06, 'triangle', 0.05, 0.01);
  }

  /** Rising whir during the pre-blast spin-up — plays *before* explode(). */
  chargeUp(depth = 0) {
    const lift = 1 + Math.min(depth, 10) * 0.07;
    this.curveTone([240 * lift, 480 * lift, 720 * lift], 0.12, 'sawtooth', 0.045);
  }

  /** One wave of a cascade detonating. The pitch climbs a pentatonic scale
   *  with chain depth, so a long chain plays a little rising melody instead
   *  of the same thud on repeat — the single biggest thing that makes a big
   *  cascade *feel* big. `cells` is how many blew in this wave. */
  explode(strength = 1, depth = 0, cells = 1) {
    const step = Math.min(depth, PENTATONIC.length - 1);
    const note = PENTATONIC[step];
    const width = Math.min(1.4, 1 + (cells - 1) * 0.06);
    const pan = (Math.random() - 0.5) * 0.5;
    // Body: a pitched pluck on the scale degree.
    this.voice(note, 0.32, 'triangle', 0.16 * strength, { pan });
    this.voice(note * 2, 0.18, 'sine', 0.06 * strength, { pan, detune: 6 });
    // Punch: a falling sub thump.
    this.curveTone([150, 55], 0.22, 'sine', 0.3 * strength * width);
    // Crack: filtered noise, brighter deeper into the chain.
    this.noiseBurst(0.16, 0.16 * strength * width, 0, 1200 + step * 160);
  }

  /** A cell changing hands — a quick upward zip. */
  capture() {
    this.curveTone([520, 1040], 0.09, 'square', 0.035);
  }

  /** Short bright ping layered on a blast once a chain is worth calling out. */
  chainTick(depth: number) {
    const step = Math.min(depth, PENTATONIC.length - 1);
    this.tone(PENTATONIC[step] * 2, 0.12, 'triangle', 0.09);
  }

  /** The chain just crossed a milestone (×5, ×8, ×12…): a bright chord stab. */
  combo(level: number) {
    const root = 392 * Math.pow(1.122, Math.min(level, 6));
    [1, 1.26, 1.5, 2].forEach((ratio, i) => {
      this.voice(root * ratio, 0.5, 'sawtooth', 0.045, { delay: i * 0.018, detune: (i - 1.5) * 8 });
      this.voice(root * ratio, 0.5, 'triangle', 0.06, { delay: i * 0.018 });
    });
    this.noiseBurst(0.35, 0.05, 0, 4000, 'highpass');
  }

  eliminate() {
    this.curveTone([420, 180, 90], 0.5, 'sawtooth', 0.07);
    this.curveTone([320, 140], 0.4, 'sine', 0.16);
  }

  turnChange() {
    this.tone(660, 0.07, 'sine', 0.06);
    this.tone(880, 0.06, 'sine', 0.04, 0.05);
  }

  /** One clock tick per second in the last few seconds of a Blitz turn. */
  clockTick(urgent = false) {
    this.tone(urgent ? 980 : 700, 0.05, 'square', urgent ? 0.09 : 0.05);
  }

  win() {
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => {
      this.voice(f, 0.45, 'triangle', 0.18, { delay: i * 0.09 });
      this.voice(f * 2, 0.3, 'sine', 0.05, { delay: i * 0.09 });
    });
    this.voice([1046.5, 1568], 0.9, 'sine', 0.12, { delay: 0.48 });
  }

  lose() {
    [392, 349.2, 311.1, 261.6].forEach((f, i) => this.voice(f, 0.4, 'triangle', 0.14, { delay: i * 0.13 }));
  }

  buttonTap() {
    this.curveTone([520, 760], 0.05, 'sine', 0.1);
  }
}

/** C major pentatonic from C4 up three octaves — every step sounds good next
 *  to every other, so a cascade of any length is always in tune. */
const PENTATONIC = [
  261.63, 293.66, 329.63, 392.0, 440.0,
  523.25, 587.33, 659.25, 783.99, 880.0,
  1046.5, 1174.66, 1318.51, 1567.98, 1760.0,
];

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export const sfx = new Sfx();
