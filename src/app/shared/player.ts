// Music inside the Options menu, in two blocks:
//  - Player (top): a vinyl that slides out of its sleeve and spins while
//    playing, previous/play/next, progress, music and effects volume.
//  - Playlist (bottom): add songs from a YouTube or Spotify link (song or
//    playlist) or upload files; up to 30 songs kept in this browser, each
//    one removable.
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { formatBytes, formatDuration } from '../core/format';
import { Icon } from '../core/icon';
import { MAX_SONGS, MAX_SONG_BYTES, Music } from '../core/music';
import { Store } from '../core/store';

@Component({
  selector: 'app-player',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [attr.aria-label]="t('music.title')">
      <div class="flex items-center gap-4 p-4">
        <span class="record" [class.playing]="music.playing()" aria-hidden="true">
          <span class="record-disc"><span class="record-label"></span></span>
          <span class="record-sleeve"></span>
        </span>
        <div class="min-w-0 flex-1">
          <p class="label">{{ music.playing() ? t('music.playing') : t('music.idle') }}</p>
          <p class="truncate text-[17px] font-bold">{{ music.current()?.name ?? t('music.title') }}</p>
        </div>
      </div>

      <div class="px-4">
        <input
          type="range"
          class="range w-full"
          min="0"
          [max]="music.duration() || 1"
          step="0.1"
          [value]="music.time()"
          [disabled]="!music.duration()"
          [attr.aria-label]="t('music.position')"
          (input)="music.seek(+$any($event.target).value)"
        />
        <p class="label mt-1 flex justify-between tabular-nums">
          <span>{{ dur(music.time()) }}</span><span>{{ dur(music.duration()) }}</span>
        </p>
      </div>

      <div class="flex items-center justify-center gap-3 px-4 pt-2 pb-4">
        <button type="button" class="btn-icon" [disabled]="!music.playable()" [attr.aria-label]="t('music.previous')" (click)="music.previous()">
          <app-icon name="back" [size]="16" />
        </button>
        <button
          type="button"
          data-sfx="off"
          class="grid size-14 place-items-center bg-yellow text-ink shadow-[3px_3px_0_0_#000] transition-transform active:translate-x-0.5 active:translate-y-0.5 disabled:opacity-40"
          [disabled]="!music.playable()"
          [attr.aria-label]="music.playing() ? t('music.pause') : t('music.play')"
          (click)="music.toggle()"
        >
          <app-icon [name]="music.playing() ? 'pause' : 'play'" [size]="20" />
        </button>
        <button type="button" class="btn-icon" [disabled]="!music.playable()" [attr.aria-label]="t('music.next')" (click)="music.next()">
          <app-icon name="forward" [size]="16" />
        </button>
      </div>

      <div class="grid grid-cols-[auto_4.5rem_1fr_2.5rem] items-center gap-x-2 gap-y-3 border-t border-line-soft p-4">
        <app-icon name="music" [size]="15" class="text-muted" />
        <label for="music-volume" class="text-sm font-semibold">{{ t('music.music') }}</label>
        <input id="music-volume" type="range" class="range" min="0" max="100" step="5" [value]="music.volume() * 100"
          (input)="music.setVolume(+$any($event.target).value / 100)" />
        <span class="label text-right text-yellow!">{{ (music.volume() * 100).toFixed(0) }}%</span>

        <app-icon name="volume" [size]="15" class="text-muted" />
        <label for="sfx-volume" class="text-sm font-semibold">{{ t('music.sounds') }}</label>
        <input id="sfx-volume" type="range" class="range" min="0" max="100" step="5" [value]="store.sfx.volume() * 100"
          [disabled]="!store.sfx.enabled()" (change)="store.sfx.setVolume(+$any($event.target).value / 100)" />
        <span class="label text-right text-yellow!">{{ (store.sfx.volume() * 100).toFixed(0) }}%</span>
      </div>
    </section>
  `,
})
export class Player {
  protected readonly store = inject(Store);
  protected readonly music = inject(Music);
  protected readonly t = this.store.t;
  protected readonly dur = formatDuration;

  constructor() {
    void this.music.load();
  }
}

@Component({
  selector: 'app-playlist',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="p-4" aria-labelledby="playlist-title">
      <p class="flex items-center justify-between">
        <span id="playlist-title" class="label-mark text-text">{{ t('music.playlist') }}</span>
        <span class="tag">{{ music.songs().length }} / {{ max }}</span>
      </p>

      <form class="mt-3 flex" (submit)="$event.preventDefault(); addLink(link)">
        <label for="music-link" class="sr-only">{{ t('music.linkLabel') }}</label>
        <input
          #link
          id="music-link"
          type="url"
          inputmode="url"
          class="field min-h-10 min-w-0 flex-1 text-sm"
          [placeholder]="t('music.linkPlaceholder')"
          [disabled]="busy() || full()"
        />
        <button type="submit" class="btn btn-primary -ml-px min-h-10 px-3 text-xs" [disabled]="busy() || full()">
          @if (busy()) {
            <span class="spinner" aria-hidden="true"></span>
          } @else {
            <app-icon name="link" [size]="14" />
          }
          {{ t('music.add') }}
        </button>
      </form>
      <p class="mt-1.5 text-xs text-dim">{{ t('music.linkHint') }}</p>

      <ul class="mt-3 max-h-64 overflow-auto">
        @for (s of music.songs(); track s.id; let i = $index) {
          <li class="flex items-center border-b border-line-soft" [class.bg-overlay]="i === music.index()">
            <button type="button" class="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left disabled:opacity-60" [disabled]="s.loading" (click)="music.play(i)">
              <span class="grid w-5 place-items-center text-xs font-bold tabular-nums" [class]="i === music.index() ? 'text-yellow' : 'text-dim'">
                @if (s.loading) {
                  <span class="spinner" aria-hidden="true"></span>
                } @else if (i === music.index() && music.playing()) {
                  <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
                } @else {
                  {{ i + 1 }}
                }
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-semibold">{{ s.name }}</span>
                <span class="label flex gap-2">
                  @if (s.source === 'youtube') {
                    <span class="text-red-text">YouTube</span>
                  } @else if (s.source === 'spotify') {
                    <span class="text-[#1ed760]">Spotify</span>
                  }
                  @if (s.loading) {
                    <span>{{ t('music.loading') }}</span>
                  } @else {
                    <span>{{ bytes(s.size) }}</span>
                  }
                  @if (s.duration) {
                    <span>{{ dur(s.duration) }}</span>
                  }
                </span>
              </span>
            </button>
            <button type="button" class="grid size-9 shrink-0 place-items-center text-dim hover:text-red-text" [attr.aria-label]="t('music.remove', { name: s.name })" (click)="music.remove(s.id)">
              <app-icon [name]="s.loading ? 'x' : 'trash'" [size]="14" />
            </button>
          </li>
        } @empty {
          <li class="border border-dashed border-line p-5 text-center text-sm text-muted">{{ t('music.empty') }}</li>
        }
      </ul>
      <input #songs id="music-files" type="file" multiple accept="audio/*,.mp3,.m4a,.ogg,.opus,.wav,.flac" class="sr-only" (change)="upload(songs)" />
      <label for="music-files" class="btn btn-secondary mt-3 w-full min-h-11" [class.pointer-events-none]="full()" [class.opacity-40]="full()">
        <app-icon name="upload" [size]="15" /> {{ t('music.upload') }}
      </label>
      <p class="mt-2 text-center text-xs text-dim">{{ t('music.formats', { mb: maxMb }) }}</p>
    </section>
  `,
})
export class Playlist {
  protected readonly store = inject(Store);
  protected readonly music = inject(Music);
  protected readonly t = this.store.t;
  protected readonly bytes = formatBytes;
  protected readonly dur = formatDuration;
  protected readonly max = MAX_SONGS;
  protected readonly maxMb = MAX_SONG_BYTES / 1024 ** 2;
  protected readonly busy = signal(false);
  protected readonly full = () => this.music.songs().length >= MAX_SONGS;

