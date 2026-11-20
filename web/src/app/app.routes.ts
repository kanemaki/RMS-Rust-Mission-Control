import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.DashboardPage),
  },
  {
    path: 'servers/:id',
    loadComponent: () => import('./pages/server/server').then((m) => m.ServerPage),
  },
  { path: '**', redirectTo: '' },
];
