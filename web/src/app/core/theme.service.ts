import { Injectable, effect, signal } from '@angular/core';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'rmc.theme';

function readStored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    /* localStorage indisponível */
  }
  return 'dark';
}

/**
 * Tema claro/escuro. O escuro é o padrão da identidade visual; a escolha fica
 * gravada no navegador e é aplicada em <html data-theme>.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(readStored());

  constructor() {
    effect(() => this.#apply(this.theme()));
  }

  toggle(): void {
    this.theme.update((current) => (current === 'dark' ? 'light' : 'dark'));
  }

  set(theme: Theme): void {
    this.theme.set(theme);
  }

  #apply(theme: Theme): void {
    const root = document.documentElement;
    root.dataset['theme'] = theme;
    root.style.colorScheme = theme;

    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignora quota/privacidade */
    }

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0a0e13' : '#faf7f0');
  }
}
