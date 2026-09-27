// Downloader section: reads a link with yt-dlp (title, thumbnail, available
// qualities), lets you rename the file and pick video/audio, quality and
// format, then either downloads it directly or opens it in the trimmer first.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Api, VideoInfo } from '../../core/api';
import { Icon } from '../../core/icon';
import { Store, sourceFromFile } from '../../core/store';
import { JobList } from '../../shared/job-list';
import { PLATFORMS, detectPlatform, formatBytes, formatDuration, parseUrl, relativeTime } from '../../core/format';

interface Quality {
  id: string;
  label: string;
  note: string;
  /** Best frame rate available at this resolution. */
  fps?: number;
  /** Approximate total bitrate in Mbps, used for the size estimate. */
  mbps: number;
}

interface AudioOption extends Quality {
  format: string;
  ext: string;
}

/** Label and approximate bitrate for each common height. */
const HEIGHTS: Record<number, [string, number]> = {
  2160: ['4K', 45],
  1440: ['2K', 18],
  1080: ['Full HD', 8],
  720: ['HD', 5],
  480: ['SD', 2.5],
  360: ['360p', 1],
  240: ['240p', 0.5],
  144: ['144p', 0.25],
};

const AUDIO: AudioOption[] = [
  { id: 'mp3-320', format: 'mp3', ext: 'mp3', label: 'MP3', note: '320 kbps', mbps: 0.32 },
  { id: 'mp3-192', format: 'mp3', ext: 'mp3', label: 'MP3', note: '192 kbps', mbps: 0.192 },
  { id: 'mp3-128', format: 'mp3', ext: 'mp3', label: 'MP3', note: '128 kbps', mbps: 0.128 },
  { id: 'm4a-256', format: 'm4a', ext: 'm4a', label: 'M4A', note: 'AAC 256', mbps: 0.256 },
  { id: 'opus-160', format: 'opus', ext: 'opus', label: 'Opus', note: '160 kbps', mbps: 0.16 },
  { id: 'vorbis-256', format: 'vorbis', ext: 'ogg', label: 'OGG', note: 'Vorbis 256', mbps: 0.256 },
  { id: 'flac-0', format: 'flac', ext: 'flac', label: 'FLAC', note: 'lossless', mbps: 0.9 },
  { id: 'wav-0', format: 'wav', ext: 'wav', label: 'WAV', note: 'PCM', mbps: 1.4 },
  { id: 'alac-0', format: 'alac', ext: 'm4a', label: 'ALAC', note: 'lossless', mbps: 0.9 },
];

const CONTAINERS = [
  { id: 'mp4', label: 'MP4', note: 'H.264' },
  { id: 'webm', label: 'WebM', note: 'VP9' },
  { id: 'mkv', label: 'MKV', note: 'Best' },
];

@Component({
  selector: 'app-downloader',
  imports: [Icon, JobList],
  templateUrl: './downloader.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:paste)': 'onPaste($event)' },
})
export class Downloader {
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  protected readonly t = this.store.t;
  protected readonly platforms = PLATFORMS;
  protected readonly containers = CONTAINERS;
  protected readonly audio = AUDIO;
  protected readonly bytes = formatBytes;
  protected readonly duration = formatDuration;
  protected readonly ago = (ts: number) => relativeTime(this.t, ts);
  protected readonly toSource = sourceFromFile;

  private readonly urlInput = viewChild.required<ElementRef<HTMLInputElement>>('urlInput');
  protected readonly url = signal('');
  protected readonly platform = computed(() => detectPlatform(this.url()));
  protected readonly error = signal('');
  protected readonly analyzing = signal(false);
  protected readonly meta = signal<VideoInfo | null>(null);
  /** File name for the download; starts as the title on the platform. */
  protected readonly fileName = signal('');

  protected readonly mode = signal<'video' | 'audio'>('video');
  protected readonly container = signal('mp4');
  protected readonly videoQuality = signal('best');
  protected readonly audioQuality = signal('mp3-320');

  /** "Best" plus every resolution the platform offers (up to 4K). */
  protected readonly videoQualities = computed<Quality[]>(() => {
    const list = this.meta()?.qualities ?? [];
    const options = list.map(({ height: h, fps }) => ({
      id: String(h),
      label: HEIGHTS[h]?.[0] ?? `${h}p`,
      note: `${h}p`,
      fps: fps ?? 0,
      mbps: HEIGHTS[h]?.[1] ?? (h * h) / 150000,
    }));
    const top = options[0];
    const best = top
      ? { ...top, id: 'best', label: this.t('dl.best'), note: top.label === top.note ? top.note : `${top.label} · ${top.note}` }
      : { id: 'best', label: this.t('dl.best'), note: '1080p', mbps: 8 };
    return [best, ...options];
  });
  /** Frame rate picked for the download (only offered from 720p when 60 fps exists). */
  protected readonly fps = signal<30 | 60>(60);
  /** Whether the selected resolution can be downloaded at 60 fps. */
  protected readonly canPickFps = computed(() => {
    const q = this.quality();
    const height = Number(q.id === 'best' ? this.meta()?.qualities[0]?.height : q.id) || 0;
    return this.mode() === 'video' && height >= 720 && (q.fps ?? 0) >= 50;
  });
  protected readonly quality = computed<Quality>(() =>
    this.mode() === 'audio'
      ? (AUDIO.find((a) => a.id === this.audioQuality()) ?? AUDIO[0])
      : (this.videoQualities().find((q) => q.id === this.videoQuality()) ?? this.videoQualities()[0]),
  );
  protected readonly ext = computed(() =>
    this.mode() === 'video' ? this.container() : (AUDIO.find((a) => a.id === this.audioQuality())?.ext ?? 'mp3'),
  );
  protected readonly estimate = computed(() => {
    const m = this.meta();
    const boost = this.canPickFps() && this.fps() === 60 ? 1.5 : 1;
    return m ? (this.quality().mbps * boost * 1e6 * m.duration) / 8 : 0;
  });
  protected readonly recent = computed(() => this.store.files().slice(0, 4));

