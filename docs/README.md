# Agent Zero — documentation

Start with the [project README](../README.md) for what this is and a
60-second quickstart. These pages go deeper.

| Doc | Read it when you want to know |
|---|---|
| **[Setup](setup.md)** | How to get it running from scratch — Linux, macOS, Windows, provider keys, multiple keys per provider, local models via Ollama, troubleshooting. |
| **[Project structure](project_structure.md)** | What every directory and file does. The map to read before your first change. |
| **[Orchestration](orchestrator.md)** | The deterministic loop, triage classification, planning, the stuck-detector, the failure taxonomy, backtracking and replanning, L2 batch review, resuming. |
| **[Routing](router.md)** | The model catalogue and its ≤80B constraint, preference tiers, the ranking algorithm, rate buckets, graceful fallback, and the pay-vs-wait formula. |
| **[Context handling](context_handling.md)** | Why there is no rolling transcript, how context is rebuilt from SQLite each call, the eviction tiers used during compaction, user pins, and `/bytheway`. |
| **[Retrieval](retrieval.md)** | The code graph, why plain vector embeddings were rejected, graph traversal, LLM ranking, and the lexical fallback when ranking fails. |
| **[Supporting features](supporting_features.md)** | Manual context control, the tool catalogue, approval gates for side-effecting actions, revert, and `AGENTS.md` project memory. |

## Reading order for a new contributor

1. [Project structure](project_structure.md) — the map.
2. [`shared/types.ts`](../shared/types.ts) — the wire contract. Every event,
   status payload and trace node is defined here, and
   [`agent/types.py`](../server/agentzero/agent/types.py) mirrors it exactly.
3. [Orchestration](orchestrator.md), then
   [`orchestrator.py`](../server/agentzero/agent/orchestrator.py) — the loop
   everything else serves.
4. Whichever subsystem you are changing.

## Diagrams

Architecture diagrams are Mermaid blocks inline in these pages and in the root
README — they render on GitHub, diff cleanly, and never go stale as images do.
Screenshots live in [`images/`](images/); see
[`images/README.md`](images/README.md) for the shot list.
