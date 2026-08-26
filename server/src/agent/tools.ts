/**
 * The agent's tool surface: five tools, described and dispatched from the
 * same table so what the model is told and what actually runs cannot drift.
 *
 * Two rules shape this file:
 *   1. The surface stays SMALL. Small models degrade as a tool menu grows,
 *      picking plausible-but-wrong tools. Every addition must earn its place.
 *   2. Any side effect (writing a file, running a command) goes through the
 *      approval callback before it runs — enforced here, at the single choke
 *      point, not left for each tool to remember.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { promisify } from 'node:util';

import type { ApprovalFn, ToolCall, ToolResult } from './types.ts';
import { confinePath } from './paths.ts';
import { IGNORED_DIRS, findMatches, scanProject, toRegions } from './retrieval.ts';

const exec = promisify(execFile);
const MAX_OUTPUT_CHARS = 20_000;

interface ToolSpec {
  name: string;
  description: string;
  /** Rendered into the executor prompt, e.g. "path: string". */
  args: string;
  sideEffecting: boolean;
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'read_file',
    args: 'path',
    description: 'Read a text file, with line numbers. Prefer this over guessing contents.',
    sideEffecting: false,
  },
  {
    name: 'list_files',
    args: 'path?',
    description: 'List files under a directory, relative to the project root.',
    sideEffecting: false,
  },
  {
    name: 'search_code',
    args: 'query',
    description: 'Search the project for a literal string. Returns matching lines with context.',
    sideEffecting: false,
  },
  {
    name: 'write_file',
    args: 'path, content',
    description: 'Write the COMPLETE new contents of a file, creating it if needed. ' +
                 'Read the file first unless you are creating it.',
    sideEffecting: true,
  },
  {
    name: 'run_command',
    args: 'command',
    description: 'Run a shell command in the project root, e.g. the test suite. ' +
                 'Use this to verify your own work.',
    sideEffecting: true,
  },
];

/** The tool list as shown to the model — generated from TOOLS, never hand-written. */
export function renderToolCatalog(): string {
  const lines = ['Tools you can call, and their arguments:'];
  for (const t of TOOLS) {
    lines.push(`  ${t.name}(${t.args})${t.sideEffecting ? '  [needs human approval]' : ''}`);
    lines.push(`      ${t.description}`);
  }
  return lines.join('\n');
}

export interface ToolContext {
  projectRoot: string;
  approval: ApprovalFn;
  /** Called after any write so the retrieval cache can invalidate. */
  onFilesChanged?: (paths: string[]) => void;
}

export async function runTool(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
  const spec = TOOLS.find((t) => t.name === call.name);
  if (!spec) return { ok: false, output: `No such tool: ${call.name}` };

  // The approval gate, enforced once for everything side-effecting.
  if (spec.sideEffecting) {
    let approved: boolean;
    try {
      approved = await ctx.approval(call, describeEffect(call));
    } catch (err) {
      // A gate that throws is a misconfiguration; surface it as the result so
      // the trace still records that the tool was attempted.
      return { ok: false, output: `Approval could not be obtained: ${(err as Error).message}` };
    }
    if (!approved) {
      return {
        ok: false,
        output: 'The human rejected this action. Do not retry it. ' +
                'Either find another approach or report that you are blocked.',
      };
    }
  }

  try {
    switch (call.name) {
      case 'read_file':   return await doReadFile(ctx, String(call.args.path ?? ''));
      case 'list_files':  return await doListFiles(ctx, String(call.args.path ?? '.'));
      case 'search_code': return await doSearchCode(ctx, String(call.args.query ?? ''));
      case 'write_file':  return await doWriteFile(ctx,
        String(call.args.path ?? ''), String(call.args.content ?? ''));
      case 'run_command': return await doRunCommand(ctx, String(call.args.command ?? ''));
      default:            return { ok: false, output: `Unhandled tool: ${call.name}` };
    }
  } catch (err) {
    return { ok: false, output: `Tool failed: ${(err as Error).message}` };
  }
}

