import type { AppError, OperationKind, OperationRecord, OperationState, PlannedStep, ProductId } from "./contracts";

/**
 * 可恢复操作日志。状态只能沿白名单前进；崩溃重启后只允许“继续验证”或“回滚”，
 * 绝不允许根据猜测的状态删除文件。
 */

const ALLOWED: Record<OperationState, OperationState[]> = {
  planned: ["staged", "failed", "interrupted"],
  staged: ["verified", "failed", "interrupted", "rolled-back"],
  verified: ["committed", "failed", "interrupted", "rolled-back"],
  committed: ["rolled-back"],
  failed: ["rolled-back"],
  interrupted: ["verified", "rolled-back", "failed"],
  "rolled-back": [],
};

export class IllegalTransitionError extends Error {
  constructor(from: OperationState, to: OperationState) {
    super(`非法的操作状态迁移：${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: OperationState, to: OperationState): boolean {
  return ALLOWED[from].includes(to);
}

export function transition(record: OperationRecord, to: OperationState, now: string): OperationRecord {
  if (!canTransition(record.state, to)) throw new IllegalTransitionError(record.state, to);
  return { ...record, state: to, updatedAt: now };
}

export interface JournalStore {
  read(operationId: string): Promise<OperationRecord | null>;
  write(record: OperationRecord): Promise<void>;
  list(): Promise<OperationRecord[]>;
}

export function createRecord(input: {
  operationId: string;
  kind: OperationKind;
  product: ProductId;
  version: string;
  planPath: string;
  steps: PlannedStep[];
  now: string;
}): OperationRecord {
  return {
    operationId: input.operationId,
    kind: input.kind,
    product: input.product,
    version: input.version,
    state: "planned",
    createdAt: input.now,
    updatedAt: input.now,
    planPath: input.planPath,
    steps: input.steps.map((s) => ({
      index: s.index,
      action: s.action,
      target: s.target,
      state: "pending",
      at: null,
      detail: null,
    })),
    notes: [],
    failure: null,
  };
}

export function markStep(
  record: OperationRecord,
  index: number,
  state: "done" | "failed",
  now: string,
  detail: string | null = null,
): OperationRecord {
  return {
    ...record,
    updatedAt: now,
    steps: record.steps.map((s) => (s.index === index ? { ...s, state, at: now, detail } : s)),
  };
}

export function recordFailure(record: OperationRecord, error: AppError, now: string): OperationRecord {
  return { ...record, failure: error, updatedAt: now };
}

/**
 * 启动时的恢复建议：只返回“允许的动作”，不自动执行任何删除。
 */
export type RecoveryAdvice =
  | { action: "none"; reason: string }
  | { action: "verify"; reason: string }
  | { action: "rollback"; reason: string }
  | { action: "manual"; reason: string };

export function adviseRecovery(record: OperationRecord): RecoveryAdvice {
  switch (record.state) {
    case "planned":
      return { action: "rollback", reason: "操作已记录但未开始写入，建议清理暂存目录并回滚" };
    case "staged":
      return { action: "rollback", reason: "文件已暂存但未提交，建议回滚到上一可用版本" };
    case "verified":
      return { action: "verify", reason: "文件已校验但未提交，可继续验证或回滚" };
    case "interrupted":
      return { action: "rollback", reason: "上次运行中断，只能继续验证或回滚，不允许猜测状态删除文件" };
    case "committed":
      return { action: "none", reason: "操作已完成" };
    case "failed":
      return { action: "rollback", reason: "操作失败，建议回滚" };
    case "rolled-back":
      return { action: "none", reason: "已回滚" };
    default:
      return { action: "manual", reason: "未知状态，需人工检查日志" };
  }
}
