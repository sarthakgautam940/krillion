// Every sound is synthesized with Web Audio, so there are no audio files to load.

const SCALE = [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98, 2093.0];

export class Sound {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.ctx = null;
  }

  /** Browsers only allow audio after a tap or key press, so call this from one. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const comp = this.ctx.createDynamicsCompressor();
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.55;
      this.out.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  get ready() {
    return this.enabled && this.ctx;
  }

  tone({ type = 'sine', f = 440, to = 0, at = 0, dur = 0.2, vol = 0.15, attack = 0.006 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  noise({ at = 0, dur = 0.3, vol = 0.2, filter = 'lowpass', f = 1200, to = 0, q = 0.8, attack = 0.012 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource();
    const flt = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    src.buffer = this.noiseBuf;
    flt.type = filter;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f, t);
    if (to) flt.frequency.exponentialRampToValueAtTime(to, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, attack + 0.02));
    src.connect(flt).connect(gain).connect(this.out);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  tick(urgent) {
    this.tone({ type: 'square', f: urgent ? 1480 : 1180, dur: 0.035, vol: urgent ? 0.07 : 0.045 });
  }

  turn() {
    this.tone({ type: 'sine', f: 520, to: 780, dur: 0.12, vol: 0.09 });
  }

  correct(rank) {
    const notes = Math.min(SCALE.length, rank + 2);
    for (let i = 0; i < notes; i++) {
      this.tone({ type: 'triangle', f: SCALE[i], at: i * 0.055, dur: 0.22 + i * 0.03, vol: 0.13 });
    }
    if (rank >= 4) this.noise({ at: 0.05, dur: 0.5, vol: 0.06, filter: 'highpass', f: 5000 });
    if (rank >= 5) this.tone({ type: 'sine', f: 130, to: 60, dur: 0.35, vol: 0.25 });
  }

  wrong() {
    this.tone({ type: 'square', f: 196, dur: 0.09, vol: 0.06 });
    this.tone({ type: 'square', f: 147, at: 0.1, dur: 0.14, vol: 0.06 });
  }

  timeout() {
    this.tone({ type: 'sawtooth', f: 330, to: 82, dur: 0.5, vol: 0.09 });
    this.noise({ dur: 0.25, vol: 0.16, filter: 'highpass', f: 1800 });
    this.tone({ type: 'sine', f: 150, to: 45, at: 0.05, dur: 0.4, vol: 0.3 });
  }

  roundEnd() {
    [392, 523.25, 659.25].forEach((f, i) => this.tone({ type: 'triangle', f, at: i * 0.09, dur: 0.3, vol: 0.1 }));
  }

  fanfare() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone({ type: 'triangle', f, at: i * 0.13, dur: 0.5, vol: 0.12 }));
    [261.63, 329.63, 392].forEach((f) => this.tone({ type: 'sawtooth', f, at: 0.52, dur: 1.1, vol: 0.035 }));
  }

  /** Time slowing down: a falling tape-stop drone, two heartbeats and a swell into the hit. */
  slowmo(seconds) {
    this.tone({ type: 'sawtooth', f: 240, to: 28, dur: seconds, vol: 0.07, attack: 0.02 });
    this.tone({ type: 'sine', f: 95, to: 38, dur: 0.38, vol: 0.5 });
    this.tone({ type: 'sine', f: 85, to: 34, at: seconds * 0.48, dur: 0.34, vol: 0.42 });
    this.noise({ dur: seconds + 0.05, vol: 0.22, filter: 'bandpass', f: 180, to: 5200, q: 1.1, attack: seconds * 0.95 });
  }

  insaneImpact() {
    this.tone({ type: 'sine', f: 140, to: 32, dur: 0.7, vol: 0.55 });
    this.noise({ dur: 0.8, vol: 0.4, f: 4000, to: 180 });
  }

  insaneRiser(seconds) {
    this.tone({ type: 'sawtooth', f: 110, to: 880, dur: seconds, vol: 0.06, attack: seconds * 0.8 });
    this.tone({ type: 'square', f: 220, to: 1760, dur: seconds, vol: 0.025, attack: seconds * 0.8 });
    this.noise({ dur: seconds, vol: 0.14, filter: 'bandpass', f: 300, to: 6000, q: 1.4 });
  }

  insaneBurst() {
    this.tone({ type: 'sine', f: 110, to: 28, dur: 1.1, vol: 0.6 });
    this.noise({ dur: 1.4, vol: 0.5, f: 7000, to: 140 });
    [220, 277.18, 329.63, 440].forEach((f) => this.tone({ type: 'sawtooth', f, at: 0.04, dur: 1.4, vol: 0.05 }));
    [1760, 2217.46, 2637.02, 3520].forEach((f, i) => this.tone({ type: 'triangle', f, at: 0.25 + i * 0.07, dur: 0.5, vol: 0.05 }));
  }
}
