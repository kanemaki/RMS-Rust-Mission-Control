import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { TPipe } from '../../shared/t.pipe';

@Component({
  selector: 'app-login',
  imports: [FormsModule, TPipe],
  template: `
    <div class="auth-wrap">
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
    </div>
  `,
})
export class LoginPage {
  readonly auth = inject(AuthService);
  password = '';

  submit(): void {
    if (!this.password || this.auth.busy()) return;
    void this.auth.login(this.password).then((ok) => {
      if (ok) this.password = '';
    });
  }
}
