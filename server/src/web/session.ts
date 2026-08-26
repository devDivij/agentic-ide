/**
 * One session per open project: runs tasks and bridges between the headless
 * runtime and a human on the other end of the SSE stream.
 *
 * The runtime blocks on its approval callback with no idea a browser is
 * involved — this class turns that callback into a question on screen and the
 * answering POST back into the promise's resolution. It streams trace events
 * by polling the same SQLite rows the dashboard reads after the fact, so the
 * live view and the post-hoc view are the same data by construction.
 */

import type { ChildProcess } from 'node:child_process';

import {
  createAgent, runTask, stopBackground, type Agent, type TaskOutcome,
} from '../agent/orchestrator.ts';
import { scoreTask } from '../agent/router.ts';
import { describeEffect } from '../agent/tools.ts';
import type { ToolCall } from '../agent/types.ts';
import type { ApprovalRequest, ServerEvent, StepWire } from '../shared/types.ts';
import type { EventBus } from './events.ts';

export class Session {
  private agent: Agent | null = null;
  /** Servers the agent started, kept alive past the task that started them. */
  private background: ChildProcess[] = [];
  /** Approval requests waiting on a human, keyed by the id sent to the UI. */
  private pending = new Map<number, (approved: boolean) => void>();
  private approvalCounter = 0;
  private currentTaskId: string | null = null;
  private streamed = new Set<number>();
  private pump: NodeJS.Timeout | null = null;

  constructor(
    readonly projectRoot: string,
    private keys: Map<string, string>,
    private bus: EventBus,
  ) {}

  get isRunning(): boolean {
    return this.currentTaskId !== null;
  }

  /**
   * Start (or resume) a task and stream its trace as it happens. The HTTP
   * handler does not await this — the client learns the outcome from the
   * event stream, so a long task never holds a request open.
   */
  async run(prompt: string, resumeTaskId?: string): Promise<TaskOutcome> {
    if (this.isRunning) throw new Error('A task is already running in this project.');

    this.bus.reset();
    this.streamed.clear();
    this.currentTaskId = resumeTaskId ?? 'pending';

    this.agent = await createAgent({
      projectRoot: this.projectRoot,
      keys: this.keys,
      approval: (call, effect) => this.requestApproval(call, effect),
      onProgress: (message) =>
        this.publish({ type: 'log', taskId: this.currentTaskId, level: 'info', message }),
      onRoute: (d) => this.publish({
        type: 'routing',
        update: {
          taskId: this.currentTaskId ?? '',
          providerId: d.providerId, modelId: d.modelId, role: d.role,
          reason: d.reason, runnersUp: d.runnersUp,
          estimatedCostUsd: d.estimatedCostUsd, waitedMs: d.waitedMs,
        },
      }),
    });

    this.startPump();
    try {
      const outcome = await runTask(this.agent, prompt,
        resumeTaskId ? { resumeTaskId } : {});
      this.currentTaskId = outcome.taskId;
      this.flush();
      this.publish({
        type: 'log', taskId: outcome.taskId, level: 'info',
        message:
          `Finished: ${outcome.status}, ${outcome.stepsCompleted}/${outcome.stepsTotal} steps, ` +
          `$${outcome.costUsd.toFixed(5)}, ${(outcome.elapsedMs / 1000).toFixed(1)}s, ` +
          `score@A=1 ${scoreTask(1, outcome.costUsd, outcome.elapsedMs / 1000).toFixed(2)}`,
      });
      return outcome;
    } finally {
      this.stopPump();
      this.flush();
      this.currentTaskId = null;
      // A server the agent started must OUTLIVE the task — the whole point of
      // "run it and give me the port" is that the port still works afterwards.
      // The session keeps the handles and kills them when it closes.
      if (this.agent) this.background.push(...this.agent.background.splice(0));
      this.agent?.db.close();
      this.agent = null;
    }
  }

  /** Called by the approval callback; resolves when the human answers. */
  private requestApproval(call: ToolCall, effect: string): Promise<boolean> {
    const eventId = ++this.approvalCounter;
    const request: ApprovalRequest = {
      taskId: this.currentTaskId ?? '',
      eventId,
      toolName: call.name,
      args: call.args,
      effect,
      // Verbatim, so the UI never has to reconstruct what will run.
      ...(call.name === 'run_command'
        ? { command: String(call.args.command ?? '') } : {}),
      ...(call.name === 'write_file'
        ? { path: String(call.args.path ?? ''), content: String(call.args.content ?? '') } : {}),
    };
    return new Promise((resolve) => {
      this.pending.set(eventId, resolve);
      this.publish({ type: 'approval_request', request });
    });
  }

  /** Called by the HTTP handler when the human answers. */
  resolveApproval(eventId: number, approved: boolean): boolean {
    const resolve = this.pending.get(eventId);
    if (!resolve) return false;
    this.pending.delete(eventId);
    resolve(approved);
    return true;
  }

  close(): void {
    this.stopPump();
    if (this.agent) stopBackground(this.agent);
    for (const child of this.background.splice(0)) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    this.agent?.db.close();
    this.agent = null;
  }

  // -- streaming -------------------------------------------------------------

  private startPump(): void {
    this.stopPump();
    this.pump = setInterval(() => this.flush(), 400);
  }

  private stopPump(): void {
    if (this.pump) { clearInterval(this.pump); this.pump = null; }
  }

  /**
   * Forward newly written events. Reading the store rather than intercepting
   * calls is why live and post-hoc views cannot diverge: they are the same rows.
   */
  private flush(): void {
    const db = this.agent?.db;
    if (!db) return;

    // The task id is unknown until runTask creates the row; find it.
    if (!this.currentTaskId || this.currentTaskId === 'pending') {
      const latest = db.listTasks(this.projectRoot, 1)[0];
      if (!latest) return;
      this.currentTaskId = latest.id;
    }
    const taskId = this.currentTaskId;

    for (const ev of db.getEvents(taskId)) {
      if (this.streamed.has(ev.id)) continue;
      this.streamed.add(ev.id);
      this.publish({ type: 'trace', node: { ...ev, kind: ev.kind, role: ev.role } });
    }

    const steps: StepWire[] = db.getSteps(taskId).map((s) => ({
      id: s.stepId,
      intent: s.spec.intent,
      status: s.status,
      targetFiles: s.spec.targetFiles,
      difficulty: s.spec.difficulty,
      attempts: s.attempts,
    }));
    if (steps.length > 0) this.publish({ type: 'steps', taskId, steps });

    const task = db.getTask(taskId);
    if (task) {
      const totals = db.totals(taskId);
      this.publish({
        type: 'task',
        task: {
          id: task.id, prompt: task.prompt, status: task.status,
          complexity: task.complexity, createdAt: task.createdAt,
          costUsd: totals.costUsd, tokens: totals.tokens,
          elapsedMs: Date.now() - task.createdAt,
        },
      });
    }
  }

  private publish(event: ServerEvent): void {
    this.bus.publish(event);
  }
}
