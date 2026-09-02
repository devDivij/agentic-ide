"""
Finding the code a step needs: a pure-Python project scan, a lexical matcher,
and a lightweight symbol graph (LocAgent-style) layered on top of both.

Nothing here shells out. An earlier version called ripgrep, and a missing
binary read as "no matches" -- the worst possible failure for a search tool,
because the agent then concludes the code does not exist.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Callable, Literal

from .paths import confine_path_or_none, to_posix
from .types import CodeChunk, Data

IGNORED_DIRS = {
    "node_modules", ".git", ".agentzero", "dist", "build", "target", "out",
    ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", ".turbo",
    "vendor", ".idea", ".vscode", "coverage", ".pytest_cache", ".mypy_cache",
}

TEXT_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
    ".java", ".kt", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift", ".php",
    ".scala", ".sh", ".bash", ".sql", ".html", ".css", ".scss", ".vue", ".svelte",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".md", ".txt",
    ".gradle", ".tf", ".proto", ".graphql", ".lua", ".jl", ".r",
}

MAX_FILE_BYTES = 400_000
MAX_FILES = 4_000

_EXTENSIONLESS_NAMES = re.compile(r"^(Makefile|Dockerfile|README|LICENSE|AGENTS)$", re.IGNORECASE)


class SourceFile(Data):
    path: str
    lines: list[str]


def scan_project(root: str) -> list[SourceFile]:
    files: list[SourceFile] = []
    queue: list[str] = [root]

    while queue and len(files) < MAX_FILES:
        directory = queue.pop(0)
        try:
            entries = sorted(os.scandir(directory), key=lambda e: e.name)
        except OSError:
            continue

        subdirs: list[str] = []
        for entry in entries:
            if entry.name in IGNORED_DIRS:
                continue
            if entry.is_dir():
                subdirs.append(entry.path)
                continue
            if not entry.is_file() or not _is_text_file(entry.name):
                continue
            if len(files) >= MAX_FILES:
                break
            try:
                if entry.stat().st_size > MAX_FILE_BYTES:
                    continue
                text = Path(entry.path).read_text(encoding="utf-8")
                if "\0" in text:
                    continue
                files.append(SourceFile(
                    path=to_posix(os.path.relpath(entry.path, root)),
                    lines=text.split("\n")))
            except (OSError, UnicodeDecodeError):
                continue
        queue.extend(subdirs)
    return files


def _is_text_file(name: str) -> bool:
    ext = os.path.splitext(name)[1].lower()
    if ext in TEXT_EXTENSIONS:
        return True
    return ext == "" and bool(_EXTENSIONLESS_NAMES.match(name))


# ---------------------------------------------------------------------------
# LocAgent graph types and construction
# ---------------------------------------------------------------------------

NodeType = Literal["directory", "file", "class", "function"]
EdgeType = Literal["contains", "imports", "inherits", "invokes"]


class GraphNode(Data):
    id: str                    # e.g. "src/app.ts:MyApp"
    type: NodeType
    name: str
    file_path: str
    start_line: int
    end_line: int
    code: str


class GraphEdge(Data):
    source_id: str
    target_id: str
    type: EdgeType


class CodeGraph:
    def __init__(self) -> None:
        self.nodes: dict[str, GraphNode] = {}
        self.edges: list[GraphEdge] = []
        # Index for fast lookup.
        self.entity_name_index: dict[str, list[str]] = {}

    def add_node(self, node: GraphNode) -> None:
        if node.id in self.nodes:
            return
        self.nodes[node.id] = node
        if node.type in ("class", "function"):
            self.entity_name_index.setdefault(node.name, []).append(node.id)

    def add_edge(self, source_id: str, target_id: str, edge_type: EdgeType) -> None:
        self.edges.append(
            GraphEdge(source_id=source_id, target_id=target_id, type=edge_type))

    def neighbors(self, node_id: str, types: list[EdgeType] | None = None,
                  direction: Literal["forward", "backward", "both"] = "forward") -> list[str]:
        found: dict[str, None] = {}       # dict for insertion-ordered uniqueness
        for edge in self.edges:
            if types is not None and edge.type not in types:
                continue
            if direction in ("forward", "both") and edge.source_id == node_id:
                found[edge.target_id] = None
            if direction in ("backward", "both") and edge.target_id == node_id:
                found[edge.source_id] = None
        return list(found)


_CLASS_RE = re.compile(r"^[ \t]*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_]+)")
_FUNC_RE = re.compile(
    r"^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?"
    r"(?:function\s+([A-Za-z0-9_]+)|def\s+([A-Za-z0-9_]+)\s*\()")
_METHOD_RE = re.compile(
    r"^[ \t]+(?:public\s+|private\s+|protected\s+|async\s+)?(?:get\s+|set\s+)?"
    r"([A-Za-z0-9_]+)\s*\([^)]*\)\s*[{:]")
_CALL_RE = re.compile(r"([A-Za-z0-9_]+)\s*\(")


def build_locagent_graph(files: list[SourceFile]) -> CodeGraph:
    graph = CodeGraph()

    for file in files:
        # 1. File node.
        graph.add_node(GraphNode(
            id=file.path, type="file", name=file.path, file_path=file.path,
            start_line=1, end_line=len(file.lines), code="\n".join(file.lines)))

        # 2. Directory nodes.
        dir_parts = [p for p in re.split(r"[\\/]", os.path.dirname(file.path))
                     if p and p != "."]
        current_dir = ""
        for part in dir_parts:
            parent_dir = current_dir
            current_dir = f"{current_dir}/{part}" if current_dir else part
            graph.add_node(GraphNode(
                id=f"dir:{current_dir}", type="directory", name=part,
                file_path=current_dir, start_line=1, end_line=1, code=""))
            if parent_dir:
                graph.add_edge(f"dir:{parent_dir}", f"dir:{current_dir}", "contains")
        if current_dir:
            graph.add_edge(f"dir:{current_dir}", file.path, "contains")

        # 3. Classes and functions.
        current_entity: GraphNode | None = None

        for i, line in enumerate(file.lines):
            class_match = _CLASS_RE.match(line)
            if class_match:
                if current_entity is not None:
                    current_entity.end_line = i
                class_name = class_match.group(1)
                class_id = f"{file.path}:{class_name}"
                current_entity = GraphNode(
                    id=class_id, type="class", name=class_name, file_path=file.path,
                    start_line=i + 1, end_line=len(file.lines), code="")
                graph.add_node(current_entity)
                graph.add_edge(file.path, class_id, "contains")
                continue

            func_match = _FUNC_RE.match(line)
            is_indented = line.startswith(" ") or line.startswith("\t")

            if func_match:
                if is_indented and current_entity is not None and current_entity.type == "class":
                    # It's an indented function inside a class, treat as a method
                    method_name = func_match.group(1) or func_match.group(2)
                    method_id = f"{file.path}:{current_entity.name}.{method_name}"
                    graph.add_node(GraphNode(
                        id=method_id, type="function", name=method_name,
                        file_path=file.path, start_line=i + 1,
                        end_line=i + 10,
                        code=""))
                    graph.add_edge(current_entity.id, method_id, "contains")
                    continue
                else:
                    if current_entity is not None:
                        current_entity.end_line = i
                    func_name = func_match.group(1) or func_match.group(2)
                    func_id = f"{file.path}:{func_name}"
                    current_entity = GraphNode(
                        id=func_id, type="function", name=func_name, file_path=file.path,
                        start_line=i + 1, end_line=len(file.lines), code="")
                    graph.add_node(current_entity)
                    graph.add_edge(file.path, func_id, "contains")
                    continue

            method_match = _METHOD_RE.match(line)
            if method_match and current_entity is not None and current_entity.type == "class":
                # A method node inside the class. Not tracked as the active
                # entity, so the class still spans the rest of the file roughly.
                method_name = method_match.group(1)
                method_id = f"{file.path}:{current_entity.name}.{method_name}"
                graph.add_node(GraphNode(
                    id=method_id, type="function", name=method_name,
                    file_path=file.path, start_line=i + 1,
                    end_line=i + 10,      # rough: no block tracking here
                    code=""))
                graph.add_edge(current_entity.id, method_id, "contains")

    # 4. Second pass for invokes/imports (a simplification: no real AST).
    for file in files:
        for line in file.lines:
            for func_name in _CALL_RE.findall(line):
                for target in graph.entity_name_index.get(func_name, []):
                    graph.add_edge(file.path, target, "invokes")

    return graph


# ---------------------------------------------------------------------------
# The retriever used by the orchestrator
# ---------------------------------------------------------------------------

STOPWORDS = {
    "the", "and", "for", "this", "that", "with", "from", "have", "has", "was",
    "should", "would", "could", "about", "them", "they", "their", "into", "then",
    "please", "make", "sure", "need", "needs", "want", "when", "what", "where",
    "why", "how", "not", "but", "are", "its", "it", "so", "in", "on", "at", "to",
    "of", "is", "be", "can", "will", "just", "also", "some", "any", "all",
}

# Deliberately short: this model has no tools and a FIXED candidate list
# already narrowed by graph search (search_entity + one hop of
# traverse_graph) -- it cannot explore the repo, trace call flows, or
# discover anything not already listed below it. The original version of
# this prompt (a GitHub-issue localization workflow lifted wholesale from a
# LocAgent-style benchmark prompt) told it to do all of that anyway, which is
# just noise for a task that is actually "pick from this list."
TASK_INSTRUCTION = """
Given this issue description and a list of candidate code locations already
found by searching the codebase, decide which of the candidates are actually
relevant to the issue.
""".strip()

# The candidates below are already narrowed by graph search (search_entity +
# one hop of traverse_graph) -- this contract asks for a ranking over THAT
# short list, not open-ended localization prose. Matches the rest of the
# system's convention (workers.py): a concrete JSON example, not a type
# description, because a small model follows an example far more reliably.
# The old version of this prompt asked for triple-backtick prose ("wrapped
# with triple backticks", "it's fine if it's very long") while the call sent
# response_format=json_object -- those two instructions fight each other,
# which is what produced the json_validate_failed / truncated_reasoning
# failures seen in production traces.
LOCATE_CONTRACT = """
Reply with ONLY this JSON object and nothing else:
{"entityIds": ["path/to/file.py:ClassName.method_name", "other/file.py:function_name"]}

