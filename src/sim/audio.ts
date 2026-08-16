/**
 * The JIMU control box has no speaker — in the real app the phone makes the
 * noise. Same here: everything is synthesised with WebAudio, no asset files,
 * which also keeps the single-file build self-contained.
 */

export type SoundName = 'horn' | 'siren' | 'chirp' | 'laser' | 'beep' | 'grab' | 'drop' | 'error' | 'win';

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  enabled = true;
  /** Continuous servo whine while the treads turn. */
  private motor: { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.setMotorLoad(0);
      if (this.master) this.master.gain.value = 0;
    } else if (this.master) {
      this.master.gain.value = 0.32;
    }
  }

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType = 'square',
    vol = 0.3,
    slideTo?: number,
    delay = 0,
  ): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  play(name: SoundName): void {
    switch (name) {
      case 'horn':
        this.tone(233, 0.34, 'sawtooth', 0.28);
        this.tone(311, 0.34, 'sawtooth', 0.22);
        break;
      case 'siren':
        for (let i = 0; i < 3; i++) {
          this.tone(660, 0.22, 'square', 0.2, 990, i * 0.24);
          this.tone(990, 0.22, 'square', 0.2, 660, i * 0.24 + 0.12);
        }
        break;
      case 'chirp':
        this.tone(1200, 0.09, 'sine', 0.26, 2100);
        this.tone(1800, 0.08, 'sine', 0.2, 2600, 0.09);
        break;
      case 'laser':
        this.tone(1900, 0.26, 'sawtooth', 0.22, 180);
        break;
      case 'beep':
        this.tone(880, 0.09, 'square', 0.22);
        break;
      case 'grab':
        this.tone(180, 0.13, 'square', 0.26, 90);
        this.tone(520, 0.07, 'sine', 0.16, 700, 0.05);
        break;
      case 'drop':
        this.tone(340, 0.15, 'triangle', 0.24, 120);
        break;
      case 'error':
        this.tone(200, 0.18, 'square', 0.26);
        this.tone(150, 0.22, 'square', 0.26, 90, 0.16);
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.24, 'triangle', 0.26, undefined, i * 0.11));
        break;
    }
  }

  /** `load` is 0..1 — how hard the treads are working right now. */
  setMotorLoad(load: number): void {
    const ctx = this.enabled ? this.ensure() : this.ctx;
    if (!ctx || !this.master) return;

    if (load <= 0.001) {
      if (this.motor) {
        this.motor.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
        const m = this.motor;
        this.motor = null;
        setTimeout(() => { try { m.osc.stop(); } catch { /* already stopped */ } }, 260);
      }
      return;
    }
    if (!this.enabled) return;

    if (!this.motor) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      osc.type = 'sawtooth';
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      gain.gain.value = 0.0001;
      osc.connect(filter).connect(gain).connect(this.master);
      osc.start();
      this.motor = { osc, gain, filter };
    }
    const t = ctx.currentTime;
    this.motor.osc.frequency.setTargetAtTime(58 + load * 115, t, 0.06);
    this.motor.gain.gain.setTargetAtTime(0.028 + load * 0.05, t, 0.06);
  }
}

export const audio = new AudioEngine();
