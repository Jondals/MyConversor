// App-wide state: active section, account and library, background jobs (polled
// from the server), toasts, open menus and display options.
import { Injectable, afterNextRender, computed, inject, signal } from '@angular/core';
import { Api, ApiError, ApiJob, MediaKind, Me, Origin, RemoteFile } from './api';
import { I18n, Key } from './i18n';
import { Sfx } from './sfx';

export type Section = 'download' | 'trim' | 'convert' | 'library';
export type Menu = 'options' | 'account' | null;

export const SECTIONS: { id: Section; hash: string }[] = [
  { id: 'download', hash: 'descargar' },
  { id: 'trim', hash: 'recortar' },
  { id: 'convert', hash: 'convertir' },
  { id: 'library', hash: 'biblioteca' },
];

/** Media being worked on. Local files play instantly while they upload. */
export interface Source {
  name: string;
  ext: string;
  size: number;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  platform: string | null;
  url: string;
  fileId?: string;
  thumb?: string | null;
  upload?: Promise<RemoteFile>;
}

export interface Job {
  id: string;
  name: string;
  origin: Origin;
  stage: string;
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number | null;
  /** Only exists in the browser (e.g. an upload in progress). */
  local: boolean;
}

export interface Toast {
  id: number;
  text: string;
  error?: boolean;
}

interface JobOptions {
  origin: Origin;
  name: string;
  /** Runs with the finished file; by default it is saved to the device. */
  onDone?: (file: RemoteFile) => void;
}

/** A Source for a file that is already on the server. */
export function sourceFromFile(file: RemoteFile): Source {
  return {
    name: file.name,
    ext: file.ext,
    size: file.size,
    kind: file.kind,
    duration: file.duration,
    width: file.width,
    height: file.height,
    platform: file.platform,
    url: file.url,
    fileId: file.id,
    thumb: file.thumb,
  };
}

/** Calls `apply` with `source` updated with server data once its upload finishes. */
export function whenUploaded(source: Source, apply: (updated: Source) => void): void {
  source.upload
    ?.then((remote) =>
      apply({
        ...source,
        fileId: remote.id,
        thumb: remote.thumb,
        duration: source.duration || remote.duration,
        width: source.width || remote.width,
        height: source.height || remote.height,
      }),
    )
    .catch(() => undefined);
}

const POLL_MS = 600;
const MOTION_KEY = 'mc.motion';
let uid = 0;

@Injectable({ providedIn: 'root' })
export class Store {
  private readonly api = inject(Api);
  readonly sfx = inject(Sfx);
  readonly i18n = inject(I18n);
  readonly t = this.i18n.t;

  readonly section = signal<Section>('download');
  readonly visited = signal<Set<Section>>(new Set(['download']));
  readonly incoming = signal<{ target: Section; source: Source } | null>(null);
  /** Id of the last deleted file, so every section can drop it. */
  readonly removed = signal<string | null>(null);
  readonly menu = signal<Menu>(null);
  readonly reduceMotion = signal(false);
  /** Real server status from /api/health (null until the first check). */
  readonly online = signal<boolean | null>(null);
  /** Round-trip time of the last health check, in ms. */
  readonly latency = signal<number | null>(null);

  readonly me = signal<Me | null>(null);
  readonly files = signal<RemoteFile[]>([]);
  readonly jobs = signal<Job[]>([]);
  readonly toasts = signal<Toast[]>([]);

  readonly guest = computed(() => this.me()?.guest !== false);
  readonly used = computed(() => this.me()?.used ?? 0);
  readonly quota = computed(() => this.me()?.quota ?? 10 * 1024 ** 3);

