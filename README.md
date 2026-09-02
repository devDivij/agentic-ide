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
| Mistral (La Plateforme) | `MISTRAL_API_KEY` | console.mistral.ai — free tier |
| Google AI Studio (Gemini API) | `GEMINI_API_KEY` | aistudio.google.com — free tier |
| Cohere | `COHERE_API_KEY` | dashboard.cohere.com — trial key |
| Ollama | (none) | local — see below |

Keys are stored in `~/.agentzero/settings.json` (mode 0600) and are never sent
back to the browser. The environment variables above work too (see
`.env.example`) -- and settings-screen keys and environment keys are merged,
not one overriding the other.

A provider can hold more than one key: add another on the Settings screen, or
suffix the environment variable (`GROQ_API_KEY_2`, `GROQ_API_KEY_3`, ...). The
router rotates across a provider's keys least-recently-used first and gives
each its own rate-limit bucket, so this only actually raises your throughput
against a provider whose limits are per-key -- NVIDIA, Mistral, Google AI
Studio and OpenRouter are; Groq's are per-organisation, so extra Groq keys are
tracked the same way but won't lift its real ceiling.

### Local models (Ollama)

Ollama needs no key — it's on in the catalogue by default, as the lowest-
preference "floor" option, used only when nothing else is configured or every
remote provider is rate-limited. If it's not actually running, calls to it
just fail closed and fall through to the next candidate; nothing crashes.

```bash
# 1. Install Ollama: https://ollama.com/download (macOS/Windows/Linux)

# 2. Pull the model the catalogue expects: Seed-Coder-8B-Instruct (dense, 8B,
#    5.07GB at Q4_K_M -- fully VRAM-resident on an 8GB card, no CPU offload).
#    Not in Ollama's own curated library, so this pulls the GGUF straight
#    from Hugging Face (defaults to Q4_K_M automatically):
ollama pull hf.co/unsloth/Seed-Coder-8B-Instruct-GGUF

# 3. Ollama serves itself on http://localhost:11434 once installed — nothing
#    else to start. Only set this if it's running somewhere else:
echo "OLLAMA_BASE_URL=http://localhost:11434/v1" >> .env
```

Why this model and not something bigger: a MoE model like gpt-oss-20b or
Qwen3-Coder-30B-A3B scores higher on raw coding benchmarks, but neither fits
in 8GB VRAM alone — they need `llama.cpp`/Ollama's CPU-offload path, and
real-world reports put that around 30 tok/s or worse on an 8GB card, varying
a lot with the machine's system-RAM bandwidth. A fallback that's only there
to be a predictable last resort shouldn't itself become a new source of
timeouts, so this stays a small dense model that lives entirely in VRAM.

Nothing to do in the UI: it needs no key, so it won't appear on the Settings
screen. To turn it off instead, set `enabled=False` on the `ollama`
`ProviderSpec` in `server/agentzero/agent/providers.py`.

Then click the project button in the header, choose a folder, and describe a
change. The agent classifies the task, plans it, and executes step by step —
asking you to approve or reject each side-effecting action (a file write, a
shell command) before it happens.

## Headless (no UI)

The runtime is fully drivable from the terminal — this is how the evaluation
harness runs it, and the proof the agent does not depend on the UI:

```bash
npm run cli -- providers                          # configured / reachable
npm run cli -- run "your task" --project /path/to/repo
npm run cli -- run "fix the tests" --project . --yes
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
server/agentzero/web/     HTTP host: routes, SSE stream, revert, settings
server/agentzero/cli.py   headless driver
server/tests/             the offline suite (pytest)
shared/types.ts           the wire contract, mirrored by agent/types.py
ui/src/                   React front-end (chat, files, routing, trace, settings)
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
