// Library section: storage used per type, search, filters, sorting, grid/list
// views and actions for every file (play, trim, convert, download, rename,
// share, delete). Guests also see an invitation to sign up.
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Api, Origin, RemoteFile } from '../../core/api';
import { Icon, IconName } from '../../core/icon';
import { Key } from '../../core/i18n';
import { Store, sourceFromFile } from '../../core/store';
import { formatBytes, formatDuration, timeLeft } from '../../core/format';

type Filter = 'all' | Origin;
type Sort = 'newest' | 'oldest' | 'largest' | 'name';

const ORIGIN: Record<Origin, { key: Key; icon: IconName; color: string }> = {
  download: { key: 'lib.o.download', icon: 'download', color: '#facc15' },
  trim: { key: 'lib.o.trim', icon: 'scissors', color: '#3b82f6' },
  convert: { key: 'lib.o.convert', icon: 'convert', color: '#ef4444' },
  upload: { key: 'lib.o.upload', icon: 'upload', color: '#94a3b8' },
};

const SORTERS: Record<Sort, (a: RemoteFile, b: RemoteFile) => number> = {
  newest: (a, b) => b.createdAt - a.createdAt,
  oldest: (a, b) => a.createdAt - b.createdAt,
  largest: (a, b) => b.size - a.size,
  name: (a, b) => a.name.localeCompare(b.name),
};

@Component({
  selector: 'app-library',
  imports: [Icon],
  templateUrl: './library.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Library {
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('player');
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('rename');

  protected readonly t = this.store.t;
  protected readonly origin = ORIGIN;
  protected readonly origins = Object.keys(ORIGIN) as Origin[];
  protected readonly sorts = Object.keys(SORTERS) as Sort[];
  protected readonly views: { id: 'grid' | 'list'; key: Key }[] = [
    { id: 'grid', key: 'lib.grid' },
    { id: 'list', key: 'lib.list' },
  ];
  protected readonly bytes = formatBytes;
  protected readonly dur = formatDuration;
  protected readonly left = (ts: number) => timeLeft(this.t, ts);

  protected readonly filter = signal<Filter>('all');
  protected readonly query = signal('');
  protected readonly sort = signal<Sort>('newest');
  protected readonly view = signal<'grid' | 'list'>('grid');
  protected readonly editing = signal<string | null>(null);
  protected readonly playing = signal<RemoteFile | null>(null);

  /** Files after filter, search and sort. */
  protected readonly items = computed(() => {
    const f = this.filter();
    const q = this.query().trim().toLowerCase();
    return this.store
      .files()
      .filter((i) => (f === 'all' || i.origin === f) && (!q || `${i.name}.${i.ext}`.toLowerCase().includes(q)))
      .sort(SORTERS[this.sort()]);
  });

  /** Space used per origin, for the segmented storage bar. */
  protected readonly usage = computed(() => {
    const quota = this.store.quota();
    return this.origins.map((o) => {
      const bytes = this.store.files().filter((f) => f.origin === o).reduce((s, f) => s + f.size, 0);
      return { origin: o, bytes, pct: (bytes / quota) * 100 };
    });
  });
  protected readonly free = computed(() => Math.max(0, this.store.quota() - this.store.used()));

  constructor() {
    effect(() => {
      const input = this.renameInput()?.nativeElement;
      input?.focus();
      input?.select();
    });
    // Refresh when the section is opened (expiry countdowns, other devices).
    effect(() => {
      if (this.store.section() === 'library') void this.store.reload();
    });
  }

  /** Number of files for a filter chip. */
  protected count(f: Filter): number {
    const list = this.store.files();
    return f === 'all' ? list.length : list.filter((i) => i.origin === f).length;
  }

  /** Opens the player dialog. */
  protected play(file: RemoteFile): void {
    this.playing.set(file);
    this.dialog()?.nativeElement.showModal();
  }

  /** Downloads the file to the device. */
  protected save(file: RemoteFile): void {
    this.api.save(file, file.name);
    this.store.toast(this.t('toast.downloading', { name: `${file.name}.${file.ext}` }));
  }

  /** Opens the file in the trimmer or converter. */
  protected open(file: RemoteFile, target: 'trim' | 'convert'): void {
    this.store.open(target, sourceFromFile(file));
  }

  /** Saves the name typed in the inline rename field. */
  protected commitRename(file: RemoteFile, value: string): void {
    if (this.editing() !== file.id) return;
    this.editing.set(null);
    void this.store.rename(file, value);
  }

  /** Shares the file link (share sheet or clipboard). */
  protected async share(file: RemoteFile): Promise<void> {
    const url = new URL(file.url, location.origin).href;
    try {
      if (navigator.share) {
        await navigator.share({ title: `${file.name}.${file.ext}`, url });
      } else {
        await navigator.clipboard.writeText(url);
        this.store.toast(this.t('toast.linkCopied'));
      }
    } catch {
      /* share sheet closed */
    }
  }

  /** Deletes the file; the player closes if it was playing it. */
  protected remove(file: RemoteFile): void {
    if (this.playing()?.id === file.id) this.dialog()?.nativeElement.close();
    void this.store.remove(file);
  }
}
