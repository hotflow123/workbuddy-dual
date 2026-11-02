import path from "node:path";
import { fail, ok, type AppError, type OperationPlan, type OperationResult, type ProductId, type Result } from "./contracts";
import { canTransition, createRecord, markStep, recordFailure, transition, type JournalStore } from "./journal";
import { PathGuard, toCompareKey } from "./pathGuard";

/**
 * 受管文件事务：暂存 → 校验 → 提交，任何失败都回滚到上一可用版本。
 * 关键安全约束：
 *  - 每个目标路径都必须通过 PathGuard；
 *  - replace 之前必须存在同目标的 backup 步骤（绝不“先删旧版再试装新版”）；
 *  - delete 只允许出现在 plan.deletionTargets 中，且必须位于管理根目录之内；
 *  - 事务可重入：同一 operationId 重复执行不会造成数据丢失。
 */

export interface FsPort {
  ensureDir(target: string): Promise<void>;
  exists(target: string): Promise<boolean>;
  copyTree(from: string, to: string): Promise<void>;
  /** 复制单个文件（用于保留旧目录里的卸载器等维护文件） */
  copyFile(from: string, to: string): Promise<void>;
  removeTree(target: string): Promise<void>;
  /** 同卷目录重命名（原子替换目录时使用）；跨卷会抛错，由调用方转成明确错误 */
  rename(from: string, to: string): Promise<void>;
  writeFile(target: string, data: string): Promise<void>;
  readText(target: string): Promise<string | null>;
  freeBytes(target: string): Promise<number>;
  isReparsePoint(target: string): Promise<boolean>;
}

export interface TransactionDeps {
  journal: JournalStore;
  guard: PathGuard;
  fs: FsPort;
  now: () => string;
  /** 提交前的产品身份复验（安装/更新后必须提供） */
  verifyInstalled?: (directory: string, product: ProductId) => Promise<{ ok: boolean; reason?: string }>;
}

function backupPathFor(backupDirectory: string, index: number, target: string): string {
  return path.join(backupDirectory, `${String(index).padStart(2, "0")}-${path.basename(target)}`);
}

export class FileTransaction {
  constructor(private readonly deps: TransactionDeps) {}

  private async validatePlan(plan: OperationPlan): Promise<Result<true>> {
    if (plan.blockers.length > 0) {
      return fail("E_CAPABILITY_BLOCKED", "计划存在阻断项，禁止执行", { blockers: plan.blockers });
    }
    const deletionKeys = new Set(plan.deletionTargets.map(toCompareKey));
    for (const step of plan.steps) {
      if (step.action === "read" || step.action === "launch") continue;
      const checked = this.deps.guard.check(step.target);
      if (!checked.ok) {
        return fail("E_PATH_REJECTED", `步骤 ${step.index} 目标被拒绝：${checked.error.message}`, { target: step.target });
      }
      if (step.source) {
        const sourceCheck = this.deps.guard.check(step.source);
        if (!sourceCheck.ok) {
          return fail("E_PATH_REJECTED", `步骤 ${step.index} 来源被拒绝：${sourceCheck.error.message}`);
        }
      }
      if (step.action === "delete" && !deletionKeys.has(toCompareKey(step.target))) {
        return fail("E_VALIDATION", "删除步骤未登记在 deletionTargets 中，已拒绝执行");
      }
      if (step.action === "replace") {
        const hasBackup = plan.steps.some((s) => s.action === "backup" && toCompareKey(s.target) === toCompareKey(step.target));
        if (!hasBackup) {
          return fail("E_VALIDATION", "replace 步骤缺少同目标的 backup 步骤，拒绝覆盖旧版本", { target: step.target });
        }
      }
    }
    for (const target of plan.deletionTargets) {
      const checked = this.deps.guard.check(target);
      if (!checked.ok) return fail("E_PATH_REJECTED", "删除目标被路径守卫拒绝", { target });
    }
    return ok(true);
  }

