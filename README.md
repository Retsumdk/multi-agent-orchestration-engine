# multi-agent-orchestration-engine

Deterministic DAG scheduler that allocates workflow tasks across a pool of capability-matched workers.

## The Problem

Multi-agent workflows fail in predictable ways: tasks run out of order because nobody
declared their dependencies, a slow worker blocks tasks it was never meant to run, a
worker crash takes down the whole workflow silently, and a typo in a dependency graph
waits until production to surface. Hand-rolled `setTimeout` chains and ad-hoc queues
have no way to express "this task needs a worker that can *write*, after *plan* finishes."

## The Solution

`multi-agent-orchestration-engine` is a small, zero-dependency scheduler you embed in
any TypeScript/JavaScript process. You declare a task graph and a worker pool; the
engine handles the rest:

- **Dependency validation up front.** Unknown dependencies, self-dependencies, and
  cycles throw at construction — before any task runs.
- **Capability-based allocation.** Each task names the capability it needs
  (`write`, `review`, …) and each worker declares what it can do. Tasks only ever
  run on matching workers.
- **Deterministic scheduling.** Every tick assigns all ready tasks to free workers
  (respecting per-worker `concurrency`), then yields. No race conditions, no
  random ordering.
- **Explicit failure semantics.** A worker exception marks its task `failed` and
  stops the workflow with the error message preserved. A workflow whose remaining
  tasks have no capable worker ends `incomplete` — with pending state intact —
  instead of spinning forever.
- **Observable state.** `readyTasks()`, `stateFor()`, and `statusOf()` expose the
  scheduler's decisions, so you can dashboard or debug without patching internals.

It is deliberately not a process manager — it's the scheduling core you wrap with
your own transport (HTTP, message queue, in-process calls).

## How It Works

```
TaskDef[]  ──►  OrchestrationEngine          AgentWorker[]
                ├── validate DAG (cycles, unknown deps)
                ├── readyTasks()             ──►  tasks with deps satisfied
                ├── match by capability      ──►  free worker with that capability
                └── run(workerFn)            ──►  WorkflowResult
```

1. **Construct** the engine with your task graph. The DAG is validated immediately.
2. **Register workers** — `{ id, capability, concurrency? }`.
3. **Call `run(workerFn)`**. The engine loops: assign ready tasks to free,
   capable workers; call your `workerFn(task, agent)`; repeat until every task is
   `done`, one is `failed`, or no progress is possible.
4. **Inspect the result** — execution order, per-task output/errors, and the
   worker that ran each task.

## Getting Started

Requires [Bun](https://bun.sh) 1.0+ (or Node 18+ with `tsx`).

```bash
git clone https://github.com/Retsumdk/multi-agent-orchestration-engine.git
cd multi-agent-orchestration-engine
bun install
bun test          # run the test suite
bun run build     # type-check + emit dist/
```

## Example

```typescript
import { OrchestrationEngine } from "multi-agent-orchestration-engine";

const engine = new OrchestrationEngine([
  { name: "plan",   capability: "think" },
  { name: "draft",  capability: "write", dependsOn: ["plan"] },
  { name: "review", capability: "think", dependsOn: ["draft"] },
]);

engine.registerAgent({ id: "thinker-1", capability: "think" });
engine.registerAgent({ id: "writer-1",  capability: "write"  });

const result = await engine.run(async (task, agent) => {
  console.log(`${agent.id} executing ${task.name}`);
  return `output of ${task.name}`;
});

console.log(result.status);           // "completed"
console.log(result.executed);         // ["plan", "draft", "review"] (or plan/review interleaved by worker count)
console.log(result.tasks.draft.output); // "output of draft"
```

A worker that throws fails the workflow with the message preserved:

```typescript
const result = await engine.run(() => {
  throw new Error("worker exploded");
});

result.status;                    // "failed"
result.tasks.plan.error;          // "worker exploded"
```

## API

### `new OrchestrationEngine(tasks: TaskDef[])`

Constructs and validates the workflow graph. Throws `OrchestrationError` for
duplicate task names, unknown `dependsOn` entries, self-dependencies, or cycles.

### `engine.registerAgent(agent: AgentWorker): this`

Adds a worker. `capability` must match a task's capability for it to ever run;
`concurrency` (default `1`) bounds how many tasks one worker runs at once.

### `engine.readyTasks(): string[]`

Names of pending tasks whose dependencies are all `done`.

### `engine.run(worker: (task: TaskDef, agent: AgentWorker) => unknown, maxSteps = 1000): Promise<WorkflowResult>`

Drives the workflow to completion. `workerFn` executes one task on one matched
agent; whatever it returns becomes `task.output`. Resolves with:

| Field | Description |
| --- | --- |
| `status` | `"completed"`, `"failed"`, or `"incomplete"` |
| `executed` | Completed task names in execution order |
| `tasks` | Map of task name → `{ status, assignedTo?, output?, error? }` |

### `engine.stateFor(name)` / `engine.statusOf(name)`

Inspect a single task's current state or status.

## Development

```bash
bun install
bun test            # 8 tests across validation + scheduling
bun run typecheck   # tsc --noEmit
bun run build       # emits dist/ with .d.ts
```

## License

MIT — see [LICENSE](LICENSE).

---

Built by [Retsumdk](https://github.com/Retsumdk)
