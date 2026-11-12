// In-process pub/sub for SSE (spec §11.4).
import { EventEmitter } from 'node:events';
import type { StreamEvents } from '@t3-orchestra/shared';

export type StreamEventName = keyof StreamEvents;
export type StreamMessage = { [K in StreamEventName]: { event: K; data: StreamEvents[K] } }[StreamEventName];

export class Bus {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  emit<K extends StreamEventName>(event: K, data: StreamEvents[K]): void {
    this.ee.emit('msg', { event, data } as StreamMessage);
  }

  subscribe(fn: (m: StreamMessage) => void): () => void {
    this.ee.on('msg', fn);
    return () => this.ee.off('msg', fn);
  }
}
