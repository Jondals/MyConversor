// Account dropdown under the header avatar: create an account (with password
// rules and an optional profile photo) or sign in; when signed in, shows the
// storage used, lets you change the photo and sign out.
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Api } from '../core/api';
import { formatBytes } from '../core/format';
import { Icon } from '../core/icon';
import { Key } from '../core/i18n';
import { Store } from '../core/store';

const RULES: { key: Key; test: (p: string) => boolean }[] = [
  { key: 'account.rule.length', test: (p) => p.length >= 10 },
  { key: 'account.rule.lower', test: (p) => /[a-z]/.test(p) },
  { key: 'account.rule.upper', test: (p) => /[A-Z]/.test(p) },
  { key: 'account.rule.number', test: (p) => /\d/.test(p) },
  { key: 'account.rule.symbol', test: (p) => /[^A-Za-z0-9]/.test(p) },
];

@Component({
  selector: 'app-account',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './account.html',
})
export class Account {
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  protected readonly t = this.store.t;
  protected readonly bytes = formatBytes;
  protected readonly rules = RULES;

  protected readonly mode = signal<'register' | 'login'>('register');
  protected readonly password = signal('');
  protected readonly repeat = signal('');
  protected readonly reveal = signal(false);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly photo = signal<File | null>(null);
  protected readonly photoUrl = signal<string | null>(null);

  protected readonly passes = computed(() => RULES.map((r) => r.test(this.password())));
  protected readonly canSubmit = computed(
    () =>
      this.mode() === 'login' ||
      (this.passes().every(Boolean) && this.password() === this.repeat() && this.repeat() !== ''),
  );

  /** Picks the optional profile photo and shows a preview. */
  protected pickPhoto(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (this.photoUrl()) URL.revokeObjectURL(this.photoUrl()!);
    this.photo.set(file);
    this.photoUrl.set(URL.createObjectURL(file));
  }

  /** Creates the account or signs in. */
  protected async submit(username: string): Promise<void> {
    if (!this.canSubmit()) {
      this.error.set(this.t(this.password() !== this.repeat() ? 'account.mismatch' : 'err.weak_password'));
      this.store.sfx.error();
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const login = this.mode() === 'login';
      let me = login ? await this.api.login(username, this.password()) : await this.api.register(username, this.password());
      if (!login && this.photo()) me = await this.api.setAvatar(this.photo()!);
      this.store.me.set(me);
      await this.store.reload();
      this.store.sfx.success();
      this.store.toast(this.t(login ? 'account.welcome' : 'account.created', { name: me.username ?? '' }));
      this.password.set('');
      this.repeat.set('');
    } catch (err) {
      this.store.sfx.error();
      this.error.set(this.store.errorText(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Replaces the profile photo of the signed-in account. */
  protected async changePhoto(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      this.store.me.set(await this.api.setAvatar(file));
      this.store.sfx.success();
    } catch (err) {
      this.store.fail(err);
    }
  }

  /** Removes the profile photo. */
  protected async removePhoto(): Promise<void> {
    try {
      this.store.me.set(await this.api.removeAvatar());
    } catch (err) {
      this.store.fail(err);
    }
  }

  /** Signs out (the browser gets a fresh guest session). */
  protected async logout(): Promise<void> {
    try {
      this.store.me.set(await this.api.logout());
      await this.store.reload();
      this.store.toast(this.t('account.loggedOut'));
      this.store.menu.set(null);
    } catch (err) {
      this.store.fail(err);
    }
  }
}
