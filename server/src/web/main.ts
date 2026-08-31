#!/usr/bin/env node
/**
 * The HTTP host: node:http plus a small route table, no framework.
 *
 * Everything the UI can do arrives through these routes; everything it learns
 * back arrives through the SSE stream (see events.ts). This file is the only
 * place the agent runtime and the wire types meet.
 *
 * Security posture (this is a single-user developer tool):
 *   - binds loopback only, and validates Origin + Host (against DNS rebinding);
 *   - file endpoints are confined to projects the user explicitly opened;
 *   - API keys go in but never come back out.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';

import { PROVIDERS, assertLegalCatalogue } from '../agent/providers.ts';
import { Router } from '../agent/router.ts';
import { conversationTitle, Store } from '../agent/store.ts';
import { confinePath } from '../agent/paths.ts';
import { IGNORED_DIRS } from '../agent/retrieval.ts';
import { askAside } from '../agent/workers.ts';
import type { ProvidersResponse } from '../shared/types.ts';

import { EventBus } from './events.ts';
import { Session } from './session.ts';
import { applySelection, buildReview } from './review.ts';
import {
  effectiveKeys, keyPresence, loadSettings, saveSettings, setProviderKey, settingsPath,
} from './settings.ts';

const PORT = Number(process.env.AGENTZERO_PORT ?? 4319);
const UI_PORT = Number(process.env.AGENTZERO_UI_PORT ?? 5319);
const HOST = process.env.AGENTZERO_HOST ?? '127.0.0.1';

const bus = new EventBus();

/** One session per opened project root. */
const sessions = new Map<string, Session>();

function sessionFor(projectRoot: string): Session {
  const root = resolve(projectRoot);
  let session = sessions.get(root);
  if (!session) {
    session = new Session(root, effectiveKeys(), bus);
    sessions.set(root, session);
  }
  return session;
}

/**
 * Roots the user explicitly opened — what authorises the file endpoints.
 * Seeded from the persisted last project so a reload keeps working.
 */
const openedProjects = new Set<string>(
  loadSettings().lastProjectRoot ? [resolve(loadSettings().lastProjectRoot!)] : []);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type Handler = (
  req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray, url: URL,
) => Promise<void>;