  private readonly jobOptions = new Map<string, JobOptions>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    afterNextRender(() => {
      const fromHash = SECTIONS.find((s) => `#${s.hash}` === location.hash)?.id;
      if (fromHash) this.go(fromHash, false);
      addEventListener('popstate', () => {
        this.go(SECTIONS.find((x) => `#${x.hash}` === location.hash)?.id ?? 'download', false);
      });
      try {
        this.setReduceMotion(localStorage.getItem(MOTION_KEY) === '1', false);
      } catch {
        /* storage blocked */
      }
      void this.reload();
      // Real status: asks the server every 30 s (and when the tab or the network comes back).
      void this.checkHealth();
      setInterval(() => !document.hidden && void this.checkHealth(), 30_000);
      document.addEventListener('visibilitychange', () => !document.hidden && void this.checkHealth());
      addEventListener('online', () => void this.checkHealth());
      addEventListener('offline', () => this.online.set(false));
    });
  }

  /** Pings the server; online only if it answers and FFmpeg and yt-dlp are installed. */
  async checkHealth(): Promise<void> {
    const start = performance.now();
    try {
      const { ok } = await this.api.health();
      this.latency.set(Math.round(performance.now() - start));
      this.online.set(ok);
    } catch {
      this.latency.set(null);
      this.online.set(false);
    }
  }

  // ------------------------------------------------------------ navigation

  /** Shows a section (the others stay alive, hidden). */
  go(section: Section, push = true): void {
    this.menu.set(null);
    if (section === this.section()) return;
    this.section.set(section);
    this.visited.update((v) => new Set(v).add(section));
    if (push) {
      history.pushState(null, '', `#${SECTIONS.find((s) => s.id === section)!.hash}`);
      this.sfx.tab();
    }
    scrollTo({ top: 0, behavior: this.reduceMotion() ? 'auto' : 'smooth' });
  }

  /** Opens a source in the trimmer or converter. */
  open(target: 'trim' | 'convert', source: Source): void {
    this.incoming.set({ target, source });
    this.go(target);
  }

  /** Opens/closes a header menu. */
  toggleMenu(menu: Exclude<Menu, null>): void {
    this.menu.update((m) => (m === menu ? null : menu));
  }

  /** Turns reduced motion on/off (also honoured via prefers-reduced-motion). */
  setReduceMotion(on: boolean, remember = true): void {
    this.reduceMotion.set(on);
    document.documentElement.classList.toggle('reduce-motion', on);
    if (remember) {
      try {
        localStorage.setItem(MOTION_KEY, on ? '1' : '0');
      } catch {
        /* storage blocked */
      }
    }
  }

  // --------------------------------------------------------------- library

  /** Refreshes the account summary and the library from the server. */
  async reload(): Promise<void> {
    try {
      const { files, ...me } = await this.api.library();
      this.files.set(files);
      this.me.set(me);
    } catch {
      /* the health check reports the connection state */
    }
  }

  /** Starts uploading a local file; it can be previewed immediately. */
  uploadLocal(file: File): Source {
    const dot = file.name.lastIndexOf('.');
    const source: Source = {
      name: dot > 0 ? file.name.slice(0, dot) : file.name,
      ext: dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '',
      size: file.size,
      kind: file.type.startsWith('audio') ? 'audio' : 'video',
      duration: 0,
      width: 0,
      height: 0,
      platform: null,
      url: URL.createObjectURL(file),
    };
    const id = `up-${uid++}`;
    this.jobs.update((j) => [...j, this.localJob(id, this.t('jobs.uploading', { name: file.name }), 'upload')]);
    source.upload = this.api
      .upload(file, (p) => this.patchJob(id, { progress: p, downloaded: p * file.size, total: file.size }))
      .then((remote) => {
        source.fileId = remote.id;
        this.sfx.success();
        this.toast(this.t(this.guest() ? 'toast.uploaded' : 'toast.saved', { name: remote.name }));
        void this.reload();
        return remote;
      })
      .catch((err) => {
        this.fail(err);
        throw err;
      })
      .finally(() => this.jobs.update((j) => j.filter((x) => x.id !== id)));
    source.upload.catch(() => undefined);
    return source;
  }

  /** Waits for a pending upload and returns the server id. */
  async remoteId(source: Source): Promise<string> {
    if (source.fileId) return source.fileId;
    if (!source.upload) throw new ApiError('file_gone', 'No file');
    return (await source.upload).id;
  }

  /** Renames a library file. */
  async rename(file: RemoteFile, name: string): Promise<void> {
    const clean = name.trim();
    if (!clean || clean === file.name) return;
    try {
      const updated = await this.api.rename(file.id, clean);
      this.files.update((list) => list.map((f) => (f.id === file.id ? updated : f)));
      this.sfx.success();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Deletes a file on the server (and from disk); every section drops it too. */
  async remove(file: Pick<RemoteFile, 'id' | 'name'>): Promise<void> {
    try {
      await this.api.remove(file.id);
      this.files.update((list) => list.filter((f) => f.id !== file.id));
      this.removed.set(file.id);
      this.toast(this.t('toast.deleted', { name: file.name }));
      void this.reload();
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Deletes the file behind a section's source (waiting for its upload if it
   * is still going). The caller clears its own source first.
   */
  async discard(source: Source): Promise<void> {
    let id = source.fileId;
    if (!id && source.upload) id = await source.upload.then((f) => f.id).catch(() => undefined);
    if (id) await this.remove({ id, name: source.name });
    else this.toast(this.t('toast.deleted', { name: source.name }));
  }

  // ------------------------------------------------------------------ jobs

  /** Starts a server job and follows it until it finishes. */
  async run(start: () => Promise<ApiJob>, opts: JobOptions): Promise<void> {
    const tempId = `local-${uid++}`;
    this.jobs.update((j) => [...j, this.localJob(tempId, opts.name, opts.origin)]);
    this.sfx.start();
    try {
      const job = await start();
      if (!this.jobs().some((j) => j.id === tempId)) {
        void this.api.cancel(job.id).catch(() => undefined); // cancelled while starting
        return;
      }
      this.jobOptions.set(job.id, opts);
      this.jobs.update((list) => list.map((j) => (j.id === tempId ? this.fromApi(job, opts) : j)));
      this.schedule();
    } catch (err) {
      this.jobs.update((list) => list.filter((j) => j.id !== tempId));
      this.fail(err);
    }
  }

  /** Cancels a job (locally and on the server). */
  cancel(id: string): void {
    this.jobs.update((list) => list.filter((j) => j.id !== id));
    this.jobOptions.delete(id);
    if (!/^(local|up)-/.test(id)) void this.api.cancel(id).catch(() => undefined);
  }

  /** Schedules the next progress poll. */
  private schedule(): void {
    this.timer ??= setTimeout(() => void this.poll(), POLL_MS);
  }

  /** Updates every running job and finishes the ones that are done. */
  private async poll(): Promise<void> {
    this.timer = undefined;
    const ids = this.jobs().filter((j) => !j.local).map((j) => j.id);
    const results = await Promise.all(ids.map((id) => this.api.job(id).catch(() => null)));
    for (const job of results) {
      const opts = job && this.jobOptions.get(job.id);
      if (!job || !opts) continue;
      if (job.status === 'running' || job.status === 'queued') {
        this.jobs.update((list) => list.map((j) => (j.id === job.id ? this.fromApi(job, opts) : j)));
        continue;
      }
      this.jobs.update((list) => list.filter((j) => j.id !== job.id));
      this.jobOptions.delete(job.id);
      if (job.status === 'error') this.fail(new ApiError(job.code ?? 'generic', job.error ?? ''));
      if (job.status === 'done' && job.file) this.finish(job.file, opts);
    }
    if (this.jobs().some((j) => !j.local)) this.schedule();
  }

  /** Handles a finished job: library, sound and download (or custom action). */
  private finish(file: RemoteFile, opts: JobOptions): void {
    this.files.update((list) => [file, ...list.filter((f) => f.id !== file.id)]);
    void this.reload();
    this.sfx.success();
    if (opts.onDone) {
      opts.onDone(file);
    } else {
      this.api.save(file, file.name);
      this.toast(this.t('toast.downloaded', { name: `${file.name}.${file.ext}` }));
    }
  }

  /** Creates a client-side job entry before the server answers. */
  private localJob(id: string, name: string, origin: Origin): Job {
    return { id, name, origin, stage: 'preparing', progress: 0, downloaded: 0, total: 0, speed: 0, eta: null, local: true };
  }

  /** Updates one job in the list. */
  private patchJob(id: string, patch: Partial<Job>): void {
    this.jobs.update((list) => list.map((j) => (j.id === id ? { ...j, stage: 'uploading', ...patch } : j)));
  }

  /** Maps a server job to the UI job model. */
  private fromApi(job: ApiJob, opts: JobOptions): Job {
    const { id, stage, progress, downloaded, total, speed, eta } = job;
    return { id, name: opts.name, origin: opts.origin, stage, progress, downloaded, total, speed, eta, local: false };
  }

  // ---------------------------------------------------------------- toasts

  /** Translated message for an error. */
  errorText(err: unknown): string {
    if (err instanceof ApiError) {
      const key = `err.${err.code}` as Key;
      const text = this.t(key);
      return text === key ? err.message || this.t('err.generic') : text;
    }
    return (err as Error)?.message || this.t('err.generic');
  }

  /** Shows an error toast with the error sound. */
  fail(err: unknown): void {
    if (err instanceof ApiError && err.code === 'offline') this.online.set(false);
    this.sfx.error();
    this.toast(this.errorText(err), true);
  }

  /** Shows a short message at the bottom of the screen. */
  toast(text: string, error = false): void {
    const id = Date.now() + Math.random();
    this.toasts.update((t) => [...t.slice(-2), { id, text, error }]);
    setTimeout(() => this.toasts.update((t) => t.filter((x) => x.id !== id)), error ? 6500 : 3500);
  }
}
