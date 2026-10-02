// Converter section: picks a source (upload or library) and offers only the
// outputs that file can become (video, animation, audio, image or document),
// with codec, quality, profile and bitrate/fps settings, an estimate of the
// result's size and time, and runs the conversion on the server (FFmpeg or
// LibreOffice). The layout keeps the same height for every output group so
// switching tabs never makes the page jump.
import { ChangeDetectionStrategy, Component, afterNextRender, computed, effect, inject, signal, untracked } from '@angular/core';
import { Api, RemoteFile } from '../../core/api';
import { ACCEPT, GROUPS, Group, TARGETS, Target, needsOffice, targetsFor } from '../../core/formats';
import { Icon, IconName } from '../../core/icon';
import { Source, Store, sourceFromFile, whenUploaded } from '../../core/store';
import { formatBytes, formatDuration, shortDuration } from '../../core/format';

interface Preset {
  id: string;
  tag: string;
  width: number;
  height: number;
  /** Crops to fill the frame instead of limiting the height. */
  crop?: boolean;
  /** Size cap in bytes, if any. */
  cap?: number;
}

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

/** Output profiles; the server applies the same ones (server/media.mjs PRESETS). */
const PRESETS: Preset[] = [
  { id: 'original', tag: 'SRC', width: 0, height: 0 },
  { id: 'reels', tag: '9:16', width: 1080, height: 1920, crop: true },
  { id: 'square', tag: '1:1', width: 1080, height: 1080, crop: true },
  { id: 'uhd', tag: '4K', width: 3840, height: 2160 },
  { id: 'youtube', tag: '1080p', width: 1920, height: 1080 },
  { id: 'hd', tag: '720p', width: 1280, height: 720 },
  { id: 'sd', tag: '480p', width: 854, height: 480 },
  { id: 'discord', tag: '<25 MB', width: 1280, height: 720, cap: 24 * 1024 ** 2 },
];

const QUALITY = [
  { id: 'high', factor: 1.4 },
  { id: 'balanced', factor: 1 },
  { id: 'light', factor: 0.55 },
] as const;
type Quality = (typeof QUALITY)[number]['id'];

