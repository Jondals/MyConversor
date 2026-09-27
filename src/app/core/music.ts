// Background music player: songs you upload, or add from a YouTube/Spotify
// link (song or playlist), are kept in this browser (IndexedDB) and play in a
// loop while you work. Linked songs are fetched through the server, which
// doesn't keep them. The player lives in this service, so music keeps playing
// when the menu closes.
import { Injectable, computed, inject, signal } from '@angular/core';
import { Api, MusicItem } from './api';

export interface Song {
  id: string;
  name: string;
  size: number;
  addedAt: number;
  /** Where it came from. */
  source?: 'file' | 'youtube' | 'spotify';
  /** Seconds, when known before playing (linked songs). */
  duration?: number;
  /** Set while a linked song is still downloading. */
  loading?: boolean;
}

interface StoredSong extends Song {
  blob: Blob;
}

/** Songs a playlist can hold, and the size limit of an uploaded file (about 1 h of audio). */
export const MAX_SONGS = 30;
export const MAX_SONG_BYTES = 200 * 1024 ** 2;
export const SONG_TYPES = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i;

const DB = 'mc-music';
const STORE = 'songs';
const VOLUME_KEY = 'mc.music-volume';

export type AddResult = { added: number; rejected: number; full: boolean };
export type LinkResult = { title: string; queued: number; skipped: number };

@Injectable({ providedIn: 'root' })
export class Music {
  private readonly api = inject(Api);
  readonly songs = signal<Song[]>([]);
  readonly index = signal(-1);
  readonly playing = signal(false);
  readonly volume = signal(0.6);
  readonly time = signal(0);
  readonly duration = signal(0);
  readonly current = computed<Song | null>(() => this.songs()[this.index()] ?? null);

  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private db: Promise<IDBDatabase> | null = null;
  private loaded = false;
  /** Songs that couldn't be stored (private mode) stay in memory. */
  private readonly memory = new Map<string, Blob>();
  /** Downloads in progress, so removing a loading song cancels it. */
  private readonly downloads = new Map<string, AbortController>();
  /** Linked songs waiting to be fetched (one at a time). */
  private queue: { id: string; item: MusicItem }[] = [];
  private fetching = false;
  /** Called when a linked song fails to download. */
  onLinkError: (name: string, err: unknown) => void = () => {};

  constructor() {
    try {
      const saved = Number(localStorage.getItem(VOLUME_KEY));
      if (localStorage.getItem(VOLUME_KEY) !== null && saved >= 0 && saved <= 1) this.volume.set(saved);
    } catch {
      /* storage blocked (or server render) */
    }
  }

