// Animated backdrop behind every section, drawn on a canvas and softly blurred
// so it never competes with the content. Each section has its own scene and all
// of them react to the pointer (no glow: the shapes themselves move), to how
// fast it moves, and to clicks/taps, which send a shock wave through the scene:
//   download → a field of download arrows drifting down; near the cursor they
//              flow around it and grow
//   trim     → an audio waveform the cursor scrubs, with playhead and brackets;
//              clicks leave cut markers
//   convert  → a field of Bauhaus shapes that aim at the cursor and morph;
//              the shock wave converts them into the next shape
//   library  → floating file cards (coloured like the library origins) that lift
//              under the cursor and leave a trail
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

/** Smooth falloff: 1 at the cursor, 0 at `radius` and beyond. */
function near(dx: number, dy: number, radius: number): number {
  const d = Math.hypot(dx, dy);
  if (d >= radius) return 0;
  const k = 1 - d / radius;
  return k * k * (3 - 2 * k);
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
  /** Library trail: card index → time it was last touched. */
  private readonly trail = new Map<number, number>();
  private clock = 0;
  private readonly scenes: Record<Section, (f: Frame) => void> = {
    download: (f) => this.arrows(f),
    trim: (f) => this.waveform(f),
    convert: (f) => this.shapes(f),
    library: (f) => this.files(f),
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

  /** Downloader: download arrows drift down in a staggered grid; near the cursor they flow around it. */
  private arrows({ c, w, h, t, m, on }: Frame): void {
    const gap = w < 700 ? 58 : 76;
    const shift = t * 22;
    const base = Math.floor(shift / gap);
    const drift = shift - base * gap;
    for (let r = -1, y = gap / 2 - gap + drift; y < h + gap; r++, y += gap) {
      // Rows keep their identity (seed, stagger) while they scroll down.
      const row = r - base;
      const odd = ((row % 2) + 2) % 2;
      for (let col = 0, x = gap / 2 + odd * (gap / 2); x < w + gap; col++, x += gap) {
        const seed = row * 7.3 + col * 3.1;
        const fx = x + Math.sin(t * 0.6 + seed) * 4;
        const hit = this.shock(fx, y);
        const k = on ? near(fx - m.x, y - m.y, 220) : 0;
        // Idle they point down; near the cursor they point away from it.
        const away = Math.atan2(y - m.y, fx - m.x);
        const angle = Math.atan2(1 - k + Math.sin(away) * k, Math.cos(away) * k) - Math.PI / 2;
        const size = 7 + Math.sin(t * 0.8 + seed) * 0.8 + k * 4 + hit * 4;
        const color = (row + col) % 4 === 0 ? BLUE : YELLOW;
        c.save();
        c.translate(fx + (fx - m.x) * k * 0.08, y + (y - m.y) * k * 0.08);
        c.rotate(angle);
        c.strokeStyle = `rgb(${color} / ${0.28 + k * 0.35 + hit * 0.25})`;
        c.lineWidth = 2 + k * 0.5;
        c.beginPath();
        c.moveTo(-size, -size * 0.4);
        c.lineTo(0, size * 0.6);
        c.lineTo(size, -size * 0.4);
        // Every few, the full download glyph: a stem and a tray.
        if ((row * 3 + col) % 5 === 0) {
          c.moveTo(0, -size * 1.3);
          c.lineTo(0, size * 0.6);
          c.moveTo(-size, size * 1.3);
          c.lineTo(size, size * 1.3);
        }
        c.stroke();
        c.restore();
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

  /** Converter: shapes aim at the cursor and morph near it; a click wave converts them. */
  private shapes({ c, w, h, t, m, on }: Frame): void {
    const gap = w < 700 ? 58 : 76;
    const colors = [YELLOW, BLUE, RED];
    for (let row = 0, y = gap / 2; y < h + gap; row++, y += gap) {
      for (let col = 0, x = gap / 2 + (row % 2) * (gap / 2); x < w + gap; col++, x += gap) {
        const seed = row * 7.3 + col * 3.1;
        // Idle life: every shape floats in a small loop, breathes and turns slowly.
        const fx = x + Math.sin(t * 0.6 + seed) * 7;
        const fy = y + Math.cos(t * 0.5 + seed * 1.3) * 7;
        const hit = this.shock(fx, fy);
        const kind = ((row + col) % 3 + (hit > 0.2 ? 1 : 0)) % 3;
        const k = on ? near(fx - m.x, fy - m.y, 220) : 0;
        const idleAngle = t * 0.35 + seed;
        const angle = Math.atan2(m.y - fy, m.x - fx) * k + (1 - k) * idleAngle;
        const size = 9 + Math.sin(t * 0.8 + seed) * 1.2 + k * 5 + hit * 3;
        // Shapes near the cursor lean slightly towards it.
        const ox = fx - x + (m.x - fx) * k * 0.06;
        const oy = fy - y + (m.y - fy) * k * 0.06;
        c.save();
        c.translate(x + ox, y + oy);
        c.rotate(angle);
        c.strokeStyle = `rgb(${colors[kind]} / ${0.3 + k * 0.3 + hit * 0.2})`;
        c.lineWidth = 2 + k * 0.5;
        c.beginPath();
        if (kind === 2) {
          c.moveTo(size * 1.2, 0);
          c.lineTo(-size * 0.7, size);
          c.lineTo(-size * 0.7, -size);
          c.closePath();
        } else {
          // Circle ↔ square: the corner radius shrinks (or grows) near the cursor.
          const r = kind === 0 ? size * (1 - k) : size * k;
          c.roundRect(-size, -size, size * 2, size * 2, r);
        }
        c.stroke();
        c.restore();
      }
    }
  }

  /** Library: floating file cards lift under the cursor, leave a trail and flash with the click wave. */
  private files({ c, w, h, t, m, on }: Frame): void {
    const gap = w < 700 ? 62 : 84;
    const now = performance.now();
    const colors = [YELLOW, BLUE, RED, MUTED];
    for (let row = 0, y = gap / 2; y < h + gap; row++, y += gap) {
      for (let col = 0, x = gap / 2 + (row % 2) * (gap / 2); x < w + gap; col++, x += gap) {
        const i = row * 1000 + col;
        const seed = row * 5.7 + col * 2.3;
        const fx = x + Math.sin(t * 0.45 + seed) * 5;
        const fy = y + Math.cos(t * 0.5 + seed * 1.3) * 5;
        const k = on ? near(fx - m.x, fy - m.y, 200) : 0;
        if (k > 0.35) this.trail.set(i, now);
        const touched = this.trail.get(i);
        const fade = touched ? Math.max(0, 1 - (now - touched) / 1600) : 0;
        if (touched && !fade) this.trail.delete(i);
        const lit = Math.max(k, fade * 0.6, this.shock(fx, fy) * 1.2);
        const s = 1 + lit * 0.3;
        const cw = 8 * s;
        const ch = 11 * s;
        const fold = 4 * s;
        const color = colors[(row * 3 + col) % 4];
        c.save();
        c.translate(fx, fy - lit * 6);
        c.rotate(Math.sin(t * 0.4 + seed) * 0.1 * (1 - lit));
        c.beginPath();
        c.moveTo(-cw, -ch);
        c.lineTo(cw - fold, -ch);
        c.lineTo(cw, -ch + fold);
        c.lineTo(cw, ch);
        c.lineTo(-cw, ch);
        c.closePath();
        if (lit > 0.03) {
          c.fillStyle = `rgb(${color} / ${lit * 0.22})`;
          c.fill();
        }
        c.strokeStyle = `rgb(${color} / ${0.26 + lit * 0.4})`;
        c.lineWidth = 1.8;
        c.stroke();
        // Folded corner and two "content" lines.
        c.beginPath();
        c.moveTo(cw - fold, -ch);
        c.lineTo(cw - fold, -ch + fold);
        c.lineTo(cw, -ch + fold);
        c.moveTo(-cw * 0.5, 0);
        c.lineTo(cw * 0.5, 0);
        c.moveTo(-cw * 0.5, ch * 0.45);
        c.lineTo(cw * 0.2, ch * 0.45);
        c.lineWidth = 1.4;
        c.stroke();
        c.restore();
      }
    }
  }
}
