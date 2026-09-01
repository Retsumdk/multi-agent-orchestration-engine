import { describe, expect, test } from "bun:test";
import { OrchestrationEngine, OrchestrationError } from "../src";
import type { AgentWorker, TaskDef } from "../src";

function workers(...specs: Array<[string, string, number?]>): AgentWorker[] {
  return specs.map(([id, capability, concurrency]) => ({ id, capability, concurrency }));
}

describe("workflow validation", () => {
  test("rejects duplicate tasks", () => {
    const t = (n: string): TaskDef => ({ name: n, capability: "x" });
    expect(() => new OrchestrationEngine([t("a"), t("a")])).toThrow(/Duplicate task/);
  });

  test("rejects unknown dependencies", () => {
    expect(() =>
      new OrchestrationEngine([{ name: "a", capability: "x", dependsOn: ["ghost"] }]),
    ).toThrow(/unknown task/);
  });

  test("rejects dependency cycles", () => {
    expect(() =>
      new OrchestrationEngine([
        { name: "a", capability: "x", dependsOn: ["b"] },
        { name: "b", capability: "x", dependsOn: ["a"] },
      ]),
    ).toThrow(/cycle/);
  });
});

describe("scheduling", () => {
  test("runs tasks in dependency order across workers", async () => {
    const order: string[] = [];
    const engine = new OrchestrationEngine([
      { name: "plan", capability: "think" },
      { name: "draft", capability: "write", dependsOn: ["plan"] },
      { name: "review", capability: "think", dependsOn: ["draft"] },
    ]);

    for (const a of workers(["thinker-1", "think"], ["writer-1", "write"])) {
      engine.registerAgent(a);
    }

    const result = await engine.run((task) => {
      order.push(task.name);
      return `ok:${task.name}`;
    });

    expect(result.status).toBe("completed");
    expect(order.indexOf("draft")).toBeGreaterThan(order.indexOf("plan"));
    expect(order.indexOf("review")).toBeGreaterThan(order.indexOf("draft"));
    expect(result.tasks.review.output).toBe("ok:review");
    expect(result.tasks.draft.assignedTo).toBe("writer-1");
  });

  test("parallel independent tasks use both workers", async () => {
    const engine = new OrchestrationEngine([
      { name: "a", capability: "x" },
      { name: "b", capability: "x" },
    ]);
    engine.registerAgent({ id: "w1", capability: "x" });
    engine.registerAgent({ id: "w2", capability: "x" });

    const result = await engine.run(() => undefined);
    expect(result.status).toBe("completed");
    expect(result.executed.sort()).toEqual(["a", "b"]);
  });

  test("worker failure fails the workflow with the error message", async () => {
    const engine = new OrchestrationEngine([
      { name: "boom", capability: "x" },
    ]);
    engine.registerAgent({ id: "w", capability: "x" });

    const result = await engine.run(() => {
      throw new Error("worker exploded");
    });

    expect(result.status).toBe("failed");
    expect(result.tasks.boom.error).toBe("worker exploded");
  });

  test("unmatched capability leaves workflow incomplete", async () => {
    const engine = new OrchestrationEngine([{ name: "needs-rare", capability: "rare" }]);
    engine.registerAgent({ id: "w", capability: "common" });

    const result = await engine.run(async () => "never called");
    expect(result.status).toBe("incomplete");
    expect(engine.statusOf("needs-rare")).toBe("pending");
  });
});
