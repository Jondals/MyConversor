// Trimmer section: previews a video (downloaded, from the library or uploaded),
// lets you set start/end on a frame-strip timeline (handles preview the exact
// frame while dragging, the playhead can't leave the cut), adjust the audio
// (0–200 % or mute, heard in the preview) and export the clip with FFmpeg.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Api, RemoteFile } from '../../core/api';
import { Icon } from '../../core/icon';
import { Key } from '../../core/i18n';
import { Source, Store, sourceFromFile, whenUploaded } from '../../core/store';
import { formatBytes, formatDuration, formatTimecode } from '../../core/format';

type AspectId = 'original' | '9:16' | '1:1' | '21:9';
type Aspect = { id: AspectId; label: string; ratio: string; out: string };
type Handle = 'in' | 'out';

const ASPECTS: Aspect[] = [
  { id: 'original', label: 'Original', ratio: '16 / 9', out: 'Original' },
  { id: '9:16', label: '9:16', ratio: '9 / 16', out: '1080×1920' },
  { id: '1:1', label: '1:1', ratio: '1 / 1', out: '1080×1080' },
  { id: '21:9', label: '21:9', ratio: '21 / 9', out: '2560×1080' },
];
const FRAME_COUNT = 12;
const MIN_SPAN = 0.1;
const FPS = 30;