  constructor() {
    // Picks up a copied link when you come back to the tab (only if clipboard
    // access was already granted, so the page never prompts on load).
    const onFocus = () => void this.readClipboard(true);
    afterNextRender(() => {
      addEventListener('focus', onFocus);
      const typed = this.urlInput().nativeElement.value;
      if (typed && !this.url()) this.url.set(typed);
    });
    inject(DestroyRef).onDestroy(() => globalThis.removeEventListener?.('focus', onFocus));
  }

  /** Reacts to the link field changing. */
  protected onInput(value: string): void {
    this.url.set(value);
    this.error.set('');
  }

  /** Sets the link field (signal and DOM, since the input isn't [value]-bound). */
  private setUrl(value: string): void {
    this.url.set(value);
    this.urlInput().nativeElement.value = value;
  }

  /** Empties the link field and the analysis. */
  protected clear(): void {
    this.setUrl('');
    this.meta.set(null);
    this.error.set('');
    this.urlInput().nativeElement.focus();
  }

  /** Ctrl+V anywhere on the page pastes a supported link and analyses it. */
  protected onPaste(event: ClipboardEvent): void {
    if (this.store.section() !== 'download') return;
    const text = (event.clipboardData?.getData('text') ?? '').trim();
    if (!detectPlatform(text)) return;
    event.preventDefault();
    this.setUrl(text);
    void this.analyze();
  }

  /**
   * "Paste" button: reads the clipboard straight into the field. Some browsers
   * (Firefox, Safari) always show their own confirmation first; that is a browser
   * security rule and can't be skipped.
   */
  protected async readClipboard(silent = false): Promise<void> {
    if (!silent) this.urlInput().nativeElement.focus();
    try {
      if (silent) {
        const state = await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName });
        if (state?.state !== 'granted' || this.url()) return;
      }
      const text = (await navigator.clipboard.readText()).trim();
      if (!detectPlatform(text)) {
        if (!silent) this.error.set(this.t('dl.clipboardEmpty'));
        return;
      }
      this.setUrl(text);
      if (silent) this.store.toast(this.t('dl.clipboardDetected'));
      void this.analyze();
    } catch {
      if (!silent) this.error.set(this.t('dl.clipboardDenied'));
    }
  }

  /** Reads the link's metadata from the server. */
  protected async analyze(): Promise<void> {
    const parsed = parseUrl(this.url());
    if (!parsed || !this.platform()) {
      this.error.set(this.t('dl.invalid'));
      this.store.sfx.error();
      return;
    }
    this.error.set('');
    this.analyzing.set(true);
    this.meta.set(null);
    try {
      const info = await this.api.info(parsed.href);
      this.meta.set(info);
      this.fileName.set(info.title);
      this.mode.set(info.hasVideo ? 'video' : 'audio');
      this.videoQuality.set('best');
      this.fps.set(60);
      this.store.sfx.success();
    } catch (err) {
      this.error.set(this.store.errorText(err));
      this.store.sfx.error();
    } finally {
      this.analyzing.set(false);
    }
  }

  /** Starts the download; with `trimFirst` the result opens in the trimmer. */
  private start(trimFirst: boolean): void {
    const m = this.meta();
    if (!m) return;
    const name = this.fileName().trim() || m.title;
    const audio = AUDIO.find((a) => a.id === this.audioQuality()) ?? AUDIO[0];
    const video = this.mode() === 'video';
    void this.store.run(
      () =>
        this.api.fetch({
          url: m.url,
          mode: this.mode(),
          quality: video ? this.videoQuality() : audio.id.split('-')[1],
          fps: video && this.canPickFps() ? this.fps() : undefined,
          container: this.container(),
          audioFormat: audio.format,
          name,
        }),
      {
        origin: 'download',
        name,
        ...(trimFirst && {
          onDone: (file) => {
            this.store.toast(this.t('dl.readyToTrim'));
            this.store.open('trim', sourceFromFile(file));
          },
        }),
      },
    );
    this.store.toast(this.t(trimFirst ? 'dl.preparingTrim' : 'dl.started'));
  }

  /** Downloads the video and opens it in the trimmer. */
  protected trimFirst(): void {
    this.start(true);
  }

  /** Downloads with the selected mode and quality. */
  protected download(): void {
    this.start(false);
  }
}
