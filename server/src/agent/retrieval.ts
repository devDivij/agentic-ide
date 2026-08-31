import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, dirname } from 'node:path';
import type { CodeChunk } from './types.ts';
import { confinePathOrNull, toPosix } from './paths.ts';

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

export interface SourceFile {
  path: string;
  lines: string[];
}

export async function scanProject(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && files.length < MAX_FILES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
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
        if (text.includes('\0')) continue;
        files.push({
          path: toPosix(relative(root, abs)),
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

// ---------------------------------------------------------------------------
// LocAgent Graph Types & Construction
// ---------------------------------------------------------------------------

export type NodeType = 'directory' | 'file' | 'class' | 'function';
export type EdgeType = 'contains' | 'imports' | 'inherits' | 'invokes';

export interface GraphNode {
  id: string; // e.g. "src/app.ts:MyApp"
  type: NodeType;
  name: string; 
  filePath: string;
  startLine: number;
  endLine: number;
  code: string;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: EdgeType;
}

export class CodeGraph {
  nodes = new Map<string, GraphNode>();
  edges: GraphEdge[] = [];
  
  // Indexes for fast lookup
  entityNameIndex = new Map<string, string[]>();

  addNode(node: GraphNode) {
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
      if (node.type === 'class' || node.type === 'function') {
        const existing = this.entityNameIndex.get(node.name) || [];
        existing.push(node.id);
        this.entityNameIndex.set(node.name, existing);
      }
    }
  }

  addEdge(sourceId: string, targetId: string, type: EdgeType) {
    this.edges.push({ sourceId, targetId, type });
  }

  getNeighbors(nodeId: string, types?: EdgeType[], direction: 'forward' | 'backward' | 'both' = 'forward'): string[] {
    const neighbors = new Set<string>();
    for (const e of this.edges) {
      if (types && !types.includes(e.type)) continue;
      
      if ((direction === 'forward' || direction === 'both') && e.sourceId === nodeId) {
        neighbors.add(e.targetId);
      }
      if ((direction === 'backward' || direction === 'both') && e.targetId === nodeId) {
        neighbors.add(e.sourceId);
      }
    }
    return Array.from(neighbors);
  }
}

function buildLocAgentGraph(files: SourceFile[]): CodeGraph {
  const graph = new CodeGraph();

  for (const file of files) {
    // 1. Add File Node
    graph.addNode({
      id: file.path,
      type: 'file',
      name: file.path,
      filePath: file.path,
      startLine: 1,
      endLine: file.lines.length,
      code: file.lines.join('\n')
    });

    // 2. Add Directory Nodes
    const dirParts = dirname(file.path).split(/[\\/]/).filter(p => p && p !== '.');
    let currentDir = '';
    for (const part of dirParts) {
      const parentDir = currentDir;
      currentDir = currentDir ? `${currentDir}/${part}` : part;
      graph.addNode({
        id: `dir:${currentDir}`,
        type: 'directory',
        name: part,
        filePath: currentDir,
        startLine: 1,
        endLine: 1,
        code: ''
      });
      if (parentDir) {
        graph.addEdge(`dir:${parentDir}`, `dir:${currentDir}`, 'contains');
      }
    }
    if (currentDir) {
      graph.addEdge(`dir:${currentDir}`, file.path, 'contains');
    }

    // 3. Extract Classes and Functions
    const classRegex = /^[ \t]*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_]+)/;
    const funcRegex = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z0-9_]+)|def\s+([A-Za-z0-9_]+)\s*\()/;
    const methodRegex = /^[ \t]+(?:public\s+|private\s+|protected\s+|async\s+)?(?:get\s+|set\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*[{:]/;

    let currentEntity: GraphNode | null = null;

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]!;
      
      const cmatch = line.match(classRegex);
      if (cmatch) {
        if (currentEntity) currentEntity.endLine = i;
        const className = cmatch[1]!;
        const classId = `${file.path}:${className}`;
        currentEntity = {
          id: classId,
          type: 'class',
          name: className,
          filePath: file.path,
          startLine: i + 1,
          endLine: file.lines.length,
          code: ''
        };
        graph.addNode(currentEntity);
        graph.addEdge(file.path, classId, 'contains');
        continue;
      }

      const fmatch = line.match(funcRegex);
      if (fmatch) {
        if (currentEntity) currentEntity.endLine = i;
        const funcName = fmatch[1] || fmatch[2]!;
        const funcId = `${file.path}:${funcName}`;
        currentEntity = {
          id: funcId,
          type: 'function',
          name: funcName,
          filePath: file.path,
          startLine: i + 1,
          endLine: file.lines.length,
          code: ''
        };
        graph.addNode(currentEntity);
        graph.addEdge(file.path, funcId, 'contains');
        continue;
      }

      const mmatch = line.match(methodRegex);
      if (mmatch && currentEntity && currentEntity.type === 'class') {
         // Create a method node inside the class, but we won't track it as the active entity 
         // so the class still spans the rest of the file roughly.
         const methodName = mmatch[1]!;
         const methodId = `${file.path}:${currentEntity.name}.${methodName}`;
         graph.addNode({
            id: methodId,
            type: 'function',
            name: methodName,
            filePath: file.path,
            startLine: i + 1,
            endLine: i + 10, // rough approx since we don't have block tracking
            code: ''
         });
         graph.addEdge(currentEntity.id, methodId, 'contains');
      }
    }
  }

  // 4. Second pass for invokes / imports 
  // (A simplified simulation since full AST is missing)
  for (const file of files) {
    for (const line of file.lines) {
      // Find possible function calls and link them globally
      const callMatch = line.match(/([A-Za-z0-9_]+)\s*\(/g);
      if (callMatch) {
         for (const match of callMatch) {
           const funcName = match.replace('(', '').trim();
           // if this funcName exists in our index, add an invokes edge from the file
           const targets = graph.entityNameIndex.get(funcName);
           if (targets) {
             for (const t of targets) {
               graph.addEdge(file.path, t, 'invokes');
             }
           }
         }
      }
    }
  }

  return graph;
}

