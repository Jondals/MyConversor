// Converter section: picks a source (upload or library), an output format
// (video, animation or audio), a profile and quality settings, shows the
// estimated size/time and runs the conversion with FFmpeg on the server.
import { ChangeDetectionStrategy, Component, afterNextRender, computed, effect, inject, signal, untracked } from '@angular/core';
import { Api, RemoteFile } from '../../core/api';
import { Icon, IconName } from '../../core/icon';
import { Key } from '../../core/i18n';
import { Source, Store, sourceFromFile, whenUploaded } from '../../core/store';
import { formatBytes, formatDuration, shortDuration } from '../../core/format';

type Category = 'video' | 'animation' | 'audio';

interface FormatOption {
  id: string;
  label: string;
  /** File extension of the result. */
  ext: string;
  codecs: string[];
  recommended?: boolean;
  lossless?: boolean;
}

interface Preset {
  id: string;
  icon: IconName;
  tag: string;
  width: number;
  height: number;
  /** Size cap in bytes, if any. */
  cap?: number;
}

const FORMATS: Record<Category, FormatOption[]> = {
  video: [
    { id: 'mp4', label: 'MP4', ext: 'mp4', codecs: ['h264', 'h265'], recommended: true },
    { id: 'webm', label: 'WebM', ext: 'webm', codecs: ['vp9', 'av1'] },
    { id: 'mkv', label: 'MKV', ext: 'mkv', codecs: ['h264', 'h265', 'av1', 'vp9'] },
    { id: 'mov', label: 'MOV', ext: 'mov', codecs: ['prores', 'h264'] },
    { id: 'avi', label: 'AVI', ext: 'avi', codecs: ['xvid'] },
    { id: 'm4v', label: 'M4V', ext: 'm4v', codecs: ['h264'] },
    { id: 'flv', label: 'FLV', ext: 'flv', codecs: ['flv'] },
    { id: 'mpeg', label: 'MPEG', ext: 'mpg', codecs: ['mpeg2'] },
    { id: 'ogv', label: 'OGV', ext: 'ogv', codecs: ['theora'] },
  ],
  animation: [
    { id: 'gif', label: 'GIF', ext: 'gif', codecs: [], recommended: true },
    { id: 'webp', label: 'WebP', ext: 'webp', codecs: [] },
    { id: 'apng', label: 'APNG', ext: 'png', codecs: [] },
  ],
  audio: [
    { id: 'mp3', label: 'MP3', ext: 'mp3', codecs: [], recommended: true },
    { id: 'aac', label: 'AAC', ext: 'm4a', codecs: [] },
    { id: 'ogg', label: 'OGG', ext: 'ogg', codecs: [] },
    { id: 'opus', label: 'Opus', ext: 'opus', codecs: [] },
    { id: 'wma', label: 'WMA', ext: 'wma', codecs: [] },
    { id: 'ac3', label: 'AC3', ext: 'ac3', codecs: [] },
    { id: 'wav', label: 'WAV', ext: 'wav', codecs: [], lossless: true },
    { id: 'flac', label: 'FLAC', ext: 'flac', codecs: [], lossless: true },
    { id: 'alac', label: 'ALAC', ext: 'm4a', codecs: [], lossless: true },
    { id: 'aiff', label: 'AIFF', ext: 'aiff', codecs: [], lossless: true },
  ],
};

const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264',
  h265: 'H.265 / HEVC',
  vp9: 'VP9',
  av1: 'AV1',
  prores: 'ProRes 422',
  xvid: 'Xvid (MPEG-4)',
  flv: 'Sorenson FLV',
  mpeg2: 'MPEG-2',
  theora: 'Theora',
};

