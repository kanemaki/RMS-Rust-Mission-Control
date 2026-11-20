import { HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';

export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  const isApi = req.url.startsWith('/api');
  const headers: Record<string, string> = {};
  if (isApi && req.method !== 'GET' && req.method !== 'HEAD') {
    headers['x-rmc-request'] = '1';
  }
  return next(
    req.clone({
      withCredentials: true,
      setHeaders: headers,
    }),
  ).pipe(
    catchError((err) => {
      if (err?.status === 401) window.dispatchEvent(new Event('rmc:unauthorized'));
      return throwError(() => err);
    }),
  );
};
