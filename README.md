# Agent Zero

An agentic coding IDE built for **small open-weight models (≤80B total
parameters)** running on free-tier / pay-as-you-go APIs or local hardware.
One deterministic loop in code drives many narrow, schema-checked model calls;
every piece of task state lives in SQLite, so nothing is lost when a call, a
provider, or the whole process dies.

Two documents, for two questions:

- **[docs/ARCHITECTURE-MAP.md](docs/ARCHITECTURE-MAP.md)** — *what is here*: a
  diagrammed map of the system as built, including a section on what is
  deliberately not built yet. Start here.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — *why it is shaped this
  way*: the reasoning, the trade-offs, and a guided reading order for the
  code (the agentic core is 16 small files; budget 2–3 hours for all of it).

## Setup (Linux, macOS or Windows, from scratch)

Requirements: **Python ≥ 3.12** (the runtime), **Node ≥ 22.5** (the UI's build
tooling) and **git** on PATH. Nothing else — the server's only dependencies are
pydantic, httpx, FastAPI and uvicorn, and SQLite ships with Python.

On **Windows**, that git should be [Git for
Windows](https://git-scm.com/download/win): the commands a model writes are
POSIX shell, so the agent runs them through the bash that ships alongside it,
found automatically. WSL's `bash` is deliberately *not* used — it would run
commands inside Linux, where the project's path does not exist. (Running the
whole app inside WSL is fine; that is then just the Linux setup. To point at
some other shell, set `AGENTZERO_SHELL` to the full path of a `bash.exe`.)

```bash
git clone <this repo> && cd agentzero
npm install            # installs the UI, then creates server/.venv and
                       # installs the Python runtime into it
npm test               # offline test suite (pytest); no API key needed

npm run dev            # starts both halves:
                       #   UI      http://localhost:5319
                       #   server  http://localhost:4319
```

Open the UI, go to **Settings**, and paste at least one API key:

| Provider | Key | Where to get it |
|---|---|---|
| NVIDIA NIM | `NVIDIA_API_KEY` | build.nvidia.com — free, no card |
| Groq | `GROQ_API_KEY` | console.groq.com — free tier |
| OpenRouter | `OPENROUTER_API_KEY` | openrouter.ai — free models + paid overflow |
| Ollama | (none) | local; flip `enabled: true` in `server/agentzero/agent/providers.py` after `ollama pull qwen2.5-coder:7b` |

Keys are stored in `~/.agentzero/settings.json` (mode 0600) and are never sent
back to the browser. The environment variables above work too (see
`.env.example`).

Then click the project button in the header, choose a folder, and describe a
change. The agent classifies the task, plans it, executes step by step (asking
before anything side-effecting runs), and hands you a hunk-by-hunk diff to
accept or reject.

## Headless (no UI)

The runtime is fully drivable from the terminal — this is how the evaluation
harness runs it, and the proof the agent does not depend on the UI:

```bash
npm run cli -- providers                          # configured / reachable
npm run cli -- run "your task" --project /path/to/repo
npm run cli -- run "fix the tests" --project . --yes --test "pytest -q"
npm run cli -- resume --project /path/to/repo     # continue an interrupted task
npm run cli -- trace <taskId> --project /path/to/repo
```

## In the chat

- `@path`, `@path:12`, `@path:12-40` — pin a file or exact lines into the
  agent's context (click lines in the file viewer to insert these).
- `/bytheway <question>` — ask one isolated question with zero task context;
  the running task is untouched.
- `AGENTS.md` in the project root — per-project rules (style, test command,
  conventions), injected into every model call.

## Layout

```
server/agentzero/agent/   the agentic core — start with types.py, then orchestrator.py
server/agentzero/web/     HTTP host: routes, SSE stream, review, settings
server/agentzero/cli.py   headless driver
server/tests/             the offline suite (pytest)
shared/types.ts           the wire contract, mirrored by agent/types.py
ui/src/                   React front-end (chat, files, review, routing, trace, settings)
docs/                     architecture and design rationale
```

The server is Python and has no build step. `shared/types.ts` stays TypeScript
on purpose: the UI imports it type-only, so the browser half keeps compile-time
checking of what the server sends, and `agent/types.py` emits exactly those
camelCase spellings. The UI is a standard Vite app; `npm run build` produces
`ui/dist`, which the server serves so production is a single process.

The `npm` scripts are unchanged (`dev`, `test`, `cli`, `build`) — they now
shell into `server/.venv` rather than `tsx`, so nothing you already type has
to change.
