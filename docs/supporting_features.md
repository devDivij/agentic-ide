# Agentic IDE: Supporting Features

While robust orchestration, retrieval, and context management form the core of the Agentic IDE, several supporting features elevate the system from a basic autonomous script to a safe, controllable, and highly capable pair-programmer. 

These features give the developer precise control over what the agent sees, what it can do, and how its work is finalized.

---

## 1. Manual Context Control

Even the smartest automated retrieval pipeline cannot read a developer's mind. The IDE provides granular tools for manual context management, ensuring the developer can easily steer the model.

- **Clickable File and Line Tags:** Users can effortlessly add or remove files and specific code blocks from the active context. Both the input box and the output chat support clickable tags (e.g., `@path/to/file.py:10-20`). Clicking these tags pins the exact code block into the agent's memory.
- **The `/bytheway` Command:** Often, a developer needs to ask a quick, isolated question (e.g., "What does this regex do?") without confusing the ongoing task's context. The `/bytheway` command intercepts the prompt, isolates it completely from the current task's memory, answers it cleanly, and then seamlessly returns the developer to their original task context.

*(For deep technical details on how context pinning survives eviction, see the [Context Handling documentation](file:///C:/Users/bhara/agentic-ide/docs/context_handling.md))*

---

## 2. Autonomy with Safety (Terminal, File, and Web)

The agent possesses significant autonomy, equipped with a curated set of [tools](file:///C:/Users/bhara/agentic-ide/server/agentzero/agent/tools.py) to read files, write code, search the web (via Exa), and run terminal commands.

- **Active Feedback Loops:** The agent actively uses these tools to verify its own work. For example, when it writes a file, the IDE immediately runs a syntax check. If it fails, the agent is instantly told to fix it. The agent can also use `run_command` to run the project's test suite or Git commands to validate behavior.
- **Strict Human Approval Gates:** Autonomy without safety is dangerous. Any tool that produces a side effect—such as writing a file, running a bash script, or starting a server—is intercepted by a strict human-approval gate. The agent *must* ask for explicit permission before executing the action, ensuring no destructive commands are run silently.

---

## 3. Human-in-the-Loop Review

When a task finishes, the user shouldn't have to blindly accept hundreds of lines of AI-generated code. The IDE provides a granular, Git-backed review interface powered by the [review engine](file:///C:/Users/bhara/agentic-ide/server/agentzero/web/review.py).

- **Accurate Git Diffs:** The system maintains a hidden, shadow Git repository. When a task completes, it generates an accurate, readable unified diff comparing the task's start state to its finish state.
- **Block-Level (Hunk) Accept/Reject:** The user is not forced into an "all-or-nothing" decision. The diff is parsed into individual hunks, allowing the developer to accept or reject changes line-block by line-block.
- **Intelligent Partial Approvals:** If a user rejects a specific block of code, what happens to the rest of the task? The system calculates the "blast radius." It identifies any subsequent steps that depended on the rejected code, resets the files to baseline, applies only the accepted patches, and automatically requeues the dependent steps with the human's rejection feedback attached. The task resumes safely without breaking.

---

## 4. Persistent Preferences (AGENTS.md)

Developers often establish project-wide rules (e.g., "Always use functional React components" or "Never use snake_case"). These are stored in a project-level `AGENTS.md` file.

- **Guaranteed Adherence:** The IDE parses this file and injects it into every single prompt sent to the model.
- **Compaction Immunity:** Because it is classified as a critical infrastructure block, the `AGENTS.md` rules are strictly pinned. Even during severe context compaction events where old logs and code chunks are evicted to save tokens, the project rules survive. A stated preference is mathematically guaranteed to be present in the context window for every single output.
