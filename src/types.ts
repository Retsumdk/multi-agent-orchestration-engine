/** Public types for the orchestration engine. */

/** Status of a single workflow task. */
export type TaskStatus = "pending" | "ready" | "running" | "done" | "failed";

/** A unit of work in the workflow graph. */
export interface TaskDef {
  /** Unique task name within the workflow. */
  name: string;
  /** Capability tag required from an agent (e.g. "write", "review"). */
  capability: string;
  /** Task names that must complete before this one can run. */
  dependsOn?: string[];
  /** Per-task payload forwarded to the worker. */
  input?: Record<string, unknown>;
}

/** A registered worker able to execute its capability. */
export interface AgentWorker {
  /** Unique worker id. */
  id: string;
  /** Capability this worker can execute. */
  capability: string;
  /** Max concurrent tasks (default 1). */
  concurrency?: number;
}

/** Current state of one scheduled task. */
export interface TaskState {
  name: string;
  status: TaskStatus;
  assignedTo?: string;
  /** Output returned by the worker. */
  output?: unknown;
  /** Error message when failed. */
  error?: string;
}

/** Result of driving the workflow to completion (or an early stop). */
export interface WorkflowResult {
  status: "completed" | "failed" | "incomplete";
  /** Completed task names in execution order. */
  executed: string[];
  tasks: Record<string, TaskState>;
}

/** Thrown for invalid workflow definitions or scheduling errors. */
export class OrchestrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestrationError";
  }
}
