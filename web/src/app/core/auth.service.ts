import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';

export type AuthState = 'loading' | 'setup' | 'login' | 'ready';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  readonly state = signal<AuthState>('loading');
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  constructor() {
    window.addEventListener('rmc:unauthorized', () => {
      if (this.state() === 'ready') this.state.set('login');
    });
  }

  async init(): Promise<void> {
    this.state.set('loading');
    try {
      const { needsSetup } = await firstValueFrom(this.api.setupStatus());
      if (needsSetup) {
        this.state.set('setup');
        return;
      }
      await firstValueFrom(this.api.me());
      this.state.set('ready');
    } catch {
      this.state.set('login');
    }
  }

  async login(password: string): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.login(password));
      this.state.set('ready');
      return true;
    } catch (err: unknown) {
      this.error.set(readError(err, 'Não foi possível entrar.'));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async setup(password: string): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.setup(password));
      this.state.set('ready');
      return true;
    } catch (err: unknown) {
      this.error.set(readError(err, 'Não foi possível configurar o painel.'));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.api.logout());
    } catch {
      /* ignora */
    }
    this.state.set('login');
  }
}

export function readError(err: unknown, fallback: string): string {
  const anyErr = err as { error?: { error?: string }; message?: string };
  return anyErr?.error?.error ?? anyErr?.message ?? fallback;
}
