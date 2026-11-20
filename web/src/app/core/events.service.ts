import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { StreamEvent } from './models';

@Injectable({ providedIn: 'root' })
export class EventsService implements OnDestroy {
  private source: EventSource | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private readonly subject = new Subject<StreamEvent>();
  readonly events = this.subject.asObservable();

  connect(): void {
    if (this.source) return;
    this.open();
  }

  disconnect(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.source?.close();
    this.source = null;
  }

  ngOnDestroy(): void {
    this.disconnect();
  }

  private open(): void {
    const source = new EventSource('/api/events', { withCredentials: true });
    this.source = source;

    source.onmessage = (message) => {
      try {
        this.subject.next(JSON.parse(message.data) as StreamEvent);
      } catch {
        /* ignora payload inválido */
      }
    };

    source.onerror = () => {
      source.close();
      this.source = null;
      if (this.retry) return;
      this.retry = setTimeout(() => {
        this.retry = null;
        this.open();
      }, 3000);
    };
  }
}
