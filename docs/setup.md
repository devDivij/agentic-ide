# Setup

From scratch, on a machine that has never seen this project.

**Requirements:** Python ≥ 3.12 (the runtime), Node ≥ 22.5 (the UI's build
tooling) and `git` on PATH. Nothing else — the server's only dependencies are
pydantic, httpx, FastAPI and uvicorn, and SQLite ships with Python.

---

## 1. Install

```bash
git clone https://github.com/devDivij/agentic-ide.git agentzero
cd agentzero

npm install     # installs the UI, then creates server/.venv and installs
                # the Python runtime into it

npm test        # 296 offline tests (pytest); no API key needed
npm run dev     # UI      http://localhost:5319
                # server  http://localhost:4319
```

Ports are configurable with `AGENTZERO_UI_PORT` and `AGENTZERO_PORT`.

### Linux / macOS

The commands above are all you need.

### Windows

Install [Node.js ≥ 22.5](https://nodejs.org/) (the installer from nodejs.org, or
`winget install OpenJS.NodeJS.LTS`) and git as
[Git for Windows](https://git-scm.com/download/win).

The commands a model writes are POSIX shell, so the agent runs them through the
bash that ships alongside Git for Windows, found automatically. WSL's `bash` is
deliberately *not* used — it would run commands inside Linux, where the
project's path does not exist. (Running the whole app inside WSL is fine; that
is then just the Linux setup.) To point at some other shell, set
`AGENTZERO_SHELL` to the full path of a `bash.exe`.

---

## 2. Add provider keys

Open the UI, go to **Settings**, and paste at least one key. Every provider
below has a free tier or a trial key.

| Provider | Environment variable | Where to get it |
|---|---|---|
| NVIDIA NIM | `NVIDIA_API_KEY` | [build.nvidia.com](https://build.nvidia.com) — free, no card |
| Groq | `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) — free tier |
| OpenRouter | `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai) — free models + paid overflow |
| Mistral (La Plateforme) | `MISTRAL_API_KEY` | [console.mistral.ai](https://console.mistral.ai) — free tier |
| Google AI Studio (Gemini) | `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) — free tier |
| Cohere | `COHERE_API_KEY` | [dashboard.cohere.com](https://dashboard.cohere.com) — trial key |
| Ollama | *(none)* | local — [see below](#local-models-ollama) |
| Exa *(optional)* | `EXA_API_KEY` | [exa.ai](https://exa.ai) — powers the `web_search` tool |

Keys entered in Settings are stored in `~/.agentzero/settings.json` (mode
`0600`) and are never sent back to the browser.

![The settings screen listing providers, keys and the model catalogue](images/settings.png)

*Keys already supplied through the environment show as "from environment" — the
screen never displays a key's value back to you.*

### Or use environment variables

Copy the template and fill in whichever you have:

```bash
cp .env.example .env
```

Settings-screen keys and environment keys are **merged**, not one overriding the
other — both count toward the same provider's rotation. Restart `npm run dev`
after editing `.env`, then confirm with:

```bash
npm run cli -- providers
```

> ⚠️ **Never commit real keys.** `.env` and `docs/api*.txt` are gitignored. If
> you are handed a batch of keys in a scratch file, copy them into `.env` and
> delete the scratch file — do not leave it in the working tree, and do not
> `git add -f` it. A key that reaches a public commit is public forever, even
> after the file is deleted; it must be revoked at the provider.

### Multiple keys per provider

A provider can hold more than one key: add another on the Settings screen, or
suffix the environment variable, in order, with no gaps:

```
GROQ_API_KEY=first key
GROQ_API_KEY_2=second key
GROQ_API_KEY_3=third key
```

The router rotates a provider's keys least-recently-used first and gives each
its own rate-limit bucket. This only raises real throughput against providers
whose limits are **per key** — NVIDIA, Mistral, Google AI Studio and OpenRouter
are. Groq's limits are per-organisation, so extra Groq keys are tracked the same
way but will not lift its real ceiling.

---

## 3. Local models (Ollama)

Ollama needs no key. It is enabled in the catalogue by default as the
lowest-preference `floor` tier — used only when nothing else is configured or
every remote provider is rate-limited. If it is not running, calls to it fail
closed and fall through to the next candidate; nothing crashes.

```bash
# 1. Install Ollama: https://ollama.com/download (macOS/Windows/Linux)

# 2. Pull the model the catalogue expects: Seed-Coder-8B-Instruct (dense, 8B,
#    5.07GB at Q4_K_M -- fully VRAM-resident on an 8GB card, no CPU offload).
#    Not in Ollama's curated library, so this pulls the GGUF from Hugging Face
#    (defaults to Q4_K_M automatically):
ollama pull hf.co/unsloth/Seed-Coder-8B-Instruct-GGUF

# 3. Ollama serves itself on http://localhost:11434 once installed. Set this
#    only if it is running somewhere else:
echo "OLLAMA_BASE_URL=http://localhost:11434/v1" >> .env
```

**Why an 8B dense model and not something bigger.** A MoE model like
`gpt-oss-20b` or `Qwen3-Coder-30B-A3B` scores higher on raw coding benchmarks,
but neither fits in 8GB VRAM alone — they need llama.cpp/Ollama's CPU-offload
path, and real-world reports put that around 30 tok/s or worse on an 8GB card,
varying a lot with the machine's system-RAM bandwidth. A fallback that exists
only to be a predictable last resort should not itself become a new source of
timeouts, so this stays a small dense model that lives entirely in VRAM.

Ollama needs no key, so it does not appear on the Settings screen. To disable it
instead, set `enabled=False` on the `ollama` `ProviderSpec` in
[`server/agentzero/agent/providers.py`](../server/agentzero/agent/providers.py).

---

## 4. Run a task

Click the project button in the header, choose a folder, and describe a change.
The agent classifies the task, plans it, and executes step by step — asking you
to approve or reject each side-effecting action (a file write, a shell command)
before it happens.

### Headless

The runtime is fully drivable from the terminal, and does not depend on the UI:

```bash
npm run cli -- providers                             # configured / reachable
npm run cli -- run "your task" --project /path/to/repo
npm run cli -- run "fix the tests" --project . --yes # auto-approve
npm run cli -- resume --project /path/to/repo        # continue an interrupted task
npm run cli -- trace <taskId> --project /path/to/repo
```

---

## Troubleshooting

**`npm test` behaves differently depending on my keys.**
It shouldn't — the suite clears every provider variable and ignores `.env`
before each test (`offline_environment` in `server/tests/conftest.py`), so it is
green whether or not you have keys configured. If you see a difference, that is
a bug worth reporting.

**`npm run cli -- providers` shows a key as unreachable.**
The key is present but the provider rejected it — usually expired, revoked, or
copied with surrounding whitespace. The `detail` column carries the HTTP status.

**The agent says web search is not configured.**
`EXA_API_KEY` is unset. This is optional; the executor is told web search is
unavailable and continues without it. Nothing else requires the key.

**Ollama candidates are always skipped.**
Expected unless every remote provider is exhausted — Ollama is the `floor` tier.
To confirm it is reachable at all, `curl http://localhost:11434/api/tags`.