// ---------------------------------------------------------------------------
// The retriever used by the orchestrator
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'have', 'has', 'was',
  'should', 'would', 'could', 'about', 'them', 'they', 'their', 'into', 'then',
  'please', 'make', 'sure', 'need', 'needs', 'want', 'when', 'what', 'where',
  'why', 'how', 'not', 'but', 'are', 'its', 'it', 'so', 'in', 'on', 'at', 'to',
  'of', 'is', 'be', 'can', 'will', 'just', 'also', 'some', 'any', 'all',
]);

export interface LineMatch { path: string; lineNumber: number }

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

export function extractTerms(text: string): string[] {
  const raw = text.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
  const scored = new Map<string, number>();
  for (const token of raw) {
    const cleaned = token.replace(/^[._]+|[._]+$/g, '');
    if (cleaned.length < 3) continue;
    if (STOPWORDS.has(cleaned.toLowerCase())) continue;
    const bonus = /[A-Z_.]/.test(cleaned) ? 2 : 0;
    scored.set(cleaned, (scored.get(cleaned) ?? 0) + 1 + bonus);
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
}

function numberLines(lines: string[], from: number, to: number): string {
  return lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');
}

export class Retriever {
  private cache: SourceFile[] | null = null;
  private graphCache: CodeGraph | null = null;

  constructor(private readonly projectRoot: string) {}

  /**
   * LocAgent: SearchEntity API simulation
   */
  async searchEntity(keywords: string[]): Promise<GraphNode[]> {
    const graph = await this.getGraph();
    const results = new Map<string, GraphNode>();
    for (const kw of keywords) {
      // Find in entityNameIndex
      const exactMatches = graph.entityNameIndex.get(kw) || [];
      for (const matchId of exactMatches) {
        const node = graph.nodes.get(matchId);
        if (node) results.set(node.id, node);
      }
      
      // Basic fuzzy search on nodes
      for (const node of graph.nodes.values()) {
        if (node.name.toLowerCase().includes(kw.toLowerCase())) {
          results.set(node.id, node);
        }
      }
    }
    return Array.from(results.values());
  }

  /**
   * LocAgent: TraverseGraph API simulation
   */
  async traverseGraph(startEntityIds: string[], hops: number = 1): Promise<GraphNode[]> {
    const graph = await this.getGraph();
    const visited = new Set<string>();
    let currentLevel = [...startEntityIds];
    
    for (let i = 0; i < hops; i++) {
      const nextLevel: string[] = [];
      for (const id of currentLevel) {
        if (!visited.has(id)) {
          visited.add(id);
          const neighbors = graph.getNeighbors(id, undefined, 'both');
          nextLevel.push(...neighbors);
        }
      }
      currentLevel = nextLevel;
    }
    // Add final level
    currentLevel.forEach(id => visited.add(id));
    
    return Array.from(visited)
      .map(id => graph.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /**
   * LocAgent: RetrieveEntity API simulation
   */
  async retrieveEntity(entityIds: string[]): Promise<CodeChunk[]> {
    const graph = await this.getGraph();
    const files = await this.files();
    const chunks: CodeChunk[] = [];
    
    for (const id of entityIds) {
      const node = graph.nodes.get(id);
      if (!node) continue;
      
      const file = files.find(f => f.path === node.filePath);
      if (!file) continue;
      
      chunks.push({
        path: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        text: numberLines(file.lines, node.startLine, node.endLine),
        reason: `LocAgent retrieved entity: ${node.name}`
      });
    }
    return chunks;
  }

  async retrieve(query: string, hintPaths: string[] = [], maxChunks = 10): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];
    const seen = new Set<string>();

    for (const hint of hintPaths) {
      if (chunks.length >= maxChunks) return chunks;
      const chunk = await this.readWholeFile(hint);
      if (chunk && !seen.has(chunk.path)) {
        seen.add(chunk.path);
        chunks.push(chunk);
      }
    }

    const terms = extractTerms(query);
    if (terms.length === 0) return chunks;

    // LocAgent Workflow:
    // 1. SearchEntity
    const initialEntities = await this.searchEntity(terms);
    
    // 2. TraverseGraph (1 hop context expansion)
    const expandedEntities = await this.traverseGraph(initialEntities.map(e => e.id), 1);
    
    // Sort entities to prioritize those matching query terms closely
    expandedEntities.sort((a, b) => {
      let aScore = 0;
      let bScore = 0;
      for (const term of terms) {
        if (a.name.toLowerCase().includes(term.toLowerCase())) aScore++;
        if (b.name.toLowerCase().includes(term.toLowerCase())) bScore++;
      }
      return bScore - aScore; // Descending
    });

    // 3. RetrieveEntity
    const candidateChunks = await this.retrieveEntity(expandedEntities.map(e => e.id));
    
    for (const chunk of candidateChunks) {
      if (chunks.length >= maxChunks) break;
      const key = `${chunk.path}:${chunk.startLine}`;
      if (seen.has(key) || seen.has(chunk.path)) continue; // avoid overlapping chunks or whole files
      seen.add(key);
      chunks.push(chunk);
    }

    return chunks;
  }

  async listPaths(limit = 400): Promise<string[]> {
    return (await this.files()).slice(0, limit).map((f) => f.path);
  }

  invalidate(): void {
    this.cache = null;
    this.graphCache = null;
  }

  private async files(): Promise<SourceFile[]> {
    if (!this.cache) {
      this.cache = await scanProject(this.projectRoot);
    }
    return this.cache;
  }

  private async getGraph(): Promise<CodeGraph> {
    if (!this.graphCache) {
      const files = await this.files();
      this.graphCache = buildLocAgentGraph(files);
    }
    return this.graphCache;
  }

  async readWholeFile(relPath: string, startLine?: number, endLine?: number): Promise<CodeChunk | null> {
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
      return null;
    }
  }
}