  /** Reads the saved playlist the first time the menu opens. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const all = await this.request<StoredSong[]>((s) => s.getAll());
      this.songs.set(all.sort((a, b) => a.addedAt - b.addedAt).map(({ blob: _, ...song }) => song));
    } catch {
      /* IndexedDB unavailable (private mode): the playlist just isn't kept */
    }
  }

  /** Adds audio files to the playlist (skips non-audio, too big, or over the limit). */
  async add(files: FileList | File[]): Promise<AddResult> {
    await this.load();
    const result: AddResult = { added: 0, rejected: 0, full: false };
    for (const file of Array.from(files)) {
      if (this.songs().length >= MAX_SONGS) {
        result.full = true;
        result.rejected++;
        continue;
      }
      const isAudio = file.type.startsWith('audio/') || SONG_TYPES.test(file.name);
      if (!isAudio || file.size > MAX_SONG_BYTES) {
        result.rejected++;
        continue;
      }
      const meta: Song = {
        id: crypto.randomUUID(),
        name: file.name.replace(/\.[^.]+$/, ''),
        size: file.size,
        addedAt: Date.now() + result.added,
        source: 'file',
      };
      await this.keep(meta, file);
      this.songs.update((list) => [...list, meta]);
      result.added++;
    }
    if (result.added && this.index() < 0) this.index.set(0);
    return result;
  }

  /**
   * Adds the songs of a YouTube or Spotify link (song, playlist or album). They
   * show up at once as "loading" and are downloaded one after another.
   */
  async addLink(url: string): Promise<LinkResult> {
    await this.load();
    const { title, items } = await this.api.musicResolve(url);
    const source = /spotify\.com/i.test(url) ? 'spotify' : 'youtube';
    const free = Math.max(0, MAX_SONGS - this.songs().length);
    const taken = items.slice(0, free);
    const now = Date.now();
    const added = taken.map((item, i): Song => ({
      id: crypto.randomUUID(),
      name: item.title,
      size: 0,
      addedAt: now + i,
      source,
      duration: item.duration || undefined,
      loading: true,
    }));
    this.songs.update((list) => [...list, ...added]);
    this.queue.push(...added.map((song, i) => ({ id: song.id, item: taken[i] })));
    void this.drain();
    return { title, queued: added.length, skipped: items.length - added.length };
  }

  /** Downloads queued linked songs one by one, storing each as it arrives. */
  private async drain(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    while (this.queue.length) {
      const { id, item } = this.queue.shift()!;
      if (!this.songs().some((s) => s.id === id)) continue;
      const controller = new AbortController();
      this.downloads.set(id, controller);
      try {
        const blob = await this.api.musicAudio(item, controller.signal);
        const song = this.songs().find((s) => s.id === id);
        if (!song) continue;
        const ready: Song = { ...song, size: blob.size, loading: undefined };
        await this.keep(ready, blob);
        this.songs.update((list) => list.map((s) => (s.id === id ? ready : s)));
        if (this.index() < 0) this.index.set(this.songs().findIndex((s) => s.id === id));
      } catch (err) {
        if (controller.signal.aborted) continue;
        const name = this.songs().find((s) => s.id === id)?.name ?? item.title;
        this.songs.update((list) => list.filter((s) => s.id !== id));
        this.onLinkError(name, err);
      } finally {
        this.downloads.delete(id);
      }
    }
    this.fetching = false;
  }

  /** Saves a song in IndexedDB (or in memory when the browser won't). */
  private async keep(meta: Song, blob: Blob): Promise<void> {
    const stored: StoredSong = { ...meta, blob };
    delete stored.loading;
    try {
      await this.request((s) => s.put(stored), 'readwrite');
    } catch {
      /* not persisted; still playable this session */
      this.memory.set(meta.id, blob);
    }
  }

  /** Removes a song from the playlist (and from the browser storage). */
  async remove(id: string): Promise<void> {
    const i = this.songs().findIndex((s) => s.id === id);
    if (i < 0) return;
    const wasCurrent = i === this.index();
    this.downloads.get(id)?.abort();
    this.songs.update((list) => list.filter((s) => s.id !== id));
    this.memory.delete(id);
    try {
      await this.request((s) => s.delete(id), 'readwrite');
    } catch {
      /* nothing stored */
    }
    if (wasCurrent) {
      this.stop();
      if (this.songs().length) void this.play(Math.min(i, this.songs().length - 1), this.playing());
      else this.index.set(-1);
    } else if (i < this.index()) {
      this.index.update((n) => n - 1);
    }
  }

  /** Plays the song at `i` (or just selects it when `autoplay` is false). */
  async play(i: number, autoplay = true): Promise<void> {
    const song = this.songs()[i];
    if (!song || song.loading) return;
    const blob = this.memory.get(song.id) ?? (await this.request<StoredSong>((s) => s.get(song.id)).catch(() => null))?.blob;
    if (!blob) return;
    const audio = this.player();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    audio.src = this.url;
    this.index.set(i);
    this.time.set(0);
    if (autoplay) await audio.play().catch(() => this.playing.set(false));
  }

  /** Whether at least one song is ready to play. */
  readonly playable = computed(() => this.songs().some((s) => !s.loading));

  /** Play/pause; starts the first ready song when nothing is loaded yet. */
  async toggle(): Promise<void> {
    if (!this.playable()) return;
    if (!this.audio?.src) return this.play(this.step(Math.max(0, this.index()) - 1, 1));
    if (this.audio.paused) await this.audio.play().catch(() => undefined);
    else this.audio.pause();
  }

  /** Next ready song (wraps around, skipping ones still downloading). */
  next(): void {
    if (this.playable()) void this.play(this.step(this.index(), 1));
  }

  /** Previous ready song, or back to the start if more than 3 s have played. */
  previous(): void {
    if (!this.playable()) return;
    if (this.audio && this.audio.currentTime > 3) this.audio.currentTime = 0;
    else void this.play(this.step(this.index(), -1));
  }

  /** Index of the next ready song from `from` in direction `dir`. */
  private step(from: number, dir: 1 | -1): number {
    const list = this.songs();
    const n = list.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (!list[i].loading) return i;
    }
    return -1;
  }

  /** Jumps to a position (seconds). */
  seek(seconds: number): void {
    if (this.audio?.src) this.audio.currentTime = seconds;
  }

  /** Music volume from 0 to 1, remembered in this browser. */
  setVolume(value: number): void {
    this.volume.set(value);
    if (this.audio) this.audio.volume = value;
    try {
      localStorage.setItem(VOLUME_KEY, String(value));
    } catch {
      /* storage blocked */
    }
  }

  /** Stops playback and releases the current file. */
  private stop(): void {
    this.audio?.pause();
    this.audio?.removeAttribute('src');
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.playing.set(false);
    this.time.set(0);
    this.duration.set(0);
  }

  /** Creates the audio element once and wires its events to the signals. */
  private player(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.volume = this.volume();
    audio.addEventListener('play', () => this.playing.set(true));
    audio.addEventListener('pause', () => this.playing.set(false));
    audio.addEventListener('timeupdate', () => this.time.set(audio.currentTime));
    audio.addEventListener('loadedmetadata', () => this.duration.set(audio.duration || 0));
    audio.addEventListener('ended', () => this.next());
    this.audio = audio;
    return audio;
  }

  /** Runs one IndexedDB request on the songs store. */
  private async request<T>(run: (store: IDBObjectStore) => IDBRequest, mode: IDBTransactionMode = 'readonly'): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }

  /** Opens (and creates, the first time) the browser database. */
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }
}