const routes: Array<{ method: string; pattern: RegExp; handle: Handler }> = [

  // -- live event stream -----------------------------------------------------
  {
    method: 'GET', pattern: /^\/api\/events$/,
    handle: async (_req, res) => { bus.subscribe(res); },
  },

  // -- settings (the mandatory keys screen) ----------------------------------
  {
    method: 'GET', pattern: /^\/api\/providers$/,
    handle: async (_req, res) => {
      const presence = keyPresence();
      const body: ProvidersResponse = {
        providers: PROVIDERS.map((p) => ({
          providerId: p.id, label: p.label,
          configured: presence[p.id] ?? false,
          enabled: p.enabled, preference: p.preference, keyEnv: p.keyEnv,
        })),
        models: PROVIDERS.flatMap((p) => p.models.map((m) => ({
          providerId: p.id, modelId: m.id,
          totalParamsB: m.totalParamsB, paramsSource: m.paramsSource,
          contextTokens: m.contextTokens,
          costPerMTokIn: m.costPerMTokIn, costPerMTokOut: m.costPerMTokOut,
          roles: m.roles,
        }))),
        settingsPath: settingsPath(),
      };
      json(res, 200, body);
    },
  },
  {
    method: 'PUT', pattern: /^\/api\/providers\/([^/]+)\/key$/,
    handle: async (req, res, m) => {
      const providerId = decodeURIComponent(m[1]!);
      if (!PROVIDERS.some((p) => p.id === providerId)) {
        return json(res, 404, { error: `Unknown provider '${providerId}'` });
      }
      const body = await readJson(req) as { apiKey?: string };
      setProviderKey(providerId, body.apiKey ?? '');
      // Sessions hold their key map; rebuild so the change takes effect now.
      for (const [root, s] of sessions) { s.close(); sessions.delete(root); }
      json(res, 200, { ok: true, configured: keyPresence() });
    },
  },
  {
    method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/test$/,
    handle: async (_req, res, m) => {
      const provider = PROVIDERS.find((p) => p.id === decodeURIComponent(m[1]!));
      if (!provider) return json(res, 404, { error: 'Unknown provider' });
      json(res, 200, await probe(provider.baseUrl, effectiveKeys().get(provider.id)));
    },
  },

  // -- tasks -----------------------------------------------------------------
  {
    method: 'POST', pattern: /^\/api\/tasks$/,
    handle: async (req, res) => {
      const body = await readJson(req) as
        { projectRoot?: string; prompt?: string; conversationId?: string };
      if (!body.projectRoot || !body.prompt) {
        return json(res, 400, { error: 'projectRoot and prompt are required' });
      }
      const root = resolve(body.projectRoot);
      if (!existsSync(root)) return json(res, 400, { error: `No such directory: ${root}` });
      rememberProject(root);

      const session = sessionFor(root);
      if (session.isRunning) return json(res, 409, { error: 'A task is already running.' });

      // The chat is settled here rather than inside the task, because the
      // browser needs its id in this response: it has to know which
      // conversation to show long before the task produces its first event.
      const conversationId = resolveConversation(root, body.conversationId, body.prompt);

      // Not awaited: the client follows progress on the event stream.
      session.run(body.prompt, { conversationId }).catch((err: Error) => {
        bus.publish({
          type: 'log', projectRoot: root, taskId: null,
          level: 'error', message: err.message,
        });
      });
      json(res, 202, { accepted: true, conversationId });
    },
  },
  {
    // Resume a task that was interrupted (crash, closed IDE, restart).
    method: 'POST', pattern: /^\/api\/tasks\/([^/]+)\/resume$/,
    handle: async (req, res, m) => {
      const body = await readJson(req) as { projectRoot?: string };
      if (!body.projectRoot) return json(res, 400, { error: 'projectRoot required' });
      const root = resolve(body.projectRoot);
      const session = sessionFor(root);
      if (session.isRunning) return json(res, 409, { error: 'A task is already running.' });

      session.run('', { resumeTaskId: decodeURIComponent(m[1]!) }).catch((err: Error) => {
        bus.publish({
          type: 'log', projectRoot: root, taskId: null,
          level: 'error', message: err.message,
        });
      });
      json(res, 202, { accepted: true });
    },
  },
  {
    method: 'GET', pattern: /^\/api\/tasks$/,
    handle: async (_req, res, _m, url) => {
      const projectRoot = url.searchParams.get('projectRoot');
      if (!projectRoot) return json(res, 400, { error: 'projectRoot required' });
      const conversationId = url.searchParams.get('conversationId');
      const root = resolve(projectRoot);
      const db = new Store(root);
      try {
        const running = sessions.get(root)?.isRunning ?? false;
        // No conversation named means a chat that has not been started yet:
        // an empty timeline, not the whole project's history.
        const rows = conversationId ? db.listConversationTasks(conversationId) : [];
        const tasks = rows.map((t) => {
          const totals = db.totals(t.id);
          const steps = db.getSteps(t.id);
          return {
            id: t.id, conversationId: t.conversationId,
            prompt: t.prompt, status: t.status,
            complexity: t.complexity, createdAt: t.createdAt,
            costUsd: totals.costUsd, tokens: totals.tokens,
            elapsedMs: totals.durationMs,
            stepsDone: steps.filter((s) => s.status === 'done').length,
            stepsTotal: steps.length,
            // 'running' with no live session = interrupted, offer to resume.
            resumable: t.status === 'running' && !running,
          };
        });
        json(res, 200, { tasks });
      } finally {
        db.close();
      }
    },
  },
  {
    method: 'GET', pattern: /^\/api\/tasks\/([^/]+)\/trace$/,
    handle: async (_req, res, m, url) => {
      const projectRoot = url.searchParams.get('projectRoot');
      if (!projectRoot) return json(res, 400, { error: 'projectRoot required' });
      const db = new Store(resolve(projectRoot));
      try {
        const taskId = decodeURIComponent(m[1]!);
        json(res, 200, { events: db.getEvents(taskId), totals: db.totals(taskId) });
      } finally {
        db.close();
      }
    },
  },

  // -- conversations (chats) -------------------------------------------------
  {
    method: 'GET', pattern: /^\/api\/conversations$/,
    handle: async (_req, res, _m, url) => {
      const projectRoot = url.searchParams.get('projectRoot');
      if (!projectRoot) return json(res, 400, { error: 'projectRoot required' });
      const root = resolve(projectRoot);
      const db = new Store(root);
      try {
        json(res, 200, { conversations: db.listConversations(root) });
      } finally {
        db.close();
      }
    },
  },
  {
    method: 'PUT', pattern: /^\/api\/conversations\/([^/]+)$/,
    handle: async (req, res, m) => {
      const body = await readJson(req) as { projectRoot?: string; title?: string };
      if (!body.projectRoot || !body.title?.trim()) {
        return json(res, 400, { error: 'projectRoot and title are required' });
      }
      const db = new Store(resolve(body.projectRoot));
      try {
        db.renameConversation(decodeURIComponent(m[1]!), body.title.trim().slice(0, 120));
        json(res, 200, { ok: true });
      } finally {
        db.close();
      }
    },
  },

  // -- approvals -------------------------------------------------------------
  {
    method: 'POST', pattern: /^\/api\/approvals$/,
    handle: async (req, res) => {
      const body = await readJson(req) as
        { projectRoot?: string; eventId?: number; approved?: boolean; feedback?: string };
      if (!body.projectRoot || body.eventId === undefined) {
        return json(res, 400, { error: 'projectRoot and eventId are required' });
      }
      const ok = sessionFor(resolve(body.projectRoot)).resolveApproval(
        Number(body.eventId), body.approved === true, body.feedback);
      json(res, ok ? 200 : 404, { ok });
    },
  },

  // -- stop a running task ---------------------------------------------------
  {
    method: 'POST', pattern: /^\/api\/tasks\/([^/]+)\/stop$/,
    handle: async (req, res) => {
      const body = await readJson(req) as { projectRoot?: string };
      if (!body.projectRoot) return json(res, 400, { error: 'projectRoot required' });
      const session = sessions.get(resolve(body.projectRoot));
      if (!session?.isRunning) {
        return json(res, 409, { error: 'No task is running in this project.' });
      }
      // Cooperative: the loop unwinds at its next safe point and reports
      // 'aborted' with whatever it already changed still on disk.
      json(res, 202, { ok: session.stop() });
    },
  },

  // -- review ----------------------------------------------------------------
  {
    method: 'GET', pattern: /^\/api\/tasks\/([^/]+)\/review$/,
    handle: async (_req, res, m, url) => {
      const projectRoot = url.searchParams.get('projectRoot');
      if (!projectRoot) return json(res, 400, { error: 'projectRoot required' });
      const { hunksRaw, ...wire } =
        await buildReview(resolve(projectRoot), decodeURIComponent(m[1]!));
      json(res, 200, wire);
    },
  },
  {
    method: 'POST', pattern: /^\/api\/tasks\/([^/]+)\/review$/,
    handle: async (req, res, m) => {
      const body = await readJson(req) as
        { projectRoot?: string; acceptedHunkIds?: string[] };
      if (!body.projectRoot) return json(res, 400, { error: 'projectRoot required' });
      try {
        const result = await applySelection(
          resolve(body.projectRoot), decodeURIComponent(m[1]!), body.acceptedHunkIds ?? []);
        bus.publish({
          type: 'log', projectRoot: resolve(body.projectRoot),
          taskId: decodeURIComponent(m[1]!), level: 'info',
          message: `Applied ${result.applied} hunk(s), rejected ${result.rejected}.`,
        });
        json(res, 200, result);
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  },

  // -- /bytheway: an isolated question, zero task context --------------------
  {
    method: 'POST', pattern: /^\/api\/bytheway$/,
    handle: async (req, res) => {
      const body = await readJson(req) as { question?: string };
      if (!body.question?.trim()) return json(res, 400, { error: 'question required' });
      try {
        const keys = effectiveKeys();
        // A fresh router: the aside must not touch any task's routing state,
        // and its call is still rate-limit-aware and logged like any other.
        const router = new Router(new Set(keys.keys()));
        const result = await askAside(router, keys, body.question.trim());
        const aside = { question: body.question.trim(), ...result, ts: Date.now() };
        bus.publish({ type: 'aside', aside });
        json(res, 200, aside);
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  },

  // -- project selection -----------------------------------------------------
  {
    method: 'POST', pattern: /^\/api\/project$/,
    handle: async (req, res) => {
      const body = await readJson(req) as { path?: string };
      if (!body.path) return json(res, 400, { error: 'path required' });
      const root = resolve(body.path);
      if (!existsSync(root)) return json(res, 400, { error: `No such directory: ${root}` });
      rememberProject(root);
      json(res, 200, { path: root });
    },
  },

  // -- filesystem picker (unconfined by design: it CHOOSES the project) ------
  {
    method: 'GET', pattern: /^\/api\/browse$/,
    handle: async (_req, res, _m, url) => {
      const requested = url.searchParams.get('path');
      const target = resolve(requested?.trim() ? requested : homedir());
      try {
        const info = await stat(target);
        if (!info.isDirectory()) return json(res, 400, { error: 'Not a directory' });
        const entries = (await readdir(target, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
          .map((e) => ({ name: e.name, path: join(target, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const parent = dirname(target);
        json(res, 200, {
          path: target,
          parent: parent === target ? null : parent,
          home: homedir(),
          entries,
          isProject: existsSync(join(target, '.agentzero')),
        });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  },

  // -- file browsing for the editor (confined to opened projects) ------------
  {
    method: 'GET', pattern: /^\/api\/files$/,
    handle: async (_req, res, _m, url) => {
      const projectRoot = url.searchParams.get('projectRoot');
      const path = url.searchParams.get('path') ?? '.';
      if (!projectRoot) return json(res, 400, { error: 'projectRoot required' });
      try {
        json(res, 200, await listDirectory(resolve(projectRoot), path));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  },
  {
    /**
     * Save an edit made in the built-in editor.
     *
     * Confined exactly like reading is: an opened project, never `.agentzero`.
     * One honest caveat, which the UI shows rather than hides — a file saved
     * while a task is running lands inside that task's `base..head` diff, so
     * the review screen will offer your own edit back to you as if the agent
     * had made it.
     */
    method: 'PUT', pattern: /^\/api\/file$/,
    handle: async (req, res) => {
      const body = await readJson(req) as
        { projectRoot?: string; path?: string; content?: string };
      if (!body.projectRoot || !body.path || typeof body.content !== 'string') {
        return json(res, 400, { error: 'projectRoot, path and content are required' });
      }
      const root = resolve(body.projectRoot);
      try {
        const abs = await confine(root, body.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, body.content, 'utf8');
        // Same signal the agent's own writes raise, so the tree and any other
        // open view refresh themselves.
        bus.publish({
          type: 'log', projectRoot: root, taskId: null, level: 'info',
          message: `Saved ${body.path}`,
        });
        json(res, 200, { path: body.path, bytes: Buffer.byteLength(body.content) });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  },
  {
    method: 'GET', pattern: /^\/api\/file$/,
    handle: async (_req, res, _m, url) => {
      const projectRoot = url.searchParams.get('projectRoot');
      const path = url.searchParams.get('path');
      if (!projectRoot || !path) {
        return json(res, 400, { error: 'projectRoot and path are required' });
      }
      try {
        const abs = await confine(resolve(projectRoot), path);
        json(res, 200, { path, content: await readFile(abs, 'utf8') });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Server plumbing
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  `http://localhost:${UI_PORT}`, `http://127.0.0.1:${UI_PORT}`,
  `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
]);

/**
 * Two checks for two attacks: Origin against a random website scripting this
 * server in the background; Host against DNS rebinding, where an attacker's
 * name resolves to 127.0.0.1 so the browser treats it as same-origin.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  const host = (req.headers.host ?? '').split(':')[0];
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (!originAllowed(req)) {
    return json(res, 403, {
      error: 'Rejected: this API only accepts requests from the Agent Zero UI on this machine.',
    });
  }

  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  for (const route of routes) {
    if (req.method !== route.method) continue;
    const match = url.pathname.match(route.pattern);
    if (!match) continue;
    route.handle(req, res, match, url).catch((err: Error) => {
      if (!res.headersSent) json(res, 500, { error: err.message });
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
  serveStatic(url.pathname, res);
});

/** Serves the built UI when it exists, so production is one process. */
function serveStatic(pathname: string, res: ServerResponse): void {
  const dist = resolve(import.meta.dirname, '../../../ui/dist');
  if (!existsSync(dist)) {
    return json(res, 404, {
      error: 'UI bundle not built. Run `npm run dev` for development, ' +
             'or `npm run build -w ui` to serve it from here.',
    });
  }
  const file = pathname === '/' ? '/index.html' : pathname;
  const abs = join(dist, file);
  const target = existsSync(abs) ? abs : join(dist, 'index.html');
  readFile(target)
    .then((buf) => {
      res.writeHead(200, { 'Content-Type': mimeType(target) });
      res.end(buf);
    })
    .catch(() => json(res, 404, { error: 'Not found' }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The chat a new task belongs to: the one named, or a fresh one titled after
 * the prompt. An unknown id is treated as absent rather than as an error —
 * a browser holding the id of a chat from a database that has since been
 * deleted should start a new chat, not fail to send.
 */
function resolveConversation(
  root: string, requested: string | undefined, prompt: string,
): string {
  // Unlike its read-only neighbours, this opens a connection in order to
  // WRITE, and closes it before the session opens its own and starts
  // inserting tasks. Sequential by construction, which is what keeps one
  // SQLite file with two connections uneventful.
  const db = new Store(root);
  try {
    if (requested && db.hasConversation(requested)) return requested;
    return db.createConversation(root, conversationTitle(prompt));
  } finally {
    db.close();
  }
}

function rememberProject(root: string): void {
  openedProjects.add(root);
  const settings = loadSettings();
  settings.lastProjectRoot = root;
  saveSettings(settings);
}

/**
 * Confine a browser-supplied path to a project the user actually opened.
 * `projectRoot` itself is caller-supplied, so confining relative to it alone
 * would be circular — it must be a root opened through the picker. And
 * `.agentzero` is refused outright: it holds the task database.
 */
async function confine(projectRoot: string, path: string): Promise<string> {
  const root = resolve(projectRoot);
  if (!openedProjects.has(root)) {
    throw new Error('That folder has not been opened as a project in this session.');
  }
  const abs = await confinePath(root, path);
  if (abs.split(sep).includes('.agentzero')) {
    throw new Error('The .agentzero directory is not readable through the API.');
  }
  return abs;
}

async function listDirectory(projectRoot: string, path: string): Promise<{
  path: string; entries: Array<{ name: string; directory: boolean }>;
}> {
  const abs = await confine(projectRoot, path);
  const info = await stat(abs);
  if (!info.isDirectory()) throw new Error(`${path} is not a directory`);

  const entries = (await readdir(abs, { withFileTypes: true }))
    .filter((e) => !IGNORED_DIRS.has(e.name))
    .map((e) => ({ name: e.name, directory: e.isDirectory() }))
    .sort((a, b) => a.directory === b.directory
      ? a.name.localeCompare(b.name)
      : a.directory ? -1 : 1);
  return { path, entries };
}

async function probe(baseUrl: string, key?: string): Promise<{ reachable: boolean; detail: string }> {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
    return { reachable: res.ok, detail: res.ok ? 'reachable' : `HTTP ${res.status}` };
  } catch (err) {
    return { reachable: false, detail: (err as Error).message.slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function mimeType(path: string): string {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':   return 'text/javascript; charset=utf-8';
    case '.css':  return 'text/css; charset=utf-8';
    case '.json': return 'application/json';
    case '.svg':  return 'image/svg+xml';
    default:      return 'application/octet-stream';
  }
}

// ---------------------------------------------------------------------------

assertLegalCatalogue();

server.on('error', (err: NodeJS.ErrnoException) => {
  // A busy port is a fixable situation, not a stack trace: the usual cause is
  // a previous run still alive.
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${PORT} is already in use — most likely an Agent Zero server ` +
      `from an earlier run.\n\n` +
      `  Stop it:  kill $(lsof -t -i :${PORT})\n` +
      `  Or use a different port:  AGENTZERO_PORT=4320 npm run dev\n`);
  } else {
    console.error(`\nServer failed to start: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Agent Zero server on http://${HOST}:${PORT}  (loopback only)`);
  console.log(`Settings file: ${settingsPath()}`);
  const configured = Object.entries(keyPresence()).filter(([, v]) => v).map(([k]) => k);
  console.log(configured.length > 0
    ? `Configured providers: ${configured.join(', ')}`
    : 'No providers configured yet — add a key on the Settings screen.');
});
