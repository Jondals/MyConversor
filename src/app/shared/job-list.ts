// Queue of running jobs (uploads, downloads, trims, conversions) with progress
// bars and a cancel button.
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Icon, IconName } from '../core/icon';
import { Job, Store } from '../core/store';
import { formatBytes } from '../core/format';
import { Key } from '../core/i18n';

const ICON: Record<Job['origin'], IconName> = {
  download: 'download',
  upload: 'upload',
  trim: 'scissors',
  convert: 'convert',
};

@Component({
  selector: 'app-job-list',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul>
      @for (job of store.jobs(); track job.id) {
        <li class="rise hover-rail border-b border-line-soft p-4 last:border-0">
          <div class="flex items-center gap-3">
            <span class="grid size-9 shrink-0 place-items-center border border-line text-yellow">
              <app-icon [name]="icon[job.origin]" [size]="16" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{{ job.name }}</p>
              <p class="label mt-0.5 text-blue-text!">
                {{ stage(job.stage) }}
                @if (job.total) {
                  · {{ bytes(job.downloaded) }} / {{ bytes(job.total) }}
                }
                @if (job.speed) {
                  · {{ bytes(job.speed) }}/s
                }
              </p>
            </div>
            @if (!job.local) {
              <button
                type="button"
                class="btn-icon size-9"
                (click)="store.cancel(job.id)"
                [attr.aria-label]="t('common.cancel') + ' ' + job.name"
              >
                <app-icon name="x" [size]="14" />
              </button>
            }
          </div>
          <div class="mt-3 flex items-center gap-3">
            <div
              class="progress flex-1"
              [class.progress-indeterminate]="!job.progress"
              role="progressbar"
              [attr.aria-label]="t('jobs.progress', { name: job.name })"
              [attr.aria-valuenow]="percent(job)"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span [style.width.%]="percent(job)"></span>
            </div>
            <span class="w-10 text-right text-xs font-bold text-yellow">{{ percent(job) }}%</span>
          </div>
        </li>
      } @empty {
        <li class="p-6 text-center text-sm text-muted">{{ t('jobs.empty') }}</li>
      }
    </ul>
  `,
})
export class JobList {
  protected readonly store = inject(Store);
  protected readonly t = this.store.t;
  protected readonly bytes = formatBytes;
  protected readonly icon = ICON;
  protected percent = (job: Job) => Math.floor(job.progress * 100);
  /** Translated stage name (falls back to the raw value). */
  protected stage = (stage: string) => {
    const key = `stage.${stage}` as Key;
    const text = this.t(key);
    return text === key ? stage : text;
  };
}