/** Parses "mm:ss.mmm", "ss.mmm" or "h:mm:ss" into seconds. */
export function parseTimecode(text: string): number | null {
  const parts = text.trim().replace(',', '.').split(':');
  if (!parts.length || parts.length > 3 || parts.some((p) => p === '' || isNaN(Number(p))))
    return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

@Component({
  selector: 'app-trimmer',
  imports: [Icon, DecimalPipe],
  templateUrl: './trimmer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
})
export class Trimmer {
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly track = viewChild<ElementRef<HTMLElement>>('track');

  protected readonly t = this.store.t;
  protected readonly aspects = ASPECTS;
  protected readonly templates: { key: Key; aspect: AspectId; size: string }[] = [
    { key: 'trim.tpl.reels', aspect: '9:16', size: '1080×1920' },
    { key: 'trim.tpl.shorts', aspect: '9:16', size: '1080×1920' },
    { key: 'trim.tpl.square', aspect: '1:1', size: '1080×1080' },
    { key: 'trim.tpl.cinema', aspect: '21:9', size: '2560×1080' },
  ];
  protected readonly template = signal<Key | null>(null);
  protected readonly tc = formatTimecode;
  protected readonly bytes = formatBytes;
  protected readonly dur = formatDuration;

  protected readonly source = signal<Source | null>(null);
  protected readonly fileName = signal('');
  protected readonly duration = signal(0);
  protected readonly current = signal(0);
  protected readonly inPoint = signal(0);
  protected readonly outPoint = signal(0);
  protected readonly playing = signal(false);
  protected readonly frames = signal<string[]>([]);
  /** Timeline strip made by the server (one image), for files already stored there. */
  protected readonly strip = signal<string | null>(null);
  protected readonly aspect = signal<Aspect>(ASPECTS[0]);
  protected readonly lossless = signal(true);
  protected readonly dragging = signal<Handle | 'head' | null>(null);
  protected readonly hasVideo = signal(true);
  protected readonly previewError = signal(false);
  /** 0–2 (0–200 %). Applied to the preview and to the exported file. */
  protected readonly volume = signal(1);
  protected readonly muted = signal(false);

  protected readonly span = computed(() => Math.max(0, this.outPoint() - this.inPoint()));
  protected readonly pct = (t: number) => (this.duration() ? (t / this.duration()) * 100 : 0);
  protected readonly copies = computed(() => this.lossless() && this.aspect().id === 'original');
  protected readonly audioEdited = computed(
    () => this.muted() || Math.abs(this.volume() - 1) > 0.001,
  );
  protected readonly outExt = computed(() => {
    const s = this.source();
    if (!s) return '';
    return s.kind === 'audio' || this.copies() ? s.ext : 'mp4';
  });
  protected readonly estimate = computed(() => {
    const s = this.source();
    if (!s || !this.duration()) return 0;
    return s.size * (this.span() / this.duration()) * (this.copies() ? 1 : 0.6);
  });
  protected readonly saving = computed(() => {
    const s = this.source();
    return s?.size ? Math.max(0, Math.round((1 - this.estimate() / s.size) * 100)) : 0;
  });
  protected readonly originalRatio = computed(() => {
    const s = this.source();
    return s?.width && s.height ? `${s.width} / ${s.height}` : '16 / 9';
  });
  protected readonly ticks = computed(() => {
    const d = this.duration();
    return d ? Array.from({ length: 6 }, (_, i) => (d * i) / 5) : [];
  });
  protected readonly libraryMedia = computed(() =>
    this.store
      .files()
      .filter((f) => f.kind === 'video' || f.kind === 'audio')
      .slice(0, 6),
  );

  private audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private graphFor: HTMLVideoElement | null = null;
  private raf = 0;
  private seekBusy = false;
  private seekNext: number | null = null;

  constructor() {
    // A file deleted from the library can't stay open here.
    effect(() => {
      const removed = this.store.removed();
      untracked(() => {
        const s = this.source();
        if (removed && s?.fileId === removed) {
          this.video()?.nativeElement.pause();
          this.source.set(null);
          this.store.toast(this.t('toast.removed', { name: s.name }));
        }
      });
    });
    effect(() => {
      const incoming = this.store.incoming();
      if (incoming?.target === 'trim') {
        untracked(() => {
          this.store.incoming.set(null);
          this.load(incoming.source);
        });
      }
    });
    // Keep the preview's loudness in sync with the export settings.
    effect(() => {
      const level = this.muted() ? 0 : this.volume();
      if (this.gain && this.audioCtx)
        this.gain.gain.setTargetAtTime(level, this.audioCtx.currentTime, 0.02);
      const v = this.video()?.nativeElement;
      if (v && !this.gain) v.volume = Math.min(1, level);
    });
    afterNextRender(() => {
      const input = document.getElementById('trim-file') as HTMLInputElement | null;
      if (input?.files?.length && !this.source()) this.pick(input);
    });
    inject(DestroyRef).onDestroy(() => {
      cancelAnimationFrame(this.raf);
      void this.audioCtx?.close();
    });
  }

  // ---------------------------------------------------------------- loading

  /** Applies a platform template (sets the aspect ratio). */
  protected useTemplate(key: Key, aspect: AspectId): void {
    this.template.set(key);
    this.aspect.set(ASPECTS.find((a) => a.id === aspect)!);
  }

  /** Chooses an aspect ratio directly (clears the template highlight). */
  protected setAspect(a: Aspect): void {
    this.template.set(null);
    this.aspect.set(a);
  }

  /** Uploads a file chosen with the file picker. */
  protected pick(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (file) this.load(this.store.uploadLocal(file));
  }

  /** Uploads a dropped file. */
  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file && /^(video|audio)\//.test(file.type)) this.load(this.store.uploadLocal(file));
  }

  /** Uses a library file as the source. */
  protected openFile(file: RemoteFile): void {
    this.load(sourceFromFile(file));
  }

  /** Loads a source into the player and resets the cut. */
  private load(s: Source): void {
    this.video()?.nativeElement.pause();
    this.source.set(s);
    this.fileName.set(s.name);
    this.aspect.set(ASPECTS[0]);
    this.previewError.set(false);
    this.frames.set([]);
    this.strip.set(null);
    this.playing.set(false);
    this.current.set(0);
    this.duration.set(s.duration);
    this.inPoint.set(0);
    this.outPoint.set(s.duration);
    this.hasVideo.set(s.kind !== 'audio');
    whenUploaded(s, (updated) => {
      const cur = this.source();
      if (cur?.url === s.url)
        this.source.set({
          ...updated,
          width: cur.width || updated.width,
          height: cur.height || updated.height,
        });
    });
  }

  /** Reads duration and size once the media metadata is ready. */
  protected onMeta(v: HTMLVideoElement): void {
    const d = Number.isFinite(v.duration) ? v.duration : this.source()?.duration || 0;
    this.duration.set(d);
    this.inPoint.set(0);
    this.outPoint.set(d);
    this.hasVideo.set(v.videoWidth > 0);
    const s = this.source();
    if (s && !s.width && v.videoWidth) {
      this.source.set({ ...s, width: v.videoWidth, height: v.videoHeight, duration: d });
    }
    if (!v.videoWidth) return;
    // Stored files get their strip from the server in one request; that doesn't
    // compete with the preview for bandwidth like seeking a second video would.
    const id = this.source()?.fileId;
    if (id) this.strip.set(`/api/files/${id}/strip`);
    else void this.extractFrames(d, v.currentSrc || v.src);
  }

  /** The server couldn't make the strip: fall back to reading frames here. */
  protected onStripError(): void {
    const v = this.video()?.nativeElement;
    this.strip.set(null);
    if (v) void this.extractFrames(this.duration(), v.currentSrc || v.src);
  }

  /** The browser can't decode this format: keep the timeline working with the server's duration. */
  protected onVideoError(): void {
    this.previewError.set(true);
    const d = this.source()?.duration ?? 0;
    if (!this.duration() && d) {
      this.duration.set(d);
      this.outPoint.set(d);
    }
  }

  /** Evenly spaced thumbnails for the timeline strip. */
  private async extractFrames(d: number, url: string): Promise<void> {
    if (!d || !url) return;
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = url;
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const out: string[] = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const ok = await new Promise<boolean>((resolve) => {
        v.onseeked = () => resolve(true);
        v.onerror = () => resolve(false);
        v.currentTime = ((i + 0.5) * d) / FRAME_COUNT;
      });
      if (!ok || this.source()?.url !== url) break;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      out.push(canvas.toDataURL('image/jpeg', 0.55));
      this.frames.set([...out]);
    }
    v.removeAttribute('src');
    v.load();
  }

  // --------------------------------------------------------------- playback

  /** Routes audio through a GainNode so the preview can go above 100 %. */
  private ensureAudioGraph(v: HTMLVideoElement): void {
    if (this.graphFor === v || typeof AudioContext === 'undefined') return;
    try {
      this.audioCtx ??= new AudioContext();
      const src = this.audioCtx.createMediaElementSource(v);
      this.gain = this.audioCtx.createGain();
      this.gain.gain.value = this.muted() ? 0 : this.volume();
      src.connect(this.gain).connect(this.audioCtx.destination);
      this.graphFor = v;
      v.volume = 1;
    } catch {
      this.gain = null; // fall back to element volume (max 100 %)
    }
    void this.audioCtx?.resume();
  }

  /** Plays or pauses the preview (inside the cut). */
  protected togglePlay(): void {
    const v = this.video()?.nativeElement;
    if (!v) return;
    if (!v.paused) return v.pause();
    this.ensureAudioGraph(v);
    if (v.currentTime < this.inPoint() || v.currentTime >= this.outPoint() - 0.05) {
      v.currentTime = this.inPoint();
    }
    void v.play();
  }

  /** Starts the loop that keeps playback inside the cut. */
  protected onPlay(): void {
    this.playing.set(true);
    const tick = () => {
      const v = this.video()?.nativeElement;
      if (!v || v.paused) return;
      if (v.currentTime >= this.outPoint()) {
        v.pause();
        v.currentTime = this.outPoint();
      }
      this.current.set(v.currentTime);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Stops the playback loop. */
  protected onPause(): void {
    this.playing.set(false);
    cancelAnimationFrame(this.raf);
  }

  /** Seeks inside the selected range only: the playhead can't leave the cut. */
  protected seek(t: number, clampToRange = true): void {
    const lo = clampToRange ? this.inPoint() : 0;
    const hi = clampToRange ? this.outPoint() : this.duration();
    const time = Math.min(Math.max(lo, t), hi);
    this.current.set(time);
    this.previewAt(time);
  }

  /** Coalesces rapid seeks (dragging) so the preview keeps up smoothly. */
  private previewAt(time: number): void {
    const v = this.video()?.nativeElement;
    if (!v) return;
    if (this.seekBusy) {
      this.seekNext = time;
      return;
    }
    this.seekBusy = true;
    v.addEventListener(
      'seeked',
      () => {
        this.seekBusy = false;
        if (this.seekNext !== null) {
          const next = this.seekNext;
          this.seekNext = null;
          this.previewAt(next);
        }
      },
      { once: true },
    );
    v.currentTime = time;
  }

  /** Moves the playhead by a number of frames. */
  protected step(frames: number): void {
    this.video()?.nativeElement.pause();
    this.seek(this.current() + frames / FPS);
  }

  // ------------------------------------------------------------ cut points

  /** Moves the start or end handle, keeping a minimum length. */
  protected setPoint(handle: Handle, t: number): void {
    const d = this.duration();
    if (handle === 'in') {
      this.inPoint.set(Math.min(Math.max(0, t), this.outPoint() - MIN_SPAN));
    } else {
      this.outPoint.set(Math.max(Math.min(d, t), this.inPoint() + MIN_SPAN));
    }
    // Keep the playhead inside the new range.
    const cur = this.current();
    if (cur < this.inPoint() || cur > this.outPoint()) this.seek(cur);
  }

  /** Puts a handle at the current playhead. */
  protected markHere(handle: Handle): void {
    this.setPoint(handle, this.current());
    this.store.sfx.snip();
  }

  /** Moves a handle by a small delta. */
  protected nudge(handle: Handle, delta: number): void {
    this.setPoint(handle, (handle === 'in' ? this.inPoint() : this.outPoint()) + delta);
    this.seek(handle === 'in' ? this.inPoint() : this.outPoint());
  }

  /** Applies a timecode typed in a handle field. */
  protected typePoint(handle: Handle, input: HTMLInputElement): void {
    const t = parseTimecode(input.value);
    if (t === null) {
      input.value = this.tc(handle === 'in' ? this.inPoint() : this.outPoint());
      this.store.sfx.error();
      return;
    }
    this.setPoint(handle, t);
    input.value = this.tc(handle === 'in' ? this.inPoint() : this.outPoint());
    this.seek(handle === 'in' ? this.inPoint() : this.outPoint());
    this.store.sfx.snip();
  }

  /** Converts a pointer position on the timeline to seconds. */
  private timeAt(clientX: number): number {
    const el = this.track()?.nativeElement;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return (Math.min(Math.max(clientX - r.left, 0), r.width) / r.width) * this.duration();
  }

  /** Dragging a handle previews that exact frame; dragging the track scrubs. */
  protected startDrag(event: PointerEvent, handle?: Handle): void {
    if (!this.duration()) return;
    event.preventDefault();
    event.stopPropagation();
    this.video()?.nativeElement.pause();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    this.dragging.set(handle ?? 'head');
    document.documentElement.dataset['drag'] = handle ? 'trim' : 'scrub';
    const apply = (x: number) => {
      const t = this.timeAt(x);
      if (handle) {
        this.setPoint(handle, t);
        this.current.set(handle === 'in' ? this.inPoint() : this.outPoint());
        this.previewAt(this.current());
      } else {
        this.seek(t);
      }
    };
    apply(event.clientX);
    const move = (e: PointerEvent) => apply(e.clientX);
    const up = () => {
      this.dragging.set(null);
      delete document.documentElement.dataset['drag'];
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (handle) this.store.sfx.snip();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  /** Keyboard control for a focused handle. */
  protected handleKey(event: KeyboardEvent, handle: Handle): void {
    const delta = event.shiftKey ? 1 : 1 / FPS;
    const map: Record<string, number> = {
      ArrowLeft: -delta,
      ArrowDown: -delta,
      ArrowRight: delta,
      ArrowUp: delta,
    };
    if (event.key in map) {
      event.preventDefault();
      event.stopPropagation();
      this.nudge(handle, map[event.key]);
    }
  }

  /** Global shortcuts (space, arrows, I/O). */
  protected onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (
      !this.source() ||
      this.store.section() !== 'trim' ||
      target.closest('input, select, textarea, dialog, [role="slider"]')
    ) {
      return;
    }
    const actions: Record<string, () => void> = {
      ' ': () => this.togglePlay(),
      i: () => this.markHere('in'),
      o: () => this.markHere('out'),
      '[': () => this.seek(this.inPoint()),
      ']': () => this.seek(this.outPoint()),
      m: () => this.muted.update((m) => !m),
      ArrowLeft: () => this.step(event.shiftKey ? -FPS : -1),
      ArrowRight: () => this.step(event.shiftKey ? FPS : 1),
    };
    const action = actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (action && !(event.key === ' ' && target.closest('button'))) {
      event.preventDefault();
      action();
    }
  }

  /** Changes the preview volume. */
  protected setVolume(value: number): void {
    this.volume.set(value / 100);
    if (value > 0) this.muted.set(false);
  }

  // ---------------------------------------------------------------- output

  /** Deletes the current file from the server and every section. */
  protected deleteSource(): void {
    const s = this.source();
    if (!s) return;
    this.video()?.nativeElement.pause();
    this.source.set(null);
    void this.store.discard(s);
  }

  /** Sends the cut to the server. */
  protected exportClip(): void {
    const s = this.source();
    if (!s) return;
    const name = this.fileName().trim() || s.name;
    const options = {
      start: this.inPoint(),
      end: this.outPoint(),
      copy: this.lossless(),
      aspect: this.aspect().id,
      volume: this.volume(),
      mute: this.muted(),
      name,
    };
    void this.store.run(async () => this.api.trim(await this.store.remoteId(s), options), {
      origin: 'trim',
      name,
    });
  }

  /** Opens the current source in the converter. */
  protected sendToConverter(): void {
    const s = this.source();
    if (s) this.store.open('convert', { ...s, name: this.fileName().trim() || s.name });
  }
}
