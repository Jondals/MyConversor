// Runtime translations. Spanish is bundled (the page is prerendered in Spanish);
// English is lazy-loaded the first time they are picked. The choice
// is remembered in localStorage and applied right after hydration.
import { Injectable, afterNextRender, signal } from '@angular/core';
import { Dict, Key, es } from '../i18n/es';

export type Lang = 'es' | 'en';
export type { Key };

export const LANGS: { id: Lang; label: string }[] = [
  { id: 'es', label: 'Español' },
  { id: 'en', label: 'English' },
];

const KEY = 'mc.lang';

/** Loads a dictionary on demand (each one becomes its own small chunk). */
const loaders: Record<Lang, () => Promise<Dict>> = {
  es: async () => es,
  en: () => import('../i18n/en').then((m) => m.en),
};

@Injectable({ providedIn: 'root' })
export class I18n {
  readonly lang = signal<Lang>('es');
  private readonly dict = signal<Dict>(es);

  constructor() {
    afterNextRender(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(KEY);
      } catch {
        /* storage blocked */
      }
      const browser = navigator.language.slice(0, 2);
      const pick = (saved ?? browser) as Lang;
      if (pick !== 'es' && pick in loaders) void this.use(pick, false);
    });
  }

  /** Translates a key, filling `{placeholders}` from `params`. */
  readonly t = (key: Key, params?: Record<string, string | number>): string => {
    let text = this.dict()[key] ?? es[key] ?? key;
    if (params) for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  };

  /** Switches the language (loading it if needed) and remembers the choice. */
  async use(lang: Lang, remember = true): Promise<void> {
    const dict = await loaders[lang]();
    this.dict.set(dict);
    this.lang.set(lang);
    document.documentElement.lang = lang;
    if (remember) {
      try {
        localStorage.setItem(KEY, lang);
      } catch {
        /* storage blocked */
      }
    }
  }
}
