import { Component, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { I18nService, Lang } from './core/i18n.service';
import { ThemeService } from './core/theme.service';
import { LoginPage } from './pages/login/login';
import { SetupPage } from './pages/setup/setup';
import { TPipe } from './shared/t.pipe';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LoginPage, SetupPage, TPipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  readonly auth = inject(AuthService);
  readonly theme = inject(ThemeService);
  readonly i18n = inject(I18nService);

  ngOnInit(): void {
    void this.auth.init();
  }

  setLang(lang: Lang): void {
    this.i18n.set(lang);
  }
}
