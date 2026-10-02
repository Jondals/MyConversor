// Animated backdrop behind every section, drawn on a canvas and softly blurred
// so it never competes with the content. Each section has its own scene and all
// of them react to the pointer (no glow: the shapes themselves move), to how
// fast it moves, and to clicks/taps, which send a shock wave through the scene:
//   download → a live transfer monitor: a scrolling throughput graph (the
//              pointer speeds it up); sparks peel off the incoming edge and
//              drift upward, bursting outward on a click
//   trim     → an audio waveform the cursor scrubs, with playhead and brackets;
//              clicks leave cut markers
//   convert  → quiet by design: nothing shows until the pointer is on the
//              page, then a small cluster of posterised Bauhaus tiles follows
//              it; a click fades in a few more where it lands
//   library  → a calm bookshelf: muted spines in rows light up in the library's
//              colours near the pointer and lift slightly, like being pulled out
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, effect, inject, input, viewChild } from '@angular/core';
import { Section, Store } from '../core/store';

const YELLOW = '250 204 21';
const BLUE = '59 130 246';
const RED = '239 68 68';
const MUTED = '148 163 184';

/** Speed (px/s) and lifetime (s) of a click shock wave. */
const WAVE_SPEED = 420;
const WAVE_LIFE = 1.6;

interface Pointer {
  /** Smoothed position. */
  x: number;
  y: number;
  /** Real position. */
  tx: number;
  ty: number;
  /** Smoothed velocity in px/s. */
  vx: number;
  vy: number;
}

interface Frame {
  c: CanvasRenderingContext2D;
  w: number;
  h: number;
  /** Seconds since start (0 when motion is reduced). */
  t: number;
  /** Seconds since the previous frame. */
  dt: number;
  m: Pointer;
  /** Whether a pointer is over the page. */
  on: boolean;
}