/** Relative output size per codec (H.264 = 1). */
const CODEC_SIZE: Record<string, number> = { h264: 1, h265: 0.6, vp9: 0.65, av1: 0.5, prores: 6, xvid: 1.3, flv: 1.6, mpeg2: 1.8, theora: 1.2 };
/** Rough encoding time per second of 1080p video (seconds), for the forecast. */
const CODEC_SPEED: Record<string, number> = { h264: 0.12, h265: 0.5, vp9: 0.6, av1: 1.4, prores: 0.2, xvid: 0.1, flv: 0.08, mpeg2: 0.08, theora: 0.25 };
/** Bytes per pixel of a still image per format (balanced quality). */
const IMAGE_BPP: Record<string, number> = { png: 1.6, jpg: 0.22, webp: 0.14, avif: 0.08, bmp: 3, tiff: 3, ico: 2, gif: 0.6 };
/** Lossy image formats whose quality can be chosen. */
const LOSSY_IMAGES = ['jpg', 'webp', 'avif'];

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
  protected readonly groups = GROUPS;
  protected readonly presets = PRESETS;
  protected readonly qualities = QUALITY;
  protected readonly codecLabels = CODEC_LABELS;
  protected readonly accept = ACCEPT;
  protected readonly bytes = formatBytes;
  protected readonly dur = formatDuration;

  protected readonly source = signal<Source | null>(null);
  protected readonly fileName = signal('');
  protected readonly group = signal<Group>('video');
  protected readonly formatId = signal('mp4');
  protected readonly codec = signal('h264');
  protected readonly presetId = signal('original');
  protected readonly qualityId = signal<Quality>('balanced');
  protected readonly audioKbps = signal(192);
  protected readonly gifFps = signal(15);

  /** Possible outputs for the current file (every one before a file is picked). */
  private readonly available = computed(() => targetsFor(this.source()?.ext ?? null));
  protected readonly formats = computed<Target[]>(() => {
    const ids = this.available()[this.group()] ?? [];
    return TARGETS[this.group()].filter((f) => ids.includes(f.id));
  });
  protected readonly format = computed(() => this.formats().find((f) => f.id === this.formatId()) ?? this.formats()[0] ?? TARGETS.video[0]);
  protected readonly preset = computed(() => PRESETS.find((p) => p.id === this.presetId())!);
  protected readonly libraryFiles = computed(() => this.store.files().slice(0, 30));

  // Which settings apply to the current output (the rest are shown disabled).
  protected readonly usesCodec = computed(() => this.group() === 'video');
  protected readonly usesQuality = computed(
    () => ['video', 'animation'].includes(this.group()) || (this.group() === 'image' && LOSSY_IMAGES.includes(this.format().id)),
  );
  protected readonly usesProfile = computed(() => ['video', 'animation', 'image'].includes(this.group()) && this.format().id !== 'ico');
  protected readonly usesBitrate = computed(() => this.group() === 'video' || (this.group() === 'audio' && !this.format().lossless));
  /** Document conversions need LibreOffice on the server. */
  protected readonly blocked = computed(() => {
    const s = this.source();
    return needsOffice(s?.ext ?? '', this.group()) && !this.store.office();
  });

  /** Whether a tab can be used with the current file. */
  protected enabled(g: Group): boolean {
    return Boolean(this.available()[g]?.length);
  }

  /** Output resolution for the selected profile. */
  protected readonly outSize = computed(() => {
    const p = this.usesProfile() ? this.preset() : PRESETS[0];
    const s = this.source();
    const width = s?.width || 1920;
    const height = s?.height || 1080;
    if (this.format().id === 'ico') return { width: 256, height: Math.round((256 * height) / width) };
    if (p.id === 'original') return { width, height };
    if (p.crop) return { width: p.width, height: p.height };
    const h = Math.min(p.height, height);
    return { width: Math.round((width * h) / height / 2) * 2, height: h };
  });

  /** Estimated output size in bytes (0 = can't tell). */
  protected readonly estimate = computed(() => {
    const s = this.source();
    if (!s) return 0;
    const f = this.format();
    const q = QUALITY.find((x) => x.id === this.qualityId())!.factor;
    const { width, height } = this.outSize();
    switch (this.group()) {
      case 'document':
        return 0;
      case 'image':
        return width * height * (IMAGE_BPP[f.id] ?? 1) * (LOSSY_IMAGES.includes(f.id) ? q : 1);
      case 'audio': {
        const kbps = f.id === 'wav' || f.id === 'aiff' ? 1411 : f.lossless ? 850 : this.audioKbps();
        return (kbps * 1000 * s.duration) / 8;
      }
      case 'animation': {
        const w = [640, 480, 360][QUALITY.findIndex((x) => x.id === this.qualityId())];
        return w * w * (height / width) * this.gifFps() * s.duration * (f.id === 'webp' ? 0.02 : 0.05);
      }
      default: {
        const mbps = ((width * height) / (1920 * 1080)) * 8 * (CODEC_SIZE[this.codec()] ?? 1) * q;
        const total = ((mbps * 1e6 + this.audioKbps() * 1000) * s.duration) / 8;
        const cap = this.preset().cap;
        return cap ? Math.min(total, cap) : total;
      }
    }
  });

  /** Estimated processing time label. */
  protected readonly timeEstimate = computed(() => {
    const s = this.source();
    if (!s) return '—';
    const g = this.group();
    if (g === 'document' || needsOffice(s.ext, g)) return `~${shortDuration(this.t, 5)}`;
    if (g === 'image') return `~${shortDuration(this.t, 1)}`;
    if (!s.duration) return '—';
    const pixels = (this.outSize().width * this.outSize().height) / (1920 * 1080);
    const perSecond = g === 'audio' ? 0.02 : g === 'animation' ? 0.15 : (CODEC_SPEED[this.codec()] ?? 0.2) * pixels;
    return `~${shortDuration(this.t, s.duration * perSecond + 1)}`;
  });

  /** Size change against the source, in %. */
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

  /** Uses the library file chosen in the selector as the source. */
  protected openFile(id: string): void {
    const file = this.store.files().find((f: RemoteFile) => f.id === id);
    if (file) this.load(sourceFromFile(file));
  }

  /** Sets the source and opens the output group that fits it best. */
  private load(s: Source): void {
    this.source.set(s);
    this.fileName.set(s.name);
    const preferred: Record<string, Group> = { audio: 'audio', image: 'image', document: 'document', gif: 'video', video: 'video' };
    const first = this.enabled(preferred[s.kind]) ? preferred[s.kind] : GROUPS.find((g) => this.enabled(g.id))!.id;
    this.setGroup(first);
    whenUploaded(s, (updated) => this.source()?.url === s.url && this.source.set(updated));
  }

  /** Switches the output group (only to one the file supports). */
  protected setGroup(g: Group): void {
    if (!this.enabled(g)) return;
    this.group.set(g);
    this.selectFormat(this.formats()[0].id);
  }

  /** Selects an output format (and a valid codec for it). */
  protected selectFormat(id: string): void {
    this.formatId.set(id);
    const codecs = this.format().codecs ?? [];
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
    if (!s || this.blocked()) return;
    const name = this.fileName().trim() || s.name;
    const options = {
      group: this.group(),
      format: this.format().id,
      codec: this.usesCodec() ? this.codec() : null,
      preset: this.usesProfile() ? this.presetId() : 'original',
      quality: this.qualityId(),
      audioKbps: this.audioKbps(),
      gifFps: this.gifFps(),
      name,
    };
    void this.store.run(async () => this.api.convert(await this.store.remoteId(s), options), { origin: 'convert', name });
    this.store.toast(this.t('conv.started'));
  }

  /** Translation key with a one-line description of an output format. */
  protected desc(id: string): string {
    const prefix = this.group() === 'image' ? 'fmti' : this.group() === 'document' ? 'fmtd' : 'fmt';
    return `${prefix}.${id}`;
  }

  /** Small print under the output format in the forecast. */
  protected outLabel(): string {
    const g = this.group();
    if (g === 'document') return `.${this.format().ext}`;
    if (g === 'audio') return this.format().lossless ? this.t('conv.lossless') : `${this.audioKbps()} kbps`;
    const { width, height } = this.outSize();
    return this.source() ? `${width}×${height}` : '';
  }

  /** Icon for a file kind. */
  protected kindIcon(kind: string): IconName {
    return ({ audio: 'music', image: 'image', document: 'file', gif: 'zap' } as Record<string, IconName>)[kind] ?? 'film';
  }
}
