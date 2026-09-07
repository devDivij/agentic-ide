# Project rules for Agent Zero

Rules an agent must follow when working on this repository. This file is both
the project's own configuration and a worked example of the `AGENTS.md`
protocol the IDE implements — it is injected into every model call and is never
evicted during compaction.

## Commands

- Test: `npm test` (pytest, offline, no API key required)
- Typecheck: `npm run typecheck` (`tsc --noEmit` over the UI)
- Dev: `npm run dev` (UI :5319, server :4319)
- Both `npm test` and `npm run typecheck` must pass before any change is done.

## Architecture rules

- **Control flow lives in code, never in a model.** No change may let model
  output choose the next pipeline stage, skip verification, or spawn an agent.
- **`shared/types.ts` and `server/agentzero/agent/types.py` change together.**
  The UI imports the former type-only; a mismatch is a silent runtime bug.
- Any tool with a side effect must be `side_effecting=True` in `agent/tools.py`
  so the approval gate covers it.
- Every model in `agent/providers.py` must cite its total parameter count and
  stay at or under 80B.

## Style

- Python: standard library and the four declared dependencies only (pydantic,
  httpx, FastAPI, uvicorn). Type annotations on public functions.
- TypeScript: no new runtime dependencies in the UI without discussion.
- Comments explain *why*, not *what*. Prefer a short comment on a non-obvious
  decision over a docstring restating the signature.
- No formatter is enforced. Match the file you are editing.

## Never

- Commit an API key, or a file containing one. `.env`, `.env.*` and
  `docs/api*.txt` are gitignored and must stay that way.
- Commit generated output: `ui/dist/`, `__pycache__/`, `.venv/`, `*.egg-info/`.
- Leave a temporary or scratch file tracked in git.
