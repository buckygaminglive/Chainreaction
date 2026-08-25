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

  get muted() {
    return this._muted;
  }
  set muted(value: boolean) {
    this._muted = value;
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
      this.fxBus.connect(this.master);
      this.musicBus.connect(this.master);
      this.master.connect(this.ctx.destination);
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
    this.fxBus.gain.setTargetAtTime(0.8, t, 0.02);
    // Slow ramp: a bed that jumps level is more noticeable than the bed itself.
    this.musicBus.gain.setTargetAtTime(this._musicVolume * this.duck, t, 0.4);
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
    if (!this.bedWanted || this._musicVolume <= 0) return;
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

  // ---------- Effects ----------
  private tone(freq: number, duration: number, type: OscillatorType, gainStart: number, delay = 0) {
    if (this._muted) return;
    const ctx = this.ensure();
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(gainStart, t0 + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(this.fxBus!);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  /** Plays a frequency contour (in Hz) smoothly interpolated across `duration` seconds — used for soft sweeps. */
  private curveTone(freqPoints: number[], duration: number, type: OscillatorType, gainStart: number, delay = 0) {
    if (this._muted) return;
    const ctx = this.ensure();
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueCurveAtTime(new Float32Array(freqPoints), t0, duration);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(gainStart, t0 + Math.min(0.05, duration * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(this.fxBus!);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  private noiseBurst(duration: number, gainStart: number, delay = 0, filterFreq = 900) {
    if (this._muted) return;
    const ctx = this.ensure();
    const t0 = ctx.currentTime + delay;
    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(gainStart, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.fxBus!);
    src.start(t0);
  }

  place() {
    this.tone(560, 0.13, 'sine', 0.2);
    this.tone(820, 0.1, 'sine', 0.1, 0.035);
  }

  /** Rising whir during the pre-blast spin-up — plays *before* explode().
   *  Starts higher the deeper into a chain it is, so the cascade audibly
   *  climbs instead of repeating one note. */
  chargeUp(depth = 0) {
    const lift = 1 + Math.min(depth, 10) * 0.07;
    this.curveTone([260 * lift, 520 * lift, 780 * lift], 0.19, 'sawtooth', 0.09);
  }

  explode(strength = 1, depth = 0) {
    // Slight random pitch variance so a long cascade of hits doesn't sound
    // like the same sample looping, over a floor that rises with chain depth.
    const lift = 1 + Math.min(depth, 10) * 0.05;
    const pitch = (0.88 + Math.random() * 0.24) * lift;
    this.curveTone([220 * pitch, 95 * pitch], 0.3, 'sine', 0.24 * strength);
    this.noiseBurst(0.2, 0.14 * strength, 0, 800 * pitch);
  }

  /** Short bright ping layered on top of a blast once a chain gets long
   *  enough to be worth calling out — the audio half of the chain counter. */
  chainTick(depth: number) {
    const step = Math.min(depth, 12);
    this.tone(660 * Math.pow(1.06, step), 0.1, 'triangle', 0.13);
  }

  eliminate() {
    this.curveTone([320, 150], 0.34, 'sine', 0.18);
  }

  turnChange() {
    this.tone(460, 0.09, 'sine', 0.1);
  }

  /** One clock tick per second in the last few seconds of a Blitz turn. */
  clockTick(urgent = false) {
    this.tone(urgent ? 980 : 700, 0.05, 'square', urgent ? 0.09 : 0.05);
  }

  win() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this.tone(f, 0.4, 'sine', 0.24, i * 0.11));
  }

  buttonTap() {
    this.tone(600, 0.06, 'sine', 0.13);
  }
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export const sfx = new Sfx();