  async apply(plan: OperationPlan, signal: AbortSignal): Promise<Result<OperationResult>> {
    const validation = await this.validatePlan(plan);
    if (!validation.ok) return validation;

    const existing = await this.deps.journal.read(plan.operationId);
    if (existing) {
      if (existing.state === "committed") {
        return ok({
          operationId: plan.operationId,
          state: "committed",
          completedSteps: existing.steps.length,
          failure: null,
          notes: ["该操作已提交，重复执行已忽略（幂等）"],
        });
      }
      if (existing.state !== "planned" && existing.state !== "failed" && existing.state !== "rolled-back") {
        return fail("E_JOURNAL_CORRUPT", "已存在未完成的操作记录，请先回滚或恢复", { state: existing.state });
      }
    }

    // 空间检查必须针对**目标所在卷**：用户可以把程序装到任意盘符
    const spaceTarget = plan.steps.find((step) => step.action === "create" || step.action === "replace")?.target
      ?? this.deps.guard.managementRoot;
    let spaceProbe = spaceTarget;
    for (;;) {
      if (await this.deps.fs.exists(spaceProbe)) break;
      const parent = path.dirname(spaceProbe);
      if (parent === spaceProbe) break;
      spaceProbe = parent;
    }
    const free = await this.deps.fs.freeBytes(spaceProbe);
    if (free < plan.requiredFreeSpaceBytes) {
      return fail("E_SPACE", "磁盘剩余空间不足", { free, required: plan.requiredFreeSpaceBytes });
    }

    let record = createRecord({
      operationId: plan.operationId,
      kind: plan.kind,
      product: plan.product,
      version: plan.version,
      planPath: "",
      steps: plan.steps,
      now: this.deps.now(),
    });
    await this.deps.journal.write(record);

    const backups = new Map<string, string>();
    let completed = 0;

    try {
      for (const step of plan.steps) {
        if (signal.aborted) throw new AbortCancelled();
        switch (step.action) {
          case "read":
            break;
          case "launch":
            record = { ...record, notes: [...record.notes, `launch 步骤由启动器单独执行：${step.target}`] };
            break;
          case "backup": {
            const target = step.target;
            if (await this.deps.fs.exists(target)) {
              const backup = backupPathFor(plan.backupDirectory ?? path.join(this.deps.guard.managementRoot, "backups"), step.index, target);
              await this.deps.fs.ensureDir(path.dirname(backup));
              await this.deps.fs.copyTree(target, backup);
              backups.set(toCompareKey(target), backup);
              record = markStep(record, step.index, "done", this.deps.now(), backup);
            } else {
              record = markStep(record, step.index, "done", this.deps.now(), "目标不存在，跳过备份");
            }
            break;
          }
          case "create":
          case "replace": {
            if (!step.source) throw new ValidationFailure("复制步骤缺少来源");
            if (await this.deps.fs.isReparsePoint(step.target)) {
              throw new ValidationFailure("目标为重解析点，拒绝写入");
            }
            await this.deps.fs.ensureDir(path.dirname(step.target));
            if (await this.deps.fs.exists(step.target)) {
              if (step.action === "create") {
                throw new ValidationFailure("目标已存在，create 步骤拒绝覆盖");
              }
              await this.deps.fs.removeTree(step.target);
            }
            await this.deps.fs.copyTree(step.source, step.target);
            record = markStep(record, step.index, "done", this.deps.now(), null);
            break;
          }
          case "delete": {
            if (await this.deps.fs.exists(step.target)) {
              await this.deps.fs.removeTree(step.target);
            }
            record = markStep(record, step.index, "done", this.deps.now(), null);
            break;
          }
          case "verify": {
            if (this.deps.verifyInstalled) {
              const verified = await this.deps.verifyInstalled(step.target, plan.product);
              if (!verified.ok) throw new ValidationFailure(verified.reason ?? "产品身份复验失败");
            }
            record = markStep(record, step.index, "done", this.deps.now(), null);
            break;
          }
          case "restore":
            break;
          default:
            throw new ValidationFailure(`未知步骤类型`);
        }
        completed += 1;
        if (record.state === "planned" && step.action !== "read" && step.action !== "launch") {
          record = transition(record, "staged", this.deps.now());
        }
        await this.deps.journal.write(record);
      }

      if (canTransition(record.state, "verified")) {
        record = transition(record, "verified", this.deps.now());
      }
      record = transition(record, "committed", this.deps.now());
      await this.deps.journal.write(record);
      return ok({ operationId: plan.operationId, state: "committed", completedSteps: completed, failure: null, notes: record.notes });
    } catch (error) {
      const appError: AppError =
        error instanceof AbortCancelled
          ? { code: "E_CANCELLED", message: "操作已被用户取消" }
          : error instanceof ValidationFailure
            ? { code: "E_VALIDATION", message: error.message }
            : { code: "E_IO", message: error instanceof Error ? error.message : "未知写入错误" };
      record = recordFailure(record, appError, this.deps.now());
      if (record.state === "planned") record = transition(record, "failed", this.deps.now());
      else if (record.state === "staged" || record.state === "verified") record = transition(record, "failed", this.deps.now());
      await this.deps.journal.write(record);
      const rolled = await this.rollback(plan.operationId);
      return fail(appError.code, appError.message, {
        rolledBack: rolled.ok ? rolled.value.state : "rollback-failed",
        completedSteps: completed,
      });
    }
  }

