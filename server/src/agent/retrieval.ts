/**
 * Code retrieval: find the chunks of the project a model call needs.
 *
 * v0 strategy — deliberately the simplest thing that works end to end:
 *   1. scan the project once (pure Node, no ripgrep dependency — a missing
 *      binary must never masquerade as "no matches");
 *   2. pull identifier-shaped terms out of the request;
 *   3. literal-search them and merge the hits into readable regions.
 * Files the caller already knows matter (plan targets, user pins) skip all of
 * that and go in whole.
 *
 * The intended upgrade — a tree-sitter symbol graph with k-hop expansion —
 * replaces the body of retrieve() and nothing else; the orchestrator only
 * ever sees CodeChunk[].
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

import type { CodeChunk } from './types.ts';
import { confinePathOrNull } from './paths.ts';

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.agentzero', 'dist', 'build', 'target', 'out',
  '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', '.turbo',
  'vendor', '.idea', '.vscode', 'coverage', '.pytest_cache', '.mypy_cache',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.php',
  '.scala', '.sh', '.bash', '.sql', '.html', '.css', '.scss', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.md', '.txt',
  '.gradle', '.tf', '.proto', '.graphql', '.lua', '.jl', '.r',
]);

const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 4_000;
const CONTEXT_LINES = 10;

export interface SourceFile {
  /** Relative to the project root, always forward slashes. */
  path: string;
  lines: string[];
}

/**
 * Read every source file under `root`. Breadth-first on purpose: if the file
 * cap bites, it should drop the deepest files, not the project's top level
 * where the code a request refers to usually lives.
 */
export async function scanProject(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && files.length < MAX_FILES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;   // an unreadable directory should not fail a task
    }

    const subdirs: string[] = [];
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { subdirs.push(abs); continue; }
      if (!entry.isFile() || !isTextFile(entry.name)) continue;
      if (files.length >= MAX_FILES) break;
      try {
        const info = await stat(abs);
        if (info.size > MAX_FILE_BYTES) continue;
        const text = await readFile(abs, 'utf8');
        if (text.includes('\0')) continue;   // the extension misled us: binary
        files.push({
          path: relative(root, abs).split(/[\\/]/).join('/'),
          lines: text.split('\n'),
        });
      } catch {
        continue;
      }
    }
    queue.push(...subdirs);
  }
  return files;
}

function isTextFile(name: string): boolean {
  const ext = extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  return ext === '' && /^(Makefile|Dockerfile|README|LICENSE|AGENTS)$/i.test(name);
}

export interface LineMatch { path: string; lineNumber: number }

/** Case-insensitive literal search over already-scanned files. */
export function findMatches(files: SourceFile[], term: string, maxPerFile = 3): LineMatch[] {
  const needle = term.toLowerCase();
  if (!needle) return [];
  const out: LineMatch[] = [];
  for (const file of files) {
    let found = 0;
    for (let i = 0; i < file.lines.length; i++) {
      if (!file.lines[i]!.toLowerCase().includes(needle)) continue;
      out.push({ path: file.path, lineNumber: i + 1 });
      if (++found >= maxPerFile) break;
    }
  }
  return out;
}

/**
 * Merge scattered line hits into contiguous regions with context. A model can
 * use a readable block of code; a scatter of isolated lines it cannot.
 */
export function toRegions(
  matches: LineMatch[], contextLines: number, totalLines: (path: string) => number,
): Array<{ path: string; startLine: number; endLine: number }> {
  const byPath = new Map<string, number[]>();
  for (const m of matches) {
    byPath.set(m.path, [...(byPath.get(m.path) ?? []), m.lineNumber]);
  }

  const regions: Array<{ path: string; startLine: number; endLine: number }> = [];
  for (const [path, lineNumbers] of byPath) {
    const max = totalLines(path);
    const sorted = [...new Set(lineNumbers)].sort((a, b) => a - b);
    if (sorted.length === 0) continue;

    let start = Math.max(1, sorted[0]! - contextLines);
    let end = Math.min(max, sorted[0]! + contextLines);
    for (const n of sorted.slice(1)) {
      const nextStart = Math.max(1, n - contextLines);
      if (nextStart <= end + 1) {
        end = Math.min(max, n + contextLines);
      } else {
        regions.push({ path, startLine: start, endLine: end });
        start = nextStart;
        end = Math.min(max, n + contextLines);
      }
    }
    regions.push({ path, startLine: start, endLine: end });
  }
  return regions;
}