const PRESETS: Preset[] = [
  { id: 'original', icon: 'film', tag: 'SRC', width: 0, height: 0 },
  { id: 'reels', icon: 'crop', tag: '9:16', width: 1080, height: 1920 },
  { id: 'square', icon: 'grid', tag: '1:1', width: 1080, height: 1080 },
  { id: 'uhd', icon: 'play', tag: '4K', width: 3840, height: 2160 },
  { id: 'youtube', icon: 'play', tag: '1080p', width: 1920, height: 1080 },
  { id: 'hd', icon: 'share', tag: '720p', width: 1280, height: 720 },
  { id: 'sd', icon: 'download', tag: '480p', width: 854, height: 480 },
  { id: 'discord', icon: 'zap', tag: '<25 MB', width: 1280, height: 720, cap: 24 * 1024 ** 2 },
];

const QUALITY = [
  { id: 'high', key: 'conv.q.high', factor: 1.4 },
  { id: 'balanced', key: 'conv.q.balanced', factor: 1 },
  { id: 'light', key: 'conv.q.light', factor: 0.55 },
] as const;

/** Relative output size per codec (H.264 = 1). */
const CODEC_SIZE: Record<string, number> = { h264: 1, h265: 0.6, vp9: 0.65, av1: 0.5, prores: 6, xvid: 1.3, flv: 1.6, mpeg2: 1.8, theora: 1.2 };
/** Rough encoding time per second of 1080p video (seconds), for the forecast. */
const CODEC_SPEED: Record<string, number> = { h264: 0.12, h265: 0.5, vp9: 0.6, av1: 1.4, prores: 0.2, xvid: 0.1, flv: 0.08, mpeg2: 0.08, theora: 0.25 };

