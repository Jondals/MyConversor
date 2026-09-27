// Small flat flag icons drawn in SVG (emoji flags don't render on Windows).
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Lang } from '../core/i18n';

@Component({
  selector: 'app-flag',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0 border border-line', 'aria-hidden': 'true' },
  template: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20" width="22" height="15">
      @switch (lang()) {
        @case ('es') {
          <rect width="30" height="20" fill="#c60b1e" />
          <rect y="5" width="30" height="10" fill="#ffc400" />
        }
        @case ('en') {
          <rect width="30" height="20" fill="#012169" />
          <path d="M0 0l30 20M30 0L0 20" stroke="#fff" stroke-width="4" />
          <path d="M0 0l30 20M30 0L0 20" stroke="#c8102e" stroke-width="1.6" />
          <path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6" />
          <path d="M15 0v20M0 10h30" stroke="#c8102e" stroke-width="3.4" />
        }
      }
    </svg>
  `,
})
export class Flag {
  readonly lang = input.required<Lang>();
}