  async rollback(operationId: string): Promise<Result<OperationResult>> {
    const record = await this.deps.journal.read(operationId);
    if (!record) return fail("E_NOT_FOUND", "未找到操作记录", { operationId });
    if (record.state === "rolled-back") {
      return ok({ operationId, state: "rolled-back", completedSteps: 0, failure: null, notes: ["已经回滚，重复回滚已忽略"] });
    }
    if (!canTransition(record.state, "rolled-back")) {
      return fail("E_JOURNAL_CORRUPT", "当前状态不允许回滚", { state: record.state });
    }

    const notes: string[] = [];
    for (const step of [...record.steps].reverse()) {
      if (step.state !== "done") continue;
      if (step.action === "backup" && step.detail && step.detail !== "目标不存在，跳过备份") {
        const backup = step.detail;
        if (await this.deps.fs.exists(backup)) {
          const checked = this.deps.guard.check(step.target);
          if (!checked.ok) return fail("E_ROLLBACK_FAILED", "回滚目标被路径守卫拒绝", { target: step.target });
          if (await this.deps.fs.exists(step.target)) await this.deps.fs.removeTree(step.target);
          await this.deps.fs.ensureDir(path.dirname(step.target));
          await this.deps.fs.copyTree(backup, step.target);
          notes.push(`已从备份恢复：${step.target}`);
        } else if (await this.deps.fs.exists(step.target)) {
          notes.push(`备份已不存在但目标存在，视为已恢复：${step.target}`);
        } else {
          return fail("E_ROLLBACK_FAILED", "备份与目标均缺失，需要人工介入", { target: step.target, backup });
        }
      } else if (step.action === "create") {
        const checked = this.deps.guard.check(step.target);
        if (!checked.ok) return fail("E_ROLLBACK_FAILED", "回滚目标被路径守卫拒绝", { target: step.target });
        if (await this.deps.fs.exists(step.target)) {
          await this.deps.fs.removeTree(step.target);
          notes.push(`已移除本次创建的目标：${step.target}`);
        }
      }
    }

    const rolled = transition(record, "rolled-back", this.deps.now());
    await this.deps.journal.write({ ...rolled, notes: [...rolled.notes, ...notes] });
    return ok({ operationId, state: "rolled-back", completedSteps: notes.length, failure: null, notes });
  }
}

class ValidationFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationFailure";
  }
}

class AbortCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "AbortCancelled";
  }
}