/** Plain-language line shown in the approval prompt. */
export function describeEffect(call: ToolCall): string {
  switch (call.name) {
    case 'write_file':
      return `Write ${String(call.args.path)} ` +
             `(${String(call.args.content ?? '').split('\n').length} lines)`;
    case 'run_command':
      return `Run: ${String(call.args.command ?? '')}`;
    default:
      return `Run ${call.name}`;
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async function doReadFile(ctx: ToolContext, path: string): Promise<ToolResult> {
  const abs = await confinePath(ctx.projectRoot, path);
  const text = await readFile(abs, 'utf8');
  const numbered = text.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
  return { ok: true, output: truncate(numbered) };
}

async function doListFiles(ctx: ToolContext, path: string): Promise<ToolResult> {
  const abs = await confinePath(ctx.projectRoot, path);
  const entries = await readdir(abs, { withFileTypes: true });
  const lines = entries
    .filter((e) => !IGNORED_DIRS.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  return { ok: true, output: lines.join('\n') || '(empty)' };
}

/**
 * Same pure-Node scanner retrieval uses. It once shelled out to ripgrep, and
 * a missing binary silently read as "no matches" — the worst failure for a
 * search tool, since the agent concludes the code does not exist.
 */
async function doSearchCode(ctx: ToolContext, query: string): Promise<ToolResult> {
  if (!query.trim()) return { ok: false, output: 'Empty query' };

  const files = await scanProject(ctx.projectRoot);
  const matches = findMatches(files, query, 5);
  if (matches.length === 0) return { ok: true, output: `No matches for "${query}".` };

  const lineCount = (path: string): number =>
    files.find((f) => f.path === path)?.lines.length ?? 0;

  const out: string[] = [];
  for (const region of toRegions(matches, 3, lineCount)) {
    const file = files.find((f) => f.path === region.path);
    if (!file) continue;
    out.push(`--- ${region.path}:${region.startLine}-${region.endLine} ---`);
    out.push(file.lines
      .slice(region.startLine - 1, region.endLine)
      .map((l, i) => `${region.startLine + i}: ${l}`)
      .join('\n'));
  }
  return { ok: true, output: truncate(out.join('\n')) };
}

async function doWriteFile(ctx: ToolContext, path: string, content: string): Promise<ToolResult> {
  const abs = await confinePath(ctx.projectRoot, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  const rel = relative(ctx.projectRoot, abs);
  ctx.onFilesChanged?.([rel]);
  return {
    ok: true,
    output: `Wrote ${rel} (${content.split('\n').length} lines).`,
    filesTouched: [rel],
  };
}

/**
 * Deliberately NOT confined to the project: running the project's own build
 * and tests is the agent's only source of ground truth, and `bash -lc` can
 * reach anything anyway. The control is the approval prompt, which shows the
 * command verbatim so anything reaching outside is visible and rejectable
 * before it runs.
 */
async function doRunCommand(ctx: ToolContext, command: string): Promise<ToolResult> {
  if (!command.trim()) return { ok: false, output: 'Empty command' };
  try {
    const { stdout, stderr } = await exec('bash', ['-lc', command], {
      cwd: ctx.projectRoot,
      env: scrubEnvironment(),
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, output: truncate(`${stdout}${stderr}`) || '(no output)' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    // A non-zero exit is information, not infrastructure failure: a red test
    // suite is exactly the feedback the agent needs.
    return { ok: false, output: truncate(`${e.stdout ?? ''}${e.stderr ?? ''}` || e.message) };
  }
}

/**
 * Strip secret-shaped environment variables from model-chosen commands.
 * Builds legitimately need most of the environment (PATH, HOME, JAVA_HOME…),
 * so an allowlist would break the agent's feedback loop; a denylist of
 * secret-shaped names removes the material worth stealing — without it,
 * `run_command "env"` hands the model every key the user configured.
 */
const SECRET_NAME =
  /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|SESSION|COOKIE|AUTH)($|_)/i;

export function scrubEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_NAME.test(name)) out[name] = value;
  }
  return out;
}

function truncate(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}
