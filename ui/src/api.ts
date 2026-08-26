/**
 * Typed client for the agent server — the UI's only channel to the runtime.
 * Everything it knows arrives through these calls and the event stream.
 */

import type {
  AsideBubble, ProvidersResponse, ReviewBundle, ServerEvent, TraceNode,
} from './types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface BrowseResponse {
  path: string;
  parent: string | null;
  home: string;
  entries: Array<{ name: string; path: string }>;
  isProject: boolean;
}

export interface TaskRow {
  id: string;
  prompt: string;
  status: string;
  complexity: string;
  createdAt: number;
  costUsd: number;
  tokens: number;
  elapsedMs: number;
  stepsDone: number;
  stepsTotal: number;
  /** 'running' with no live session: interrupted, can be resumed. */
  resumable: boolean;
}

export const api = {
  /** Filesystem picker. Unconfined by design — it chooses which project to open. */
  browse: (path: string) =>
    request<BrowseResponse>(`/api/browse?path=${encodeURIComponent(path)}`),

  /** Opening is what grants the file endpoints access to that tree. */
  openProject: (path: string) =>
    request<{ path: string }>('/api/project', {
      method: 'POST', body: JSON.stringify({ path }),
    }),

  tasks: (projectRoot: string) =>
    request<{ tasks: TaskRow[] }>(`/api/tasks?projectRoot=${encodeURIComponent(projectRoot)}`),

  startTask: (projectRoot: string, prompt: string) =>
    request<{ accepted: boolean }>('/api/tasks', {
      method: 'POST', body: JSON.stringify({ projectRoot, prompt }),
    }),

  resumeTask: (projectRoot: string, taskId: string) =>
    request<{ accepted: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {
      method: 'POST', body: JSON.stringify({ projectRoot }),
    }),

  bytheway: (question: string) =>
    request<AsideBubble>('/api/bytheway', {
      method: 'POST', body: JSON.stringify({ question }),
    }),

  approve: (projectRoot: string, eventId: number, approved: boolean) =>
    request<{ ok: boolean }>('/api/approvals', {
      method: 'POST', body: JSON.stringify({ projectRoot, eventId, approved }),
    }),

  /**
   * A finished task's trace. Used to explain a failure that happened before
   * this page was loaded — otherwise a refresh loses the only account of what
   * went wrong.
   */
  trace: (projectRoot: string, taskId: string) =>
    request<{ events: TraceNode[] }>(
      `/api/tasks/${encodeURIComponent(taskId)}/trace?projectRoot=${encodeURIComponent(projectRoot)}`),

  review: (projectRoot: string, taskId: string) =>
    request<ReviewBundle>(
      `/api/tasks/${encodeURIComponent(taskId)}/review?projectRoot=${encodeURIComponent(projectRoot)}`),

  applyReview: (projectRoot: string, taskId: string, acceptedHunkIds: string[]) =>
    request<{ applied: number; rejected: number; files: string[] }>(
      `/api/tasks/${encodeURIComponent(taskId)}/review`,
      { method: 'POST', body: JSON.stringify({ projectRoot, acceptedHunkIds }) }),

  providers: () => request<ProvidersResponse>('/api/providers'),

  setKey: (providerId: string, apiKey: string) =>
    request<{ ok: boolean; configured: Record<string, boolean> }>(
      `/api/providers/${encodeURIComponent(providerId)}/key`,
      { method: 'PUT', body: JSON.stringify({ apiKey }) }),

  testProvider: (providerId: string) =>
    request<{ reachable: boolean; detail: string }>(
      `/api/providers/${encodeURIComponent(providerId)}/test`, { method: 'POST' }),

  listFiles: (projectRoot: string, path: string) =>
    request<{ path: string; entries: Array<{ name: string; directory: boolean }> }>(
      `/api/files?projectRoot=${encodeURIComponent(projectRoot)}&path=${encodeURIComponent(path)}`),

  readFile: (projectRoot: string, path: string) =>
    request<{ path: string; content: string }>(
      `/api/file?projectRoot=${encodeURIComponent(projectRoot)}&path=${encodeURIComponent(path)}`),
};

/** Subscribe to the event stream. EventSource reconnects on its own. */
export function subscribe(onEvent: (event: ServerEvent) => void): () => void {
  const source = new EventSource('/api/events');
  source.onmessage = (msg) => {
    try { onEvent(JSON.parse(msg.data) as ServerEvent); } catch { /* keepalive */ }
  };
  return () => source.close();
}