/** Deterministic pseudo-random number in [0, 1) from two integers. */
function hash(a: number, b: number): number {
  let h = Math.imul(a + 374761393, 668265263) ^ Math.imul(b + 1274126177, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A spark drifting away from the throughput graph. */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t0: number;
  life: number;
  color: string;
}

/** State of the download scene. */
interface Transfer {
  hist: number[];
  scroll: number;
  spawn: number;
  particles: Particle[];
}

/** Smooth falloff: 1 at the cursor, 0 at `radius` and beyond. */
function near(dx: number, dy: number, radius: number): number {
  const d = Math.hypot(dx, dy);
  if (d >= radius) return 0;
  const k = 1 - d / radius;
  return k * k * (3 - 2 * k);
}

/** The converter's Bauhaus colour field: a continuous value in [-1, 1] for any point. */
const MOSAIC_PALETTE = [YELLOW, BLUE, RED];
function mosaicField(x: number, y: number, t: number): number {
  return (Math.sin(x * 0.011 + t * 0.5) + Math.sin(y * 0.015 - t * 0.33) + Math.sin((x - y) * 0.008 + t * 0.22)) / 3;
}
/** Flat, posterised colour at a field value. */
function mosaicFlat(v: number): string {
  const idx = Math.round(((v + 1) / 2) * MOSAIC_PALETTE.length) % MOSAIC_PALETTE.length;
  return MOSAIC_PALETTE[((idx % MOSAIC_PALETTE.length) + MOSAIC_PALETTE.length) % MOSAIC_PALETTE.length];
}

@Component({
  selector: 'app-scene',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'scene', 'aria-hidden': 'true' },
  template: `<div class="scene-grid"></div>
    <canvas #canvas class="scene-canvas"></canvas>`,
})
export class Scene {
  readonly section = input.required<Section>();
  private readonly store = inject(Store);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private readonly m: Pointer = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4, vx: 0, vy: 0 };
  /** Click shock waves (position and start time in seconds). */
  private pulses: { x: number; y: number; t: number }[] = [];
  /** Cut markers left by clicks on the trim scene. */
  private marks: { x: number; t: number }[] = [];
  /** Library trail: sector key → time it was last touched. */
  private readonly trail = new Map<number, number>();
  private readonly dl: Transfer = { hist: [], scroll: 0, spawn: 0, particles: [] };
  private clock = 0;
  private readonly scenes: Record<Section, (f: Frame) => void> = {
    download: (f) => this.transfer(f),
    trim: (f) => this.waveform(f),
    convert: (f) => this.mosaic(f),
    library: (f) => this.shelf(f),
  };

  /** Asks for a new frame (set once the canvas is ready). */
  private redraw = () => {};

  constructor() {
    const destroyRef = inject(DestroyRef);
    // A new section or a motion setting change needs a new frame (or restarts the loop).
    effect(() => {
      this.section();
      this.store.reduceMotion();
      this.redraw();
    });
    afterNextRender(() => {
      const canvas = this.canvas().nativeElement;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      let frame = 0;
      let last = 0;
      let w = 0;
      let h = 0;
      const m = this.m;

      const resize = () => {
        const dpr = Math.min(devicePixelRatio || 1, 1.5);
        w = innerWidth;
        h = innerHeight;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        request();
      };
      const move = (e: PointerEvent) => {
        m.tx = e.clientX;
        m.ty = e.clientY;
        if (m.x < -1e3) Object.assign(m, { x: e.clientX, y: e.clientY });
        request();
      };
      const down = (e: PointerEvent) => {
        move(e);
        this.pulses.push({ x: e.clientX, y: e.clientY, t: this.clock });
        if (this.section() === 'trim') this.marks = [...this.marks.slice(-3), { x: e.clientX, t: this.clock }];
      };
      const leave = () => Object.assign(m, { tx: -1e4, ty: -1e4, vx: 0, vy: 0 });
      const render = (now: number) => {
        frame = 0;
        const still = this.store.reduceMotion() || matchMedia('(prefers-reduced-motion: reduce)').matches;
        const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
        last = now;
        this.clock = still ? 0 : now / 1000;
        const on = m.tx > -1e3;
        const px = m.x;
        const py = m.y;
        const ease = still ? 1 : 1 - Math.pow(0.03, dt);
        m.x += (m.tx - m.x) * ease;
        m.y += (m.ty - m.y) * ease;
        if (on && px > -1e3 && dt) {
          m.vx += ((m.x - px) / dt - m.vx) * 0.1;
          m.vy += ((m.y - py) / dt - m.vy) * 0.1;
        } else {
          m.vx *= 0.9;
          m.vy *= 0.9;
        }
        this.pulses = this.pulses.filter((p) => this.clock - p.t < WAVE_LIFE);
        ctx.clearRect(0, 0, w, h);
        this.scenes[this.section()]({ c: ctx, w, h, t: this.clock, dt: still ? 0 : dt, m, on });
        if (!still && !document.hidden) request();
      };
      const request = () => {
        frame ||= requestAnimationFrame(render);
      };

      this.redraw = request;
      resize();
      addEventListener('resize', resize);
      addEventListener('pointermove', move, { passive: true });
      addEventListener('pointerdown', down, { passive: true });
      document.addEventListener('pointerleave', leave);
      document.addEventListener('visibilitychange', request);
      destroyRef.onDestroy(() => {
        cancelAnimationFrame(frame);
        removeEventListener('resize', resize);
        removeEventListener('pointermove', move);
        removeEventListener('pointerdown', down);
        document.removeEventListener('pointerleave', leave);
        document.removeEventListener('visibilitychange', request);
      });
    });
  }

  /** How strongly the click shock waves hit a point right now (0–1). */
  private shock(x: number, y: number): number {
    let k = 0;
    for (const p of this.pulses) {
      const age = this.clock - p.t;
      const front = age * WAVE_SPEED;
      const d = Math.abs(Math.hypot(x - p.x, y - p.y) - front);
      if (d < 70) k = Math.max(k, (1 - d / 70) * (1 - age / WAVE_LIFE) * 0.5);
    }
    return k;
  }

  /** Global strength of the most recent click (1 right after it, 0 once its wave is gone). */
  private burst(): number {
    let k = 0;
    for (const p of this.pulses) k = Math.max(k, 1 - (this.clock - p.t) / WAVE_LIFE);
    return k;
  }

  /**
   * Downloader: a live transfer monitor. A throughput graph scrolls along the
   * bottom two thirds of the screen (the pointer speeds it up); sparks peel off
   * its incoming edge and drift upward, fading as they fall back. A click sends
   * a burst of sparks out from where it landed.
   */
  private transfer({ c, w, h, t, dt, m, on }: Frame): void {
    const s = this.dl;
    const energy = Math.min(1, Math.hypot(m.vx, m.vy) / 1400);
    const speed = Math.min(1, 0.32 + 0.16 * Math.sin(t * 0.7) * Math.sin(t * 0.23 + 1) + energy * 0.45 + this.burst() * 0.4);

    // Throughput history: one sample every `step` px, scrolling left.
    const step = 6;
    const n = Math.ceil(w / step) + 2;
    while (s.hist.length < n) s.hist.unshift(0.3 + hash(s.hist.length, 3) * 0.15);
    if (s.hist.length > n) s.hist.splice(0, s.hist.length - n);
    s.scroll += dt * 70;
    while (s.scroll >= step) {
      s.scroll -= step;
      s.hist.shift();
      s.hist.push(Math.max(0.05, Math.min(1, speed + (Math.random() - 0.5) * 0.14)));
    }
    const gy1 = h - 60;
    const gh = h * 0.28;
    const gx = (i: number) => i * step - s.scroll;
    const gv = (i: number) => {
      const x = gx(i);
      return Math.min(1.15, s.hist[i] + (on ? near(x - m.x, 0, 170) * 0.22 : 0));
    };
    const gy = (i: number) => gy1 - gv(i) * gh;

    // Graph: dashed level lines, filled area, live line and a smoothed average.
    c.fillStyle = `rgb(${MUTED} / 0.12)`;
    for (let k = 1; k <= 4; k++) {
      const y = Math.round(gy1 - (gh * k) / 4);
      for (let x = 0; x < w; x += 14) c.fillRect(x, y, 7, 1);
    }
    c.fillRect(0, gy1, w, 1);
    c.beginPath();
    c.moveTo(gx(0), gy1);
    for (let i = 0; i < n; i++) c.lineTo(gx(i), gy(i));
    c.lineTo(gx(n - 1), gy1);
    c.closePath();
    const fill = c.createLinearGradient(0, gy1 - gh, 0, gy1);
    fill.addColorStop(0, `rgb(${YELLOW} / 0.16)`);
    fill.addColorStop(1, `rgb(${YELLOW} / 0)`);
    c.fillStyle = fill;
    c.fill();
    c.beginPath();
    for (let i = 0; i < n; i++) (i ? c.lineTo : c.moveTo).call(c, gx(i), gy(i));
    c.strokeStyle = `rgb(${YELLOW} / 0.55)`;
    c.lineWidth = 2;
    c.stroke();
    c.beginPath();
    let avg = s.hist[0];
    for (let i = 0; i < n; i++) {
      avg += (s.hist[i] - avg) * 0.08;
      (i ? c.lineTo : c.moveTo).call(c, gx(i), gy1 - avg * gh);
    }
    c.strokeStyle = `rgb(${BLUE} / 0.45)`;
    c.lineWidth = 1.5;
    c.stroke();
    if (on && m.y > gy1 - gh - 80) {
      // Crosshair reading the graph under the pointer.
      const i = Math.max(0, Math.min(n - 1, Math.round((m.x + s.scroll) / step)));
      c.fillStyle = `rgb(${MUTED} / 0.25)`;
      c.fillRect(Math.round(m.x), gy1 - gh - 20, 1, gh + 20);
      c.fillStyle = `rgb(${YELLOW} / 0.8)`;
      c.fillRect(m.x - 4, gy(i) - 4, 8, 8);
    }


    // Sparks peel off the incoming edge (the newest sample) and drift upward.
    s.spawn += dt * (4 + speed * 26);
    while (s.spawn >= 1) {
      s.spawn -= 1;
      if (s.particles.length > 160) break;
      const x = gx(n - 1);
      const y = gy(n - 1);
      s.particles.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 18,
        vy: -(30 + Math.random() * 55),
        t0: t,
        life: 1.1 + Math.random() * 0.9,
        color: Math.random() < 0.25 ? BLUE : YELLOW,
      });
    }
    // A click bursts a handful of sparks outward from where it landed.
    for (const p of this.pulses) {
      if (this.clock - p.t >= dt + 0.001 || p.y > gy1 + 40) continue;
      for (let k = 0; k < 14; k++) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
        const sp = 60 + Math.random() * 130;
        s.particles.push({
          x: p.x,
          y: p.y,
          vx: Math.cos(angle) * sp,
          vy: Math.sin(angle) * sp,
          t0: t,
          life: 0.7 + Math.random() * 0.6,
          color: Math.random() < 0.4 ? BLUE : YELLOW,
        });
      }
    }
    const gravity = 90;
    s.particles = s.particles.filter((p) => {
      const age = t - p.t0;
      const k = age / p.life;
      if (k >= 1) return false;
      const x = p.x + p.vx * age;
      const y = p.y + p.vy * age + 0.5 * gravity * age * age;
      c.fillStyle = `rgb(${p.color} / ${(1 - k) * 0.85})`;
      c.fillRect(x - 1.5, y - 1.5, 3, 3);
      return true;
    });
  }

  /**
   * Converter: kept deliberately quiet. Nothing is drawn at all until the
   * pointer is on the page, and then only a small, soft cluster of posterised
   * Bauhaus tiles follows it closely; a click fades in a few more where it
   * lands. It never spans the screen, so it can't compete with the panel on
   * top of it.
   */
  private mosaic({ c, t, m, on }: Frame): void {
    const tile = 24;
    const radius = 85;
    const draw = (ox: number, oy: number, strength: number) => {
      const x0 = Math.floor((ox - radius) / tile) * tile;
      const y0 = Math.floor((oy - radius) / tile) * tile;
      for (let y = y0; y < oy + radius; y += tile) {
        for (let x = x0; x < ox + radius; x += tile) {
          const cx = x + tile / 2;
          const cy = y + tile / 2;
          const d = Math.hypot(cx - ox, cy - oy);
          if (d > radius) continue;
          const k = (1 - d / radius) * strength;
          c.fillStyle = `rgb(${mosaicFlat(mosaicField(cx, cy, t))} / ${k * 0.3})`;
          c.fillRect(x + 1, y + 1, tile - 2, tile - 2);
        }
      }
    };
    if (on) draw(m.x, m.y, 1);
    for (const p of this.pulses) {
      const age = t - p.t;
      if (age < WAVE_LIFE) draw(p.x, p.y, 1 - age / WAVE_LIFE);
    }
  }

  /**
   * Library: a calm, sparse bookshelf — plenty of empty space between spines
   * so it never reads as busy. Near the pointer a few spines light up in the
   * library's colours (downloads, clips, conversions, uploads) and lift
   * slightly, like being pulled out to read, leaving a brief trail. A click
   * only gives the spines it lands on a soft, contained flash, not a sweep
   * across the page.
   */
  private shelf({ c, w, h, t, m, on }: Frame): void {
    const small = w < 700;
    const barW = small ? 10 : 14;
    const gap = small ? 12 : 18;
    const pitch = barW + gap;
    const shelfH = small ? 112 : 152;
    const cols = Math.ceil(w / pitch) + 1;
    const rows = Math.ceil(h / shelfH);
    const colors = [YELLOW, BLUE, RED, MUTED];
    const now = performance.now();
    for (let row = 0; row < rows; row++) {
      const board = row * shelfH + shelfH;
      c.fillStyle = `rgb(${MUTED} / 0.12)`;
      c.fillRect(0, board, w, 1);
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        const x = col * pitch;
        const height = shelfH * 0.26 + hash(i, row) * shelfH * 0.4;
        const top = board - height;
        const cx = x + barW / 2;
        const cy = (top + board) / 2;
        const near0 = on ? near(cx - m.x, cy - m.y, 110) : 0;
        if (near0 > 0.4) this.trail.set(i, now);
        const touched = this.trail.get(i);
        const fade = touched ? Math.max(0, 1 - (now - touched) / 1500) : 0;
        if (touched && !fade) this.trail.delete(i);
        const k = Math.min(1, Math.max(near0, fade * 0.5, this.shock(cx, cy) * 0.4));
        const lift = k * 7;
        c.fillStyle = k > 0.05 ? `rgb(${colors[i % 4]} / ${0.14 + k * 0.4})` : `rgb(${MUTED} / 0.1)`;
        c.fillRect(x, top - lift, barW, height);
      }
    }
  }

  /** Trimmer: a waveform that grows where the cursor scrubs; clicks leave cut markers. */
  private waveform({ c, w, h, t, m, on }: Frame): void {
    const mid = h * 0.62;
    const step = 7;
    const head = on ? m.x : ((t * 60) % (w + 200)) - 100;
    const energy = Math.min(1, Math.hypot(m.vx, m.vy) / 1600);
    for (let x = 0; x < w; x += step) {
      const wave = Math.abs(Math.sin(x * 0.021 + t * 1.2) * Math.sin(x * 0.0063 - t * 0.5)) * 34 + 3;
      const lift = near(x - head, on ? (m.y - mid) * 0.3 : 0, 260);
      const hit = this.shock(x, mid);
      const amp = wave * (1 + lift * (1.4 + energy * 1.2) + hit * 1.2);
      const inside = Math.abs(x - head) < 120;
      c.fillStyle = inside || hit > 0.1 ? `rgb(${YELLOW} / ${0.3 + lift * 0.5 + hit * 0.3})` : `rgb(${MUTED} / 0.18)`;
      c.fillRect(x, mid - amp, 3, amp * 2);
    }
    // Ruler ticks along the bottom.
    for (let x = 0; x < w; x += 16) {
      const major = x % 80 === 0;
      c.fillStyle = `rgb(${MUTED} / ${major ? 0.35 : 0.2})`;
      c.fillRect(x, h - 40, 1, major ? 22 : 12);
    }
    // Cut markers left by clicks, fading out.
    for (const mark of this.marks) {
      const a = Math.max(0, 1 - (t - mark.t) / 4);
      if (!a) continue;
      c.fillStyle = `rgb(${BLUE} / ${a * 0.6})`;
      c.fillRect(mark.x - 1.5, mid - 140, 3, 280);
      c.fillRect(mark.x - 8, mid - 140, 16, 3);
      c.fillRect(mark.x - 8, mid + 137, 16, 3);
    }
    // Selection brackets and playhead following the cursor; they open wider when moving fast.
    const span = 120 + energy * 30;
    c.strokeStyle = `rgb(${YELLOW} / 0.55)`;
    c.lineWidth = 3;
    for (const side of [-1, 1]) {
      const bx = head + side * span;
      c.beginPath();
      c.moveTo(bx - side * 12, mid - 100);
      c.lineTo(bx, mid - 100);
      c.lineTo(bx, mid + 100);
      c.lineTo(bx - side * 12, mid + 100);
      c.stroke();
    }
    c.fillStyle = `rgb(${RED} / 0.5)`;
    c.fillRect(head - 1.5, 0, 3, h);
  }

}
