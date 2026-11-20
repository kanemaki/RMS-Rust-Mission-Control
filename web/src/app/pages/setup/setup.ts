import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { I18nService } from '../../core/i18n.service';
import { TPipe } from '../../shared/t.pipe';

@Component({
  selector: 'app-setup',
  imports: [FormsModule, TPipe],
  template: `
    <div class="auth-wrap">
      <form class="auth-card panel" (ngSubmit)="submit()">
        <div class="auth-mark">RMC</div>
        <h1>{{ 'auth.setup.title' | t }}</h1>
        <p class="muted">{{ 'auth.setup.subtitle' | t }}</p>

        <div class="field">
          <label for="password">{{ 'auth.setup.password' | t }}</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="new-password"
            [(ngModel)]="password"
            autofocus
            required
          />
          <span class="hint">{{ 'auth.setup.passwordHint' | t }}</span>
        </div>

        <div class="field">
          <label for="confirm">{{ 'auth.setup.confirm' | t }}</label>
          <input id="confirm" name="confirm" type="password" autocomplete="new-password" [(ngModel)]="confirm" required />
        </div>

        @if (localError()) {
          <div class="error-box">{{ localError() }}</div>
        }
        @if (auth.error()) {
          <div class="error-box">{{ auth.error() }}</div>
        }

        <button class="btn primary" type="submit" [disabled]="auth.busy() || !password || !confirm">
          @if (auth.busy()) {
            <span class="spinner"></span>
          }
          {{ 'auth.setup.submit' | t }}
        </button>
      </form>
    </div>
  `,
})
export class SetupPage {
  readonly auth = inject(AuthService);
  private readonly i18n = inject(I18nService);
  readonly localError = signal<string | null>(null);
  password = '';
  confirm = '';

  submit(): void {
    this.localError.set(null);
    if (this.password.length < 10) {
      this.localError.set(this.i18n.t('auth.error.short'));
      return;
    }
    if (this.password !== this.confirm) {
      this.localError.set(this.i18n.t('auth.error.mismatch'));
      return;
    }
    void this.auth.setup(this.password).then((ok) => {
      if (ok) {
        this.password = '';
        this.confirm = '';
      }
    });
  }
}
