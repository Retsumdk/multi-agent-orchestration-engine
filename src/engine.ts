/**
 * multi-agent-orchestration-engine — a deterministic DAG scheduler that
 * allocates workflow tasks across a pool of capability-matched workers.
 */

import { OrchestrationError } from "./types";
import type { TaskDef, TaskState, TaskStatus, WorkflowResult, AgentWorker } from "./types";

export type WorkerFn = (task: TaskDef, agent: AgentWorker) => unknown | Promise<unknown>;

interface WorkerSlot {
  agent: AgentWorker;
  busy: number;
}

export class OrchestrationEngine {
  private readonly tasks = new Map<string, TaskDef>();
  private readonly state = new Map<string, TaskState>();
  private readonly slots: WorkerSlot[] = [];

  constructor(tasks: TaskDef[]) {
    for (const t of tasks) {
      if (!t.name.trim()) throw new OrchestrationError("Task name cannot be empty");
      if (this.tasks.has(t.name)) throw new OrchestrationError(`Duplicate task: ${t.name}`);
      this.tasks.set(t.name, t);
      this.state.set(t.name, { name: t.name, status: "pending" });
    }
    this.validateDeps();
    this.detectCycles();
  }

  /** Registers a worker able to execute its capability. */
  registerAgent(agent: AgentWorker): this {
    this.slots.push({ agent, busy: 0 });
    return this;
  }

  /** Tasks whose dependencies are all done and which have not started. */
  readyTasks(): string[] {
    return [...this.tasks.values()]
      .filter((t) => {
        const s = this.state.get(t.name)!;
        if (s.status !== "pending") return false;
        return (t.dependsOn ?? []).every((d) => this.state.get(d)?.status === "done");
      })
      .map((t) => t.name);
  }

  /**
   * Drives the workflow until every task is done, a task fails, or the step
   * budget is exhausted. `worker` executes one task on one matched agent.
   */
  async run(worker: WorkerFn, maxSteps = 1000): Promise<WorkflowResult> {
    let steps = 0;
    const executed: string[] = [];

    while (true) {
      const failed = [...this.state.values()].find((s) => s.status === "failed");
      if (failed) return this.finish("failed", executed);

      const allDone = [...this.state.values()].every((s) => s.status === "done");
      if (allDone) return this.finish("completed", executed);

      if (steps++ >= maxSteps) return this.finish("incomplete", executed);

      // Assign every ready task that has a free, capable worker.
      let assigned = 0;
      for (const name of this.readyTasks()) {
        const task = this.tasks.get(name)!;
        const slot = this.slots.find(
          (s) => s.agent.capability === task.capability && s.busy < (s.agent.concurrency ?? 1),
        );
        if (!slot) continue;
        slot.busy += 1;
        this.state.set(name, { name, status: "running", assignedTo: slot.agent.id });
        assigned += 1;
        void this.execute(task, slot, worker, executed);
      }

      if (assigned === 0) {
        // Nothing was scheduled this pass. If work is still in flight, yield
        // and retry; otherwise the remaining tasks can never run (e.g. no
        // worker has the capability) - deadlock, not a spin.
        const stillRunning = [...this.state.values()].some((s) => s.status === "running");
        if (!stillRunning) return this.finish("incomplete", executed);
      }

      // Yield so in-flight tasks (all scheduled synchronously above) settle.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  stateFor(name: string): TaskState | undefined {
    return this.state.get(name);
  }

  statusOf(name: string): TaskStatus {
    return this.state.get(name)?.status ?? "pending";
  }

  private async execute(
    task: TaskDef,
    slot: WorkerSlot,
    worker: WorkerFn,
    executed: string[],
  ): Promise<void> {
    try {
      const output = await worker(task, slot.agent);
      this.state.set(task.name, {
        name: task.name,
        status: "done",
        assignedTo: slot.agent.id,
        output,
      });
      executed.push(task.name);
    } catch (err) {
      this.state.set(task.name, {
        name: task.name,
        status: "failed",
        assignedTo: slot.agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      slot.busy -= 1;
    }
  }

  private finish(status: WorkflowResult["status"], executed: string[]): WorkflowResult {
    const tasks: Record<string, TaskState> = {};
    for (const [name, s] of this.state) tasks[name] = s;
    return { status, executed: [...executed], tasks };
  }

  private validateDeps(): void {
    for (const t of this.tasks.values()) {
      for (const d of t.dependsOn ?? []) {
        if (!this.tasks.has(d)) {
          throw new OrchestrationError(`Task \"${t.name}\" depends on unknown task \"${d}\"`);
        }
        if (d === t.name) {
          throw new OrchestrationError(`Task \"${t.name}\" cannot depend on itself`);
        }
      }
    }
  }

  private detectCycles(): void {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string): void => {
      if (done.has(name)) return;
      if (visiting.has(name)) throw new OrchestrationError(`Dependency cycle involving \"${name}\"`);
      visiting.add(name);
      for (const d of this.tasks.get(name)!.dependsOn ?? []) visit(d);
      visiting.delete(name);
      done.add(name);
    };
    for (const name of this.tasks.keys()) visit(name);
  }
}
