import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig)
  .then(() => {
    if (
      'serviceWorker' in navigator &&
      (location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))
    ) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* PWA é opcional; o painel funciona sem service worker */
      });
    }
  })
  .catch((err) => console.error(err));
