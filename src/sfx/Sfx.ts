/** Small synthesized sound effects via Web Audio — no external audio assets needed.
 *
 *  Two buses hang off the master gain rather than one: effects and the ambient
 *  bed have to be mixable against each other, and a player who wants the room
 *  tone without the explosions (or the reverse) has no way to say so if they
 *  share a fader. */
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
  private bed: { nodes: AudioScheduledSourceNode[]; gain: GainNode } | null = null;

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

  /** Ambient bed level relative to master, 0–1. Zero stops it outright rather
   *  than leaving three oscillators running into a silent gain node. */
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

  // ---------- Ambient bed ----------
  /** A low drone and its fifth under a slowly sweeping lowpass. Three
   *  oscillators and a filter — no asset, no bundle cost, and nothing to
   *  loop-seam. §6 asks for restrained background music; this is the most
   *  restrained thing that still stops a screen being silent. */
  startBed() {
    this.bedWanted = true;
    // Deliberately not ensure(): building an AudioContext before a user
    // gesture only earns an autoplay warning and a suspended context. The bed
    // comes up on the first unlock() like everything else.
    this.tryStartBed();
  }

  stopBed() {
    this.bedWanted = false;
    this.teardownBed();
  }

  /** 'menu' lets the bed sit forward; 'match' pushes it under the effects. */
  setBedMood(mood: 'menu' | 'match') {
    this.duck = mood === 'match' ? 0.45 : 1;
    this.applyGains();
  }

  private tryStartBed() {
    if (!this.bedWanted || this.bed || this._musicVolume <= 0) return;
    if (!this.ctx || !this.musicBus || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(0.09, t0 + 3.5);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 260;
    filter.Q.value = 0.7;
    filter.connect(gain);
    gain.connect(this.musicBus);

    // A1, its fifth, and a barely-there octave for air.
    const voices: [number, OscillatorType, number][] = [
      [55, 'sine', 0.5],
      [82.41, 'sine', 0.3],
      [110, 'triangle', 0.1],
    ];
    const nodes: AudioScheduledSourceNode[] = [];
    voices.forEach(([freq, type, level], i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      // A few cents apart so the voices beat against each other instead of
      // phase-locking into one flat tone.
      osc.detune.value = (i - 1) * 5;
      const vg = ctx.createGain();
      vg.gain.value = level;
      osc.connect(vg);
      vg.connect(filter);
      osc.start(t0);
      nodes.push(osc);
    });

    // ~40s round trip on the filter — slow enough that it reads as the room
    // breathing rather than as an effect.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.025;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 130;
    lfo.connect(lfoDepth);
    lfoDepth.connect(filter.frequency);
    lfo.start(t0);
    nodes.push(lfo);

    this.bed = { nodes, gain };
  }

  private teardownBed() {
    if (!this.bed || !this.ctx) return;
    const { nodes, gain } = this.bed;
    this.bed = null;
    const t = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0.0001, t + 0.6);
    for (const node of nodes) {
      try {
        node.stop(t + 0.7);
      } catch {
        /* already stopped */
      }
    }
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
