"""
Fan-out of server events to connected browsers, over Server-Sent Events.

SSE rather than WebSockets because the traffic is one-directional: the server
streams trace nodes and approval requests; the browser replies with ordinary
POSTs. SSE is native to the browser, reconnects on its own, and needs no
dependency.

The one thing this file has to solve that the TypeScript did not: events are
published from the agent's worker THREAD, while subscribers are served from the
asyncio event loop. Every hand-off goes through `loop.call_soon_threadsafe`, so
the queues themselves are only ever touched on the loop.
"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, AsyncIterator

REPLAY_LIMIT = 500

#: Comment frames keep intermediaries from closing an idle stream.
HEARTBEAT_SECONDS = 20


class EventBus:
    def __init__(self) -> None:
        self._clients: set[asyncio.Queue] = set()
        # Recent history, replayed on connect: opening the dashboard mid-task
        # must show the tree so far, not an empty screen until the next event.
        self._recent: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Called once at startup; publishes from other threads hop through it."""
        self._loop = loop

    def publish(self, event: dict[str, Any]) -> None:
        with self._lock:
            self._recent.append(event)
            if len(self._recent) > REPLAY_LIMIT:
                self._recent.pop(0)
            clients = list(self._clients)

        for queue in clients:
            self._deliver(queue, event)

    def _deliver(self, queue: asyncio.Queue, event: dict[str, Any]) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(queue.put_nowait, event)
        except RuntimeError:
            pass          # the loop went away mid-publish; the client is gone too

    def reset(self) -> None:
        """Drop replay history, e.g. when a new task starts."""
        with self._lock:
            self._recent = []

    async def subscribe(self) -> AsyncIterator[str]:
        """One connected browser's stream, as SSE frames."""
        queue: asyncio.Queue = asyncio.Queue()
        with self._lock:
            backlog = list(self._recent)
            self._clients.add(queue)
        try:
            yield ": connected\n\n"
            for event in backlog:
                yield _frame(event)
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield _frame(event)
        finally:
            with self._lock:
                self._clients.discard(queue)

    @property
    def client_count(self) -> int:
        with self._lock:
            return len(self._clients)


def _frame(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event)}\n\n"