// ---------------------------------------------------------------------------
// The retriever used by the orchestrator
// ---------------------------------------------------------------------------

/**
 * Words that are never plausible identifiers. Deliberately short: an earlier
 * version also filtered 'add', 'test', 'fix' — ordinary English but extremely
 * common identifiers — and on "fix the add function so the test passes" every
 * term was dropped and retrieval returned nothing.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'have', 'has', 'was',
  'should', 'would', 'could', 'about', 'them', 'they', 'their', 'into', 'then',
  'please', 'make', 'sure', 'need', 'needs', 'want', 'when', 'what', 'where',
  'why', 'how', 'not', 'but', 'are', 'its', 'it', 'so', 'in', 'on', 'at', 'to',
  'of', 'is', 'be', 'can', 'will', 'just', 'also', 'some', 'any', 'all',
]);

export class Retriever {
  /** Cached scan, dropped whenever the agent writes a file. */
  private cache: SourceFile[] | null = null;

  constructor(private readonly projectRoot: string) {}

  async retrieve(query: string, hintPaths: string[] = [], maxChunks = 10): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];
    const seen = new Set<string>();

    // Plan targets and pins are stronger signals than anything inferred from
    // prose: those files go in whole, and first.
    for (const hint of hintPaths) {
      if (chunks.length >= maxChunks) return chunks;
      const chunk = await this.readWholeFile(hint);
      if (chunk && !seen.has(chunk.path)) {
        seen.add(chunk.path);
        chunks.push(chunk);
      }
    }

    const files = await this.files();
    const lineCount = (path: string): number =>
      files.find((f) => f.path === path)?.lines.length ?? 0;

    for (const term of extractTerms(query)) {
      if (chunks.length >= maxChunks) break;
      for (const region of toRegions(findMatches(files, term), CONTEXT_LINES, lineCount)) {
        if (chunks.length >= maxChunks) break;
        const key = `${region.path}:${region.startLine}`;
        if (seen.has(key) || seen.has(region.path)) continue;
        seen.add(key);
        const file = files.find((f) => f.path === region.path);
        if (!file) continue;
        chunks.push({
          path: region.path,
          startLine: region.startLine,
          endLine: region.endLine,
          text: numberLines(file.lines, region.startLine, region.endLine),
          reason: `matches "${term}"`,
        });
      }
    }
    return chunks;
  }

  /** Real paths in the project — handed to the planner so it cannot invent one. */
  async listPaths(limit = 400): Promise<string[]> {
    return (await this.files()).slice(0, limit).map((f) => f.path);
  }

  /** Drop the cached scan so the next retrieval sees the agent's own edits. */
  invalidate(): void {
    this.cache = null;
  }

  private async files(): Promise<SourceFile[]> {
    this.cache ??= await scanProject(this.projectRoot);
    return this.cache;
  }

  async readWholeFile(relPath: string, startLine?: number, endLine?: number): Promise<CodeChunk | null> {
    // The path may come from a model or a user tag — confine it.
    const abs = await confinePathOrNull(this.projectRoot, relPath);
    if (!abs) return null;
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
      const lines = (await readFile(abs, 'utf8')).split('\n');
      const from = Math.max(1, startLine ?? 1);
      const to = Math.min(lines.length, endLine ?? lines.length);
      return {
        path: relPath,
        startLine: from,
        endLine: to,
        text: numberLines(lines, from, to),
        reason: startLine ? 'range pinned by the user' : 'named as a target file or pinned',
      };
    } catch {
      return null;   // e.g. the planner named a file that does not exist yet
    }
  }
}

/**
 * Pull plausible identifiers out of a request, most promising first. Crude on
 * purpose: precision comes from the executor reading what we return, not from
 * us guessing well.
 */
export function extractTerms(text: string): string[] {
  const raw = text.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
  const scored = new Map<string, number>();
  for (const token of raw) {
    const cleaned = token.replace(/^[._]+|[._]+$/g, '');
    if (cleaned.length < 3) continue;
    if (STOPWORDS.has(cleaned.toLowerCase())) continue;
    const bonus = /[A-Z_.]/.test(cleaned) ? 2 : 0;   // identifier-shaped beats prose
    scored.set(cleaned, (scored.get(cleaned) ?? 0) + 1 + bonus);
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
}

function numberLines(lines: string[], from: number, to: number): string {
  return lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');
}