List the candidate ids above that are actually relevant to the query, most
relevant first. Use the ids exactly as given in "Candidate locations" -- do
not invent new ones. An empty list is valid if none of them are relevant.
""".strip()

class LineMatch(Data):
    path: str
    line_number: int


class Region(Data):
    path: str
    start_line: int
    end_line: int


def find_matches(files: list[SourceFile], term: str, max_per_file: int = 3) -> list[LineMatch]:
    needle = term.lower()
    if not needle:
        return []
    out: list[LineMatch] = []
    for file in files:
        found = 0
        for i, line in enumerate(file.lines):
            if needle not in line.lower():
                continue
            out.append(LineMatch(path=file.path, line_number=i + 1))
            found += 1
            if found >= max_per_file:
                break
    return out


def to_regions(matches: list[LineMatch], context_lines: int,
               total_lines: Callable[[str], int]) -> list[Region]:
    by_path: dict[str, list[int]] = {}
    for match in matches:
        by_path.setdefault(match.path, []).append(match.line_number)

    regions: list[Region] = []
    for path, line_numbers in by_path.items():
        maximum = total_lines(path)
        ordered = sorted(set(line_numbers))
        if not ordered:
            continue

        start = max(1, ordered[0] - context_lines)
        end = min(maximum, ordered[0] + context_lines)
        for n in ordered[1:]:
            next_start = max(1, n - context_lines)
            if next_start <= end + 1:
                end = min(maximum, n + context_lines)
            else:
                regions.append(Region(path=path, start_line=start, end_line=end))
                start = next_start
                end = min(maximum, n + context_lines)
        regions.append(Region(path=path, start_line=start, end_line=end))
    return regions


_TERM_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")
_HAS_SIGNAL = re.compile(r"[A-Z_.]")


def extract_terms(text: str) -> list[str]:
    scored: dict[str, int] = {}
    for token in _TERM_RE.findall(text):
        cleaned = token.strip("._")
        if len(cleaned) < 3:
            continue
        if cleaned.lower() in STOPWORDS:
            continue
        bonus = 2 if _HAS_SIGNAL.search(cleaned) else 0
        scored[cleaned] = scored.get(cleaned, 0) + 1 + bonus
    ranked = sorted(scored.items(), key=lambda item: -item[1])
    return [term for term, _ in ranked[:8]]


def number_lines(lines: list[str], start: int, end: int) -> str:
    return "\n".join(f"{start + i}: {line}"
                     for i, line in enumerate(lines[start - 1:end]))


class Retriever:
    def __init__(self, project_root: str) -> None:
        self.project_root = project_root
        self._cache: list[SourceFile] | None = None
        self._graph_cache: CodeGraph | None = None
        self.agent = None

    def search_entity(self, keywords: list[str]) -> list[GraphNode]:
        """LocAgent: SearchEntity."""
        graph = self._graph()
        results: dict[str, GraphNode] = {}
        for keyword in keywords:
            for match_id in graph.entity_name_index.get(keyword, []):
                node = graph.nodes.get(match_id)
                if node is not None:
                    results[node.id] = node
            lowered = keyword.lower()
            for node in graph.nodes.values():
                if lowered in node.name.lower():
                    results[node.id] = node
        return list(results.values())

    def traverse_graph(self, start_entity_ids: list[str], hops: int = 1) -> list[GraphNode]:
        """LocAgent: TraverseGraph."""
        graph = self._graph()
        visited: dict[str, None] = {}
        current_level = list(start_entity_ids)

        for _ in range(hops):
            next_level: list[str] = []
            for node_id in current_level:
                if node_id not in visited:
                    visited[node_id] = None
                    next_level.extend(graph.neighbors(node_id, None, "both"))
            current_level = next_level
        for node_id in current_level:
            visited[node_id] = None

        return [graph.nodes[i] for i in visited if i in graph.nodes]

    def retrieve_entity(self, entity_ids: list[str]) -> list[CodeChunk]:
        """LocAgent: RetrieveEntity."""
        graph = self._graph()
        files = self._files()
        chunks: list[CodeChunk] = []

        for entity_id in entity_ids:
            node = graph.nodes.get(entity_id)
            if node is None:
                continue
            file = next((f for f in files if f.path == node.file_path), None)
            if file is None:
                continue
            chunks.append(CodeChunk(
                path=node.file_path, start_line=node.start_line, end_line=node.end_line,
                text=number_lines(file.lines, node.start_line, node.end_line),
                reason=f"LocAgent retrieved entity: {node.name}"))
        return chunks

    def retrieve(self, query: str, hint_paths: list[str] | None = None,
                 max_chunks: int = 10, task_id: str = "") -> list[CodeChunk]:
        chunks: list[CodeChunk] = []
        seen: set[str] = set()

        for hint in hint_paths or []:
            if len(chunks) >= max_chunks:
                return chunks
            chunk = self.read_whole_file(hint)
            if chunk is not None and chunk.path not in seen:
                seen.add(chunk.path)
                chunks.append(chunk)

        terms = extract_terms(query)
        if not terms:
            return chunks

        # LocAgent workflow: search, expand one hop, then retrieve.
        initial = self.search_entity(terms)
        expanded = self.traverse_graph([e.id for e in initial], 1)

        if not expanded:
            return chunks

        if getattr(self, "agent", None) is not None:
            # Lazy imports: context.py imports extract_terms from this module
            # at load time, so importing build_context back at module level
            # here would be a cycle. By call time both modules are already
            # fully loaded.
            from .call import call_model
            from .context import ContextRequest, build_context
            from pydantic import Field

            class RankedEntities(Data):
                entity_ids: list[str] = Field(
                    description="The IDs of the entities most relevant to the query.")

            prompt = TASK_INSTRUCTION + "\n\n"
            prompt += f"Issue:\n{query}\n\nCandidate locations:\n"
            for node in expanded:
                prompt += f"- {node.id}\n"

            try:
                result = call_model(
                    self.agent,
                    task_id=task_id or "locagent_retrieval",
                    role="locate",
                    context=build_context(ContextRequest(
                        role="locate", prompt=prompt, output_contract=LOCATE_CONTRACT)),
                    schema=RankedEntities,
                    max_tokens=2048,
                    temperature=0.2,
                    # 'locate' is in REASONING_ROLES, so ranking picks the
                    # highest-elo model -- often a reasoning model with
                    # thinking on by default. Sorting a short list gains
                    # nothing from deliberation, and the trace this fix was
                    # written against showed exactly this model burning
                    # 2047 and then 6144 tokens thinking before ever
                    # answering. Same rationale as classify_task.
                    suppress_reasoning=True,
                    # This is a ranking nicety with a cheap lexical fallback
                    # right below -- it should not spend the same per-provider
                    # retry budget as the task's own work, and must never
                    # block the step waiting on a busy rate-limit bucket the
                    # way real work is allowed to.
                    max_fallbacks=0, max_wait_ms=0,
                )
                ranked_ids = result.value.entity_ids
                id_to_node = {n.id: n for n in expanded}
                expanded = [id_to_node[eid] for eid in ranked_ids if eid in id_to_node]
            except Exception:
                lowered = [t.lower() for t in terms]
                def closeness(node: GraphNode) -> int:
                    name = node.name.lower()
                    return -sum(1 for term in lowered if term in name)
                expanded.sort(key=closeness)
        else:
            lowered = [t.lower() for t in terms]
            def closeness(node: GraphNode) -> int:
                name = node.name.lower()
                return -sum(1 for term in lowered if term in name)
            expanded.sort(key=closeness)

        for chunk in self.retrieve_entity([e.id for e in expanded]):
            if len(chunks) >= max_chunks:
                break
            key = f"{chunk.path}:{chunk.start_line}"
            # Avoid overlapping chunks, and whole files already included.
            if key in seen or chunk.path in seen:
                continue
            seen.add(key)
            chunks.append(chunk)

        return chunks

    def list_paths(self, limit: int = 400) -> list[str]:
        return [f.path for f in self._files()[:limit]]

    def invalidate(self) -> None:
        self._cache = None
        self._graph_cache = None

    def _files(self) -> list[SourceFile]:
        if self._cache is None:
            self._cache = scan_project(self.project_root)
        return self._cache

    def _graph(self) -> CodeGraph:
        if self._graph_cache is None:
            self._graph_cache = build_locagent_graph(self._files())
        return self._graph_cache

    def read_whole_file(self, rel_path: str, start_line: int | None = None,
                        end_line: int | None = None) -> CodeChunk | None:
        abs_path = confine_path_or_none(self.project_root, rel_path)
        if abs_path is None:
            return None
        try:
            info = os.stat(abs_path)
            if not os.path.isfile(abs_path) or info.st_size > MAX_FILE_BYTES:
                return None
            lines = Path(abs_path).read_text(encoding="utf-8").split("\n")
        except (OSError, UnicodeDecodeError):
            return None
        start = max(1, start_line or 1)
        end = min(len(lines), end_line if end_line is not None else len(lines))
        return CodeChunk(
            path=rel_path, start_line=start, end_line=end,
            text=number_lines(lines, start, end),
            reason=("range pinned by the user" if start_line
                    else "named as a target file or pinned"))