@Component({
  selector: 'app-converter',
  imports: [Icon],
  templateUrl: './converter.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Converter {
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  protected readonly t = this.store.t;
  protected readonly presets = PRESETS;
  protected readonly qualities = QUALITY;
  protected readonly codecLabels = CODEC_LABELS;
  protected readonly bytes = formatBytes;
  protected readonly dur = formatDuration;
  protected readonly categories: { id: Category; icon: IconName; key: Key }[] = [
    { id: 'video', icon: 'film', key: 'conv.video' },
    { id: 'animation', icon: 'image', key: 'conv.animation' },
    { id: 'audio', icon: 'music', key: 'conv.audio' },
  ];

  protected readonly source = signal<Source | null>(null);
  protected readonly fileName = signal('');
  protected readonly category = signal<Category>('video');
  protected readonly formatId = signal('mp4');
  protected readonly codec = signal('h264');
  protected readonly presetId = signal('original');
  protected readonly qualityId = signal<(typeof QUALITY)[number]['id']>('balanced');
  protected readonly audioKbps = signal(192);
  protected readonly gifFps = signal(15);

  protected readonly formats = computed(() => FORMATS[this.category()]);
  protected readonly format = computed(() => this.formats().find((f) => f.id === this.formatId()) ?? this.formats()[0]);
  protected readonly preset = computed(() => PRESETS.find((p) => p.id === this.presetId())!);
  protected readonly libraryMedia = computed(() => this.store.files().filter((f) => f.kind !== 'gif').slice(0, 6));

  /** Output resolution for the selected profile. */
  protected readonly outSize = computed(() => {
    const p = this.preset();
    const s = this.source();
    const width = s?.width || 1920;
    const height = s?.height || 1080;
    if (p.id === 'original') return { width, height };
    if (['reels', 'square'].includes(p.id)) return { width: p.width, height: p.height };
    const h = Math.min(p.height, height);
    return { width: Math.round((width * h) / height / 2) * 2, height: h };
  });

  /** Estimated output size in bytes. */
  protected readonly estimate = computed(() => {
    const d = this.source()?.duration ?? 0;
    if (!d) return 0;
    const f = this.format();
    if (this.category() === 'audio') {
      const kbps = f.id === 'wav' || f.id === 'aiff' ? 1411 : f.lossless ? 850 : this.audioKbps();
      return (kbps * 1000 * d) / 8;
    }
    const factor = QUALITY.find((q) => q.id === this.qualityId())!.factor;
    if (this.category() === 'animation') {
      const width = [640, 480, 360][QUALITY.findIndex((q) => q.id === this.qualityId())];
      const ratio = this.outSize().height / this.outSize().width;
      return width * width * ratio * this.gifFps() * d * (f.id === 'webp' ? 0.02 : 0.05);
    }
    const { width, height } = this.outSize();
    const mbps = ((width * height) / (1920 * 1080)) * 8 * (CODEC_SIZE[this.codec()] ?? 1) * factor;
    const total = ((mbps * 1e6 + this.audioKbps() * 1000) * d) / 8;
    const cap = this.preset().cap;
    return cap ? Math.min(total, cap) : total;
  });

  /** Estimated processing time label. */
  protected readonly timeEstimate = computed(() => {
    const s = this.source();
    if (!s?.duration) return '—';
    const pixels = (this.outSize().width * this.outSize().height) / (1920 * 1080);
    const perSecond =
      this.category() === 'audio' ? 0.02 : this.category() === 'animation' ? 0.15 : (CODEC_SPEED[this.codec()] ?? 0.2) * pixels;
    return `~${shortDuration(this.t, s.duration * perSecond + 1)}`;
  });

  protected readonly delta = computed(() => {
    const s = this.source();
    return s?.size && this.estimate() ? Math.round((this.estimate() / s.size - 1) * 100) : 0;
  });

  constructor() {
    effect(() => {
      const incoming = this.store.incoming();
      if (incoming?.target === 'convert') {
        untracked(() => {
          this.store.incoming.set(null);
          this.load(incoming.source);
        });
      }
    });
    // A file deleted from the library can't stay selected here.
    effect(() => {
      const removed = this.store.removed();
      untracked(() => {
        const s = this.source();
        if (removed && s?.fileId === removed) {
          this.source.set(null);
          this.store.toast(this.t('toast.removed', { name: s.name }));
        }
      });
    });
    afterNextRender(() => {
      const input = document.getElementById('conv-file') as HTMLInputElement | null;
      if (input?.files?.length && !this.source()) this.pick(input);
    });
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
    if (file) this.load(this.store.uploadLocal(file));
  }

  /** Uses a library file as the source. */
  protected openFile(file: RemoteFile): void {
    this.load(sourceFromFile(file));
  }

  /** Sets the source and picks a sensible default category. */
  private load(s: Source): void {
    this.source.set(s);
    this.fileName.set(s.name);
    this.setCategory(s.kind === 'audio' ? 'audio' : 'video');
    whenUploaded(s, (updated) => this.source()?.url === s.url && this.source.set(updated));
  }

  /** Switches between video, animation and audio outputs. */
  protected setCategory(c: Category): void {
    this.category.set(c);
    this.selectFormat(FORMATS[c][0].id);
  }

  /** Selects an output format (and a valid codec for it). */
  protected selectFormat(id: string): void {
    this.formatId.set(id);
    const codecs = this.format().codecs;
    if (codecs.length && !codecs.includes(this.codec())) this.codec.set(codecs[0]);
  }

  /** Deletes the current file from the server and every section. */
  protected deleteSource(): void {
    const s = this.source();
    if (!s) return;
    this.source.set(null);
    void this.store.discard(s);
  }

  /** Starts the conversion. */
  protected convert(): void {
    const s = this.source();
    if (!s) return;
    const name = this.fileName().trim() || s.name;
    const options = {
      format: this.formatId(),
      codec: this.format().codecs.length ? this.codec() : null,
      preset: this.category() === 'audio' ? 'original' : this.presetId(),
      quality: this.qualityId(),
      audioKbps: this.audioKbps(),
      gifFps: this.gifFps(),
      name,
    };
    void this.store.run(async () => this.api.convert(await this.store.remoteId(s), options), { origin: 'convert', name });
    this.store.toast(this.t('conv.started'));
  }
}
