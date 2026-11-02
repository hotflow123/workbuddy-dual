import { describe, expect, it } from "vitest";
import { adviseRecovery, canTransition, createRecord, IllegalTransitionError, transition } from "../../src/core/journal";

const steps = [
  { index: 1, action: "create" as const, target: "C:\\m\\a", source: "C:\\s", reason: "x", reversible: true },
];

function record() {
  return createRecord({
    operationId: "op-1",
    kind: "install",
    product: "workbuddy-cn",
    version: "5.8.3",
    planPath: "",
    steps,
    now: "2026-10-01T00:00:00.000Z",
  });
}

describe("操作状态机", () => {
  it("允许 planned → staged → verified → committed", () => {
    let current = record();
    current = transition(current, "staged", "t1");
    current = transition(current, "verified", "t2");
    current = transition(current, "committed", "t3");
    expect(current.state).toBe("committed");
  });

  it("禁止 committed → staged 之类回退", () => {
    let current = transition(record(), "staged", "t1");
    current = transition(current, "verified", "t2");
    current = transition(current, "committed", "t3");
    expect(canTransition(current.state, "staged")).toBe(false);
    expect(() => transition(current, "staged", "t4")).toThrow(IllegalTransitionError);
  });

  it("rolled-back 是终态", () => {
    let current = transition(record(), "staged", "t1");
    current = transition(current, "rolled-back", "t2");
    expect(canTransition(current.state, "committed")).toBe(false);
  });

  it("崩溃中断只允许继续验证或回滚", () => {
    expect(canTransition("interrupted", "verified")).toBe(true);
    expect(canTransition("interrupted", "rolled-back")).toBe(true);
    expect(canTransition("interrupted", "committed")).toBe(false);
    expect(canTransition("interrupted", "planned")).toBe(false);
  });

  it("恢复建议不包含任何自动删除动作", () => {
    const advice = adviseRecovery({ ...record(), state: "interrupted" });
    expect(advice.action).toBe("rollback");
    expect(["verify", "rollback", "none", "manual"]).toContain(advice.action);
  });
});
