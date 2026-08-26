/**
 * Fan-out of server events to connected browsers, over Server-Sent Events.
 *
 * SSE rather than WebSockets because the traffic is one-directional: the
 * server streams trace nodes and approval requests; the browser replies with
 * ordinary POSTs. SSE is native to the browser, reconnects on its own, and
 * needs no dependency.
 */

import type { ServerResponse } from 'node:http';
import type { ServerEvent } from '../shared/types.ts';

const REPLAY_LIMIT = 500;

export class EventBus {
  private clients = new Set<ServerResponse>();
  /**
   * Recent history, replayed on connect: opening the dashboard mid-task must
   * show the tree so far, not an empty screen until the next event.
   */
  private recent: ServerEvent[] = [];

  subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',   // disable proxy buffering
    });
    res.write(': connected\n\n');

    for (const event of this.recent) this.write(res, event);
    this.clients.add(res);

    // Comment frames keep intermediaries from closing an idle stream.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  publish(event: ServerEvent): void {
    this.recent.push(event);
    if (this.recent.length > REPLAY_LIMIT) this.recent.shift();
    for (const client of this.clients) this.write(client, event);
  }

  /** Drop replay history, e.g. when a new task starts. */
  reset(): void {
    this.recent = [];
  }

  private write(res: ServerResponse, event: ServerEvent): void {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }
}