  constructor() {
    void this.music.load();
    this.music.onLinkError = (name, err) =>
      this.store.toast(this.t('music.linkFailed', { name, reason: this.store.errorText(err) }), true);
  }

  /** Adds the songs of a YouTube/Spotify link (song or playlist). */
  protected async addLink(input: HTMLInputElement): Promise<void> {
    const url = input.value.trim();
    if (!url || this.busy()) return;
    this.busy.set(true);
    try {
      const { title, queued, skipped } = await this.music.addLink(url);
      input.value = '';
      this.store.toast(this.t('music.linkAdded', { n: queued, title }));
      if (skipped) this.store.toast(this.t('music.full', { n: skipped }), true);
    } catch (err) {
      this.store.toast(this.store.errorText(err), true);
    } finally {
      this.busy.set(false);
    }
  }

  /** Adds the chosen songs and reports anything that was skipped. */
  protected async upload(input: HTMLInputElement): Promise<void> {
    const files = input.files;
    if (!files?.length) return;
    const { added, rejected, full } = await this.music.add(files);
    input.value = '';
    if (added) this.store.toast(this.t('music.added', { n: added }));
    if (rejected) this.store.toast(this.t(full ? 'music.full' : 'music.rejected', { n: rejected, mb: this.maxMb }), true);
  }
}
