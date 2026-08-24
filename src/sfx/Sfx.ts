/** Small synthesized sound effects via Web Audio — no external audio assets needed. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  private ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.4;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** Call on first user gesture to unlock audio on mobile browsers. */
  unlock() {
    this.ensure();
  }

  private tone(freq: number, duration: number, type: OscillatorType, gainStart: number, delay = 0) {
    if (this.muted) return;
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
    gain.connect(this.master!);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  /** Plays a frequency contour (in Hz) smoothly interpolated across `duration` seconds — used for soft sweeps. */
  private curveTone(freqPoints: number[], duration: number, type: OscillatorType, gainStart: number, delay = 0) {
    if (this.muted) return;
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
    gain.connect(this.master!);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  private noiseBurst(duration: number, gainStart: number, delay = 0, filterFreq = 900) {
    if (this.muted) return;
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
    gain.connect(this.master!);
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

export const sfx = new Sfx();
