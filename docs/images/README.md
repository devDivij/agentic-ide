# Screenshots

Every image here is a real capture of the IDE running an actual task — not a
mockup. They are referenced from the root [README](../../README.md) and from the
docs in this folder.

| File | What it shows | Used by |
|---|---|---|
| `hero.png` | An approval gate: the agent proposes a write to `report.py`, with the exact diff and Allow/Reject. Two provider 500s are visible in the log above it, absorbed by the router. | root `README.md` |
| `plan.png` | A completed three-step task — per-step timings, clickable `@path:line` references, a **Revert to here** link on each step, and the running token/cost total. | root `README.md`, `supporting_features.md` |
| `routing.png` | Live routing decisions: model, role, the reason it was picked, which key of the pool was used, and the runners-up. | root `README.md`, `router.md` |
| `trace.png` | The call tree — 21 model calls nested under the steps that caused them, with tokens and duration per node, including `error → route` fallback pairs. | root `README.md`, `orchestrator.md` |
| `settings.png` | The provider settings screen, with the model catalogue and total parameter counts per model. | root `README.md`, `setup.md` |
| `approval.png` | A second approval gate, showing the redirect note box. | `supporting_features.md` |

## Reproducing these

They were captured headless against a small throwaway project, so nothing
personal appears in them:

1. `npm run dev`
2. Open a scratch project folder with a real bug in it.
3. Give the agent a task and screenshot at 1440×900, `deviceScaleFactor: 2`,
   which yields 2880×1800.
4. Quantize before committing — these are flat-colour UI captures, so
   `magick shot.png -colors 256 -strip out.png` cuts roughly 60% with no visible
   loss. Do **not** downscale first; resampling adds noise and makes the file
   larger.

Check every capture for API keys, absolute paths containing your username, and
private repository contents before committing it.

## Why the architecture diagrams are not here

Diagrams are Mermaid blocks inline in the Markdown: they render on GitHub, diff
cleanly in review, and cannot drift out of date the way a rendered image does.
Only captures of the actual product belong in this folder.
