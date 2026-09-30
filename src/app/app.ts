// Root component: first-visit intro, header (sections, music player, language
// switch, options and account menus), the four sections (only the visible one is shown; the rest
// stay alive), footer, mobile tab bar and toasts.
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Icon, IconName } from './core/icon';
import { Music } from './core/music';
import { SECTIONS, Section, Store } from './core/store';
import { Converter } from './features/converter/converter';
import { Downloader } from './features/downloader/downloader';
import { Library } from './features/library/library';
import { Trimmer } from './features/trimmer/trimmer';
import { Account } from './shared/account';
import { Player, Playlist } from './shared/player';
import { Flag } from './shared/flag';
import { Scene } from './shared/scene';

export const VERSION = '2.4.1';
export const AUTHOR = { name: 'jondals', url: 'https://github.com/Jondals' };

@Component({
  selector: 'app-root',
  imports: [Icon, Scene, Flag, Downloader, Trimmer, Converter, Library, Account, Player, Playlist],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-h-dvh flex-col',
    '(document:pointerdown)': 'onPointerDown($event)',
    '(document:keydown.escape)': 'store.menu.set(null)',
    // Page images and icons can't be dragged out (Firefox would try to turn them into files).
    '(document:dragstart)': '$event.preventDefault()',
  },
})
export class App {
  protected readonly store = inject(Store);
  protected readonly music = inject(Music);
  protected readonly t = this.store.t;
  protected readonly sections = SECTIONS;
  protected readonly version = VERSION;
  protected readonly author = AUTHOR;
  protected readonly year = new Date().getFullYear();
  protected readonly icons: Record<Section, IconName> = {
    download: 'download',
    trim: 'scissors',
    convert: 'convert',
    library: 'library',
  };
  protected readonly word = [...'MyConversor'];
  protected readonly authorLetters = [...AUTHOR.name];
  /** "Developed by " split into letters for the footer animation. */
  protected readonly byLetters = computed(() => [...`${this.t('footer.by')} `]);

  /** Click sound on every control, and closes menus when clicking outside them. */
  protected onPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('[data-menu]')) this.store.menu.set(null);
    const el = target?.closest<HTMLElement>('button, a, label[for], select, [role="button"]');
    if (el && !el.matches(':disabled') && el.dataset['sfx'] !== 'off') this.store.sfx.click();
  }

  /** Switches the interface between Spanish and English. */
  protected toggleLang(): void {
    void this.store.i18n.use(this.store.i18n.lang() === 'es' ? 'en' : 'es');
    this.store.sfx.tab();
  }

  /** Plays the first-visit intro again. */
  protected replayIntro(): void {
    this.store.menu.set(null);
    const html = document.documentElement;
    html.removeAttribute('data-intro');
    void html.offsetWidth; // restart the CSS animations
    html.setAttribute('data-intro', '');
  }
}
