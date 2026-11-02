import { afterEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { FileTransaction } from "../../src/core/transaction";
import { FileJournalStore } from "../../src/main/adapters/journalFile";
import { NodeFsPort } from "../../src/main/adapters/fsPort";
import { PathGuard } from "../../src/core/pathGuard";
import type { OperationPlan, PlannedStep } from "../../src/core/contracts";
import { createRecord, markStep } from "../../src/core/journal";
import { exists, makeTempRoot, writeTree } from "../helpers/fixtures";

const tempRoots: string[] = [];

async function setup() {
  const root = await makeTempRoot();
  tempRoots.push(root);
  const managementRoot = path.join(root, "managed");
  const staging = path.join(managementRoot, ".staging", "op1", "WorkBuddy-CN");
  await writeTree(staging, { "product.json": JSON.stringify({ applicationName: "WorkBuddy", version: "5.8.3" }) });
  const journal = new FileJournalStore(path.join(root, "state", "operations"));
  return { root, managementRoot, staging, journal, fs: new NodeFsPort() };
}

function makePlan(managementRoot: string, staging: string, overrides: Partial<OperationPlan> = {}): OperationPlan {
  const target = path.join(managementRoot, "WorkBuddy-CN", "versions", "5.8.3");
  const steps: PlannedStep[] = [
    { index: 1, action: "backup", target, source: null, reason: "备份旧版本", reversible: true },
    { index: 2, action: "create", target, source: staging, reason: "复制暂存文件", reversible: true },
    { index: 3, action: "verify", target, source: null, reason: "身份复验", reversible: false },
  ];
  return {
    operationId: "op-install-test",
    kind: "install",
    product: "workbuddy-cn",
    createdAt: new Date().toISOString(),
    expectedProduct: "workbuddy-cn",
    source: { kind: "local-file", path: "C:\\pkg\\setup.exe" },
    version: "5.8.3",
    signerSubject: "CN=Tencent",
    sha256: "a".repeat(64),
    requiredFreeSpaceBytes: 1024,
    backupDirectory: path.join(managementRoot, "WorkBuddy-CN", "backups"),
    steps,
    rollbackSteps: [],
    deletionTargets: [],
    blockers: [],
    notes: [],
    ...overrides,
  };
}

function makeTransaction(ctx: Awaited<ReturnType<typeof setup>>, verify: () => Promise<{ ok: boolean; reason?: string }>) {
  return new FileTransaction({
    journal: ctx.journal,
    guard: new PathGuard({ managementRoot: ctx.managementRoot }),
    fs: ctx.fs,
    now: () => new Date().toISOString(),
    verifyInstalled: verify,
  });
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe("FileTransaction", () => {
  it("成功提交：暂存 → 校验 → committed，目标目录存在", async () => {
    const ctx = await setup();
    const transaction = makeTransaction(ctx, async () => ({ ok: true }));
    const result = await transaction.apply(makePlan(ctx.managementRoot, ctx.staging), new AbortController().signal);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.state).toBe("committed");
    expect(await exists(path.join(ctx.managementRoot, "WorkBuddy-CN", "versions", "5.8.3", "product.json"))).toBe(true);
    const record = await ctx.journal.read("op-install-test");
    expect(record?.state).toBe("committed");
  });

  it("身份复验失败时回滚并删除本次创建的目录", async () => {
    const ctx = await setup();
    const transaction = makeTransaction(ctx, async () => ({ ok: false, reason: "身份不符" }));
    const result = await transaction.apply(makePlan(ctx.managementRoot, ctx.staging), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(await exists(path.join(ctx.managementRoot, "WorkBuddy-CN", "versions", "5.8.3"))).toBe(false);
    const record = await ctx.journal.read("op-install-test");
    expect(record?.state).toBe("rolled-back");
  });

  it("replace 缺少同目标 backup 步骤时拒绝覆盖旧版本", async () => {
    const ctx = await setup();
    const plan = makePlan(ctx.managementRoot, ctx.staging);
    plan.steps = plan.steps.filter((s) => s.action !== "backup");
    plan.steps[0] = { ...plan.steps[0]!, action: "replace" };
    const transaction = makeTransaction(ctx, async () => ({ ok: true }));
    const result = await transaction.apply(plan, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("backup");
  });

  it("删除步骤未登记在 deletionTargets 时拒绝执行", async () => {
    const ctx = await setup();
    const target = path.join(ctx.managementRoot, "WorkBuddy-CN", "versions", "5.8.3");
    const plan = makePlan(ctx.managementRoot, ctx.staging, {
      kind: "uninstall",
      steps: [{ index: 1, action: "delete", target, source: null, reason: "删除", reversible: true }],
      deletionTargets: [],
    });
    const transaction = makeTransaction(ctx, async () => ({ ok: true }));
    const result = await transaction.apply(plan, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_VALIDATION");
  });

  it("目标路径在管理根之外时拒绝", async () => {
    const ctx = await setup();
    const plan = makePlan(ctx.managementRoot, ctx.staging);
    plan.steps = [{ index: 1, action: "create", target: "C:\\Windows\\System32\\evil", source: ctx.staging, reason: "x", reversible: false }];
    const transaction = makeTransaction(ctx, async () => ({ ok: true }));
    const result = await transaction.apply(plan, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_PATH_REJECTED");
  });

  it("磁盘空间不足时在写入前失败", async () => {
    const ctx = await setup();
    const limitedFs = Object.assign(Object.create(ctx.fs) as NodeFsPort, { freeBytes: async () => 10 });
    const transaction = new FileTransaction({
      journal: ctx.journal,
      guard: new PathGuard({ managementRoot: ctx.managementRoot }),
      fs: limitedFs,
      now: () => new Date().toISOString(),
    });
    const result = await transaction.apply(makePlan(ctx.managementRoot, ctx.staging), new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_SPACE");
  });

  it("取消后不留下半成品", async () => {
    const ctx = await setup();
    const transaction = makeTransaction(ctx, async () => ({ ok: true }));
    const controller = new AbortController();
    controller.abort();
    const result = await transaction.apply(makePlan(ctx.managementRoot, ctx.staging), controller.signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_CANCELLED");
    expect(await exists(path.join(ctx.managementRoot, "WorkBuddy-CN", "versions", "5.8.3"))).toBe(false);
  });

  it("同一操作重复执行是幂等的", async () => {
    const ctx = await setup();
    const transaction = makeTransaction(ctx, async () => ({ ok: true }));
    const plan = makePlan(ctx.managementRoot, ctx.staging);
    const first = await transaction.apply(plan, new AbortController().signal);
    const second = await transaction.apply(plan, new AbortController().signal);
    expect(first.ok && second.ok).toBe(true);
    if (second.ok) expect(second.value.notes.join()).toContain("重复执行已忽略");
  });

  it("崩溃后只允许回滚，回滚会清理已创建目录", async () => {
    const ctx = await setup();
    const plan = makePlan(ctx.managementRoot, ctx.staging);
    const target = path.join(ctx.managementRoot, "WorkBuddy-CN", "versions", "5.8.3");
    await writeTree(target, { "product.json": "{}" });

    let record = createRecord({
      operationId: "op-crash",
      kind: "install",
      product: "workbuddy-cn",
      version: "5.8.3",
      planPath: "",
      steps: plan.steps,
      now: new Date().toISOString(),
    });
    record = { ...record, state: "staged" };
    record = markStep(record, 2, "done", new Date().toISOString());
    await ctx.journal.write(record);

    const transaction = makeTransaction(ctx, async () => ({ ok: true }));
    const result = await transaction.rollback("op-crash");
    expect(result.ok).toBe(true);
    expect(await exists(target)).toBe(false);
    expect((await ctx.journal.read("op-crash"))?.state).toBe("rolled-back");
  });

  it("回滚可重复执行（回滚中再次崩溃也安全）", async () => {
    const ctx = await setup();
    const plan = makePlan(ctx.managementRoot, ctx.staging);
    let record = createRecord({
      operationId: "op-twice",
      kind: "install",
      product: "workbuddy-cn",
      version: "5.8.3",
      planPath: "",
      steps: plan.steps,
      now: new Date().toISOString(),
    });
    record = { ...record, state: "staged" };
    await ctx.journal.write(record);
    const transaction = makeTransaction(ctx, async () => ({ ok: true }));
    const first = await transaction.rollback("op-twice");
    const second = await transaction.rollback("op-twice");
    expect(first.ok && second.ok).toBe(true);
    if (second.ok) expect(second.value.notes.join()).toContain("已经回滚");
  });

  it("计划存在阻断项时拒绝执行", async () => {
    const ctx = await setup();
    const transaction = makeTransaction(ctx, async () => ({ ok: true }));
    const plan = makePlan(ctx.managementRoot, ctx.staging, { blockers: ["官方安装器未验证"] });
    const result = await transaction.apply(plan, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_CAPABILITY_BLOCKED");
  });
});
