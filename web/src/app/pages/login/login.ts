import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { TPipe } from '../../shared/t.pipe';

@Component({
  selector: 'app-login',
  imports: [FormsModule, TPipe],
  template: `
    <div class="auth-wrap">
      @if (auth.state() === 'totp') {
        <form class="auth-card panel" (ngSubmit)="submitTotp()">
          <div class="auth-mark">RMC</div>
          <h1>{{ 'auth.totp.title' | t }}</h1>
          <p class="muted">
            {{ (auth.recoveryMode() ? 'auth.totp.recoverySubtitle' : 'auth.totp.subtitle') | t }}
          </p>

          <div class="field">
            <label for="code">
              {{ (auth.recoveryMode() ? 'auth.totp.recoveryLabel' : 'auth.totp.codeLabel') | t }}
            </label>
            <input
              id="code"
              name="code"
              type="text"
              [attr.inputmode]="auth.recoveryMode() ? 'text' : 'numeric'"
              autocomplete="one-time-code"
              [(ngModel)]="code"
              autofocus
              required
            />
            <span class="hint">
              {{ (auth.recoveryMode() ? 'auth.totp.recoveryHint' : 'auth.totp.codeHint') | t }}
            </span>
          </div>

          @if (auth.error()) {
            <div class="error-box">{{ auth.error() }}</div>
          }

          <button class="btn primary" type="submit" [disabled]="auth.busy() || !code">
            @if (auth.busy()) {
              <span class="spinner"></span>
            }
            {{ 'auth.totp.submit' | t }}
          </button>

          <div class="auth-links">
            <button class="link" type="button" (click)="toggleRecovery()">
              {{ (auth.recoveryMode() ? 'auth.totp.useCode' : 'auth.totp.useRecovery') | t }}
            </button>
            <button class="link" type="button" (click)="auth.cancelTotp()">
              {{ 'auth.totp.back' | t }}
            </button>
          </div>
        </form>
      } @else {
        <form class="auth-card panel" (ngSubmit)="submit()">
          <div class="auth-mark">RMC</div>
          <h1>Rust Mission Control</h1>
          <p class="muted">{{ 'auth.login.subtitle' | t }}</p>

          <div class="field">
            <label for="password">{{ 'auth.login.password' | t }}</label>
            <input
              id="password"
              name="password"
              type="password"
              autocomplete="current-password"
              [(ngModel)]="password"
              autofocus
              required
            />
          </div>

          @if (auth.error()) {
            <div class="error-box">{{ auth.error() }}</div>
          }

          <button class="btn primary" type="submit" [disabled]="auth.busy() || !password">
            @if (auth.busy()) {
              <span class="spinner"></span>
            }
            {{ 'auth.login.submit' | t }}
          </button>
        </form>
      }
    </div>
  `,
})
export class LoginPage {
  readonly auth = inject(AuthService);
  password = '';
  code = '';

  submit(): void {
    if (!this.password || this.auth.busy()) return;
    void this.auth.login(this.password).then((result) => {
      if (result !== 'error') this.password = '';
      if (result === 'totp') this.code = '';
    });
  }

  submitTotp(): void {
    const value = this.code.trim();
    if (!value || this.auth.busy()) return;
    void this.auth.loginTotp(value).then((ok) => {
      if (ok) this.code = '';
    });
  }

  toggleRecovery(): void {
    this.auth.recoveryMode.set(!this.auth.recoveryMode());
    this.auth.error.set(null);
    this.code = '';
  }
}
