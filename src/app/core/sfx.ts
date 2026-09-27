// UI sounds synthesised with Web Audio (no audio files to download): clicks,
// section changes, trim marks, job start, success and error. Volume and on/off
// are remembered in localStorage.
import { Injectable, signal } from '@angular/core';

type Tone = {
  freq: number;
  to?: number;
  at: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
};

const KEY = 'mc.sound';
const VOLUME_KEY = 'mc.sfx-volume';

@Injectable({ providedIn: 'root' })
export class Sfx {
  private ctx: AudioContext | null = null;
  readonly enabled = signal(true);
  /** Master volume for effects, 0–1. */
  readonly volume = signal(0.8);

  constructor() {
    try {
      this.enabled.set(globalThis.localStorage?.getItem(KEY) !== 'off');
      const v = Number(globalThis.localStorage?.getItem(VOLUME_KEY));
      if (globalThis.localStorage?.getItem(VOLUME_KEY) !== null && Number.isFinite(v)) this.volume.set(v);
    } catch {
      /* storage blocked: keep sounds on */
    }
  }

  /** Sets the effects volume (0–1) and plays a sample click. */
  setVolume(value: number): void {
    this.volume.set(Math.max(0, Math.min(1, value)));
    try {
      localStorage.setItem(VOLUME_KEY, String(this.volume()));
    } catch {
      /* ignore */
    }
    this.click();
  }

  /** Turns sounds on/off. */
  toggle(): void {
    this.enabled.update((v) => !v);
    try {
      localStorage.setItem(KEY, this.enabled() ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (this.enabled()) this.click();
  }

  /** Short tick for any control. */
  click(): void {
    this.play([{ freq: 1900, to: 1100, at: 0, dur: 0.035, type: 'square', gain: 0.025 }]);
  }

  /** Two-note chirp when changing section. */
  tab(): void {
    this.play([
      { freq: 520, at: 0, dur: 0.05, type: 'triangle', gain: 0.06 },
      { freq: 780, at: 0.045, dur: 0.07, type: 'triangle', gain: 0.05 },
    ]);
  }

  /** Short percussive tick: timeline marks and trim handles. */
  snip(): void {
    this.play([
      { freq: 2600, to: 900, at: 0, dur: 0.03, type: 'square', gain: 0.03 },
      { freq: 180, at: 0, dur: 0.05, type: 'sine', gain: 0.08 },
    ]);
    this.noise(0.04, 0.05, 4000);
  }

  /** Whoosh when a job starts. */
  start(): void {
    this.noise(0.25, 0.04, 1200, 6000);
    this.play([{ freq: 330, to: 660, at: 0, dur: 0.2, type: 'sine', gain: 0.05 }]);
  }

  /** Rising arpeggio when something finishes. */
  success(): void {
    this.play([
      { freq: 523, at: 0, dur: 0.09, type: 'triangle', gain: 0.07 },
      { freq: 659, at: 0.08, dur: 0.09, type: 'triangle', gain: 0.07 },
      { freq: 988, at: 0.16, dur: 0.22, type: 'triangle', gain: 0.06 },
    ]);
  }

  /** Low buzz when something fails. */
  error(): void {
    this.play([
      { freq: 220, to: 150, at: 0, dur: 0.16, type: 'sawtooth', gain: 0.045 },
      { freq: 180, to: 110, at: 0.15, dur: 0.24, type: 'sawtooth', gain: 0.045 },
    ]);
  }

  /** Lazily created audio context (browsers require a user gesture first). */
  private audio(): AudioContext | null {
    if (!this.enabled() || !this.volume() || typeof AudioContext === 'undefined') return null;
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Plays a list of oscillator tones. */
  private play(tones: Tone[]): void {
    const ctx = this.audio();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const t of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = t.type ?? 'sine';
      osc.frequency.setValueAtTime(t.freq, now + t.at);
      if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, now + t.at + t.dur);
      gain.gain.setValueAtTime(0.0001, now + t.at);
      gain.gain.exponentialRampToValueAtTime((t.gain ?? 0.05) * this.volume(), now + t.at + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t.at + t.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + t.at);
      osc.stop(now + t.at + t.dur + 0.02);
    }
  }

  /** Plays a filtered noise burst. */
  private noise(dur: number, level: number, from: number, to = from): void {
    const ctx = this.audio();
    if (!ctx) return;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buffer;
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(from, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + dur);
    gain.gain.setValueAtTime(level * this.volume(), ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
  }
}
