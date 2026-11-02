import { createHash } from "node:crypto";
import { isDriveRoot } from "./pathGuard";
import type {
  InstallRecord,
  OperationRecord,
  ProductId,
  ScanReport,
} from "./contracts";

/**
 * 脱敏诊断：用于排障，但绝不包含用户名、完整个人路径、原始命令行或凭据。
 *
 * 做法：
 *  - 路径一律不出原文，改为「盘符 + 层级 + 末级目录名 + 短哈希」，既能区分副本又不暴露个人目录；
 *  - 卸载命令、安装参数等原始命令行整体丢弃，只保留“是否存在”；
 *  - 跳过项与冲突按类别聚合，原因文本中的绝对路径替换为 <path>；
 *  - 输出前再做一次凭据模式清洗（Bearer / token= / password= / cookie=）。
 */

/** 诊断 schema 版本：4 起不再输出 availability/assisted/scan.readOnly */
export const DIAGNOSTICS_SCHEMA_VERSION = 4;

export interface MaskedPath {
  drive: string;
  depth: number;
  leaf: string;
  hash: string;
}

export interface ScanStatus {
  status: "ok" | "failed";
  startedAt: string;
  scannedAt: string | null;
  durationMs: number;
  /** 扫描失败时的错误码与脱敏原因 */
  failure: { code: string; message: string } | null;
}

export interface ManagedInstanceDiagnostic {
  instanceId: string;
  product: ProductId;
  version: string;
  active: boolean;
  origin: string;
  registeredAt: string;
  directory: string;
  executableRelativePath: string | null;
  executablePresent: boolean;
}

export type ScanToManagedStatus =
  | "matched"
  | "discovered-not-managed"
  | "managed-not-found-on-disk"
  | "identity-conflict";

export interface ScanToManagedEntry {
  status: ScanToManagedStatus;
  product: ProductId | null;
  version: string | null;
  instanceId: string | null;
  path: MaskedPath | null;
  note: string | null;
}

/** 错误日志记录的最小结构（避免 core 依赖 main） */
export interface DiagnosticErrorRecord {
  at: string;
  operation: string;
  product: ProductId | null;
  instanceId: string | null;
  stage: string;
  code: string;
  message: string;
  rolledBack: boolean;
}

export interface LastOperation {
  source: "journal" | "error-log";
  kind: string;
  product: ProductId | null;
  state: string;
  stage: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  timestamp: string;
  rolledBack: boolean | null;
  operationId: string | null;
}

export interface HistoryStatus {
  state: "ok" | "no-history" | "journal-unreadable" | "error-log-unreadable" | "registry-unreadable";
  journalReadable: boolean;
  journalTotal: number;
  errorLogReadable: boolean;
  errorLogTotal: number;
  errorLogCorrupted: number;
  notes: string[];
}

export interface DiagnosticsInput {
  generatedAt: string;
  /** 本次导出开始时间；scan.scannedAt 不应早于它（除非扫描失败） */
  exportStartedAt: string;
  appVersion: string;
  /** 构建标识：用于确认导出诊断的就是当前运行的构建 */
  buildId: string;
  buildTime: string;
  packaged: boolean;
  platform: string;
  portable: boolean;
  /** 由当前代码实现推导的部署能力（不再读旧证据配置） */
  deployment: {
    install: boolean;
    update: boolean;
    uninstall: boolean;
    builtInUpdateControl: boolean;
  };
  scan: ScanReport | null;
  scanStatus: ScanStatus;
  managedInstances: ManagedInstanceDiagnostic[];
  scanToManaged: ScanToManagedEntry[];
  /** 事务 journal，已按时间倒序、最多 20 条 */
  recentOperations: OperationRecord[];
  /** 错误日志，已按时间倒序、最多 20 条 */
  recentErrors: DiagnosticErrorRecord[];
  history: HistoryStatus;
  /** 实例登记来源：file=instances.json；memory=文件不可读后的回退 */
  instanceRegistry: { source: "file" | "memory"; readable: boolean; count: number };
  errorLogDirectory: string | null;
  settings: { managementRoot: string; userScanRoots: string[] };
}

// 注意：不能吃掉 JSON 的引号/逗号/括号，否则整段 JSON 会变成非法字符串
// 至少要有一个字符：避免把脱敏后的盘符 "C:////" 再清洗成 <path>
const ABSOLUTE_PATH_PATTERN = /[A-Za-z]:\\[^\s"'，；、）),}\]]+/g;
const SECRET_LINE_PATTERN = /(bearer\s+[a-z0-9._-]{8,}|(token|password|passwd|pwd|secret|cookie|authorization)\s*[=:]\s*\S+)/gi;

export function maskPath(target: string | null): MaskedPath | null {
  if (!target) return null;
  const normalized = target.replace(/[\\/]+$/, "");
  const driveMatch = /^([A-Za-z]:)/.exec(normalized);
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  const leaf = segments.length > 0 ? segments[segments.length - 1]! : "";
  return {
    drive: driveMatch ? `${driveMatch[1]!.toUpperCase()}\\` : "<unc>",
    depth: segments.length,
    leaf,
    hash: createHash("sha256").update(normalized.toLowerCase()).digest("hex").slice(0, 12),
  };
}

export function sanitizeText(text: string): string {
  return text
    .replace(ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(SECRET_LINE_PATTERN, "<redacted>");
}

function categoryOf(reason: string): string {
  const value = reason.toLowerCase();
  if (value.includes("eperm") || value.includes("eacces") || value.includes("拒绝访问") || value.includes("不可读")) {
    return "access-denied";
  }
  if (value.includes("不存在") || value.includes("not found") || value.includes("enoent")) return "not-found";
  if (value.includes("快捷方式")) return "shortcut-unparsed";
  if (value.includes("json") || value.includes("解析")) return "parse-failed";
  return "other";
}

function aggregate(items: string[]): { category: string; count: number; sample: string }[] {
  const groups = new Map<string, { count: number; sample: string }>();
  for (const item of items) {
    const category = categoryOf(item);
    const current = groups.get(category);
    if (current) {
      current.count += 1;
    } else {
      groups.set(category, { count: 1, sample: sanitizeText(item) });
    }
  }
  return [...groups.entries()]
    .map(([category, value]) => ({ category, count: value.count, sample: value.sample }))
    .sort((a, b) => b.count - a.count);
}

function maskRecord(record: InstallRecord): Record<string, unknown> {
  return {
    product: record.product,
    discovery: record.discovery,
    identity: record.identity,
    confidence: record.identityCheck?.confidence ?? "none",
    observedVersion: record.identityCheck?.observedVersion ?? record.displayVersion,
    locationSource: record.locationSource,
    primarySource: record.primarySource,
    clueKinds: [...new Set(record.clues.map((c) => c.kind))],
    duplicateRegistrations: record.duplicateRegistrations,
    needsReview: record.needsReview,
    isManagerSelf: record.isManagerSelf,
    managedByTool: record.managedByTool,
    conflicts: record.conflicts,
    path: maskPath(record.installLocation),
    // 原始命令行不导出，只保留“是否存在卸载命令”
    hasRemovalCommand: Boolean(record.uninstallString),
  };
}

function timeOf(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/**
 * 合并事务 journal 与错误日志，取时间最新的一条作为 lastOperation。
 * 错误日志可以独立成为最近操作（例如失败发生在 journal 建立之前）。
 */
export function mergeLastOperation(
  operations: OperationRecord[],
  errors: DiagnosticErrorRecord[],
): { lastOperation: LastOperation | null; sortWarning: string | null } {
  let warning: string | null = null;
  const candidates: { at: number; order: number; value: LastOperation }[] = [];

  operations.forEach((operation, index) => {
    const at = timeOf(operation.updatedAt) || timeOf(operation.createdAt);
    if (Number.isNaN(at)) warning = "存在无法解析时间的操作记录，已按原顺序排在末尾";
    const lastStep = operation.steps.length > 0 ? operation.steps[operation.steps.length - 1]! : null;
    candidates.push({
      at: Number.isNaN(at) ? -1 : at,
      order: index,
      value: {
        source: "journal",
        kind: operation.kind,
        product: operation.product,
        state: operation.state,
        stage: lastStep ? lastStep.state : null,
        failureCode: operation.failure?.code ?? null,
        failureMessage: operation.failure ? sanitizeText(operation.failure.message) : null,
        timestamp: operation.updatedAt || operation.createdAt,
        rolledBack: operation.state === "rolled-back" ? true : operation.state === "failed" ? false : null,
        operationId: operation.operationId,
      },
    });
  });

  errors.forEach((error, index) => {
    const at = timeOf(error.at);
    if (Number.isNaN(at)) warning = "存在无法解析时间的错误记录，已按原顺序排在末尾";
    candidates.push({
      at: Number.isNaN(at) ? -1 : at,
      order: operations.length + index,
      value: {
        source: "error-log",
        kind: error.operation,
        product: error.product,
        state: "failed",
        stage: error.stage,
        failureCode: error.code,
        failureMessage: sanitizeText(error.message),
        timestamp: error.at,
        rolledBack: error.rolledBack,
        operationId: null,
      },
    });
  });

  if (candidates.length === 0) return { lastOperation: null, sortWarning: null };
  candidates.sort((a, b) => (b.at === a.at ? a.order - b.order : b.at - a.at));
  return { lastOperation: candidates[0]!.value, sortWarning: warning };
}

function normalizeKey(target: string | null): string | null {
  if (!target) return null;
  return target.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
}

/**
 * 把“扫描发现的安装”和“管理器登记的实例”按规范化路径关联。
 * 两者是不同事实来源，不能互相覆盖。
 */
export function correlateScanAndManaged(
  scan: ScanReport | null,
  managed: ManagedInstanceDiagnostic[],
): ScanToManagedEntry[] {
  const entries: ScanToManagedEntry[] = [];
  const records = (scan?.records ?? []).filter(
    (record) => !record.isManagerSelf && !(record.installLocation && isDriveRoot(record.installLocation)),
  );
  const byPath = new Map<string, InstallRecord>();
  for (const record of records) {
    const key = normalizeKey(record.installLocation);
    if (key) byPath.set(key, record);
  }

  const matchedKeys = new Set<string>();
  for (const instance of managed) {
    const key = normalizeKey(instance.directory);
    const record = key ? byPath.get(key) : undefined;
    if (!record) {
      entries.push({
        status: "managed-not-found-on-disk",
        product: instance.product,
        version: instance.version,
        instanceId: instance.instanceId,
        path: maskPath(instance.directory),
        note: "管理器登记了该实例，但本次扫描未在磁盘上找到它",
      });
      continue;
    }
    if (key) matchedKeys.add(key);
    if (record.product && record.product !== instance.product) {
      entries.push({
        status: "identity-conflict",
        product: instance.product,
        version: instance.version,
        instanceId: instance.instanceId,
        path: maskPath(instance.directory),
        note: `扫描把该目录识别为 ${record.product}，与登记的产品不一致`,
      });
      continue;
    }
    const observed = record.identityCheck?.observedVersion ?? record.displayVersion ?? null;
    entries.push({
      status: "matched",
      product: instance.product,
      version: instance.version,
      instanceId: instance.instanceId,
      path: maskPath(instance.directory),
      note:
        observed && instance.version && observed !== instance.version
          ? `扫描版本 ${observed} 与登记版本 ${instance.version} 不一致`
          : null,
    });
  }

  for (const record of records) {
    const key = normalizeKey(record.installLocation);
    if (key && matchedKeys.has(key)) continue;
    entries.push({
      status: "discovered-not-managed",
      product: record.product,
      version: record.identityCheck?.observedVersion ?? record.displayVersion ?? null,
      instanceId: null,
      path: maskPath(record.installLocation),
      note: "扫描发现该目录，但管理器没有对应登记（可能是用户自装或其他副本）",
    });
  }

  return entries;
}

export function buildDiagnostics(input: DiagnosticsInput): Record<string, unknown> {
  const scan = input.scan;
  const { lastOperation, sortWarning } = mergeLastOperation(input.recentOperations, input.recentErrors);

  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    diagnosticsSchemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    /** 与运行状态 build.id 必须一致：用来确认报告来自当前二进制 */
    diagnosticsBuildId: input.buildId,
    generatedAt: input.generatedAt,
    exportStartedAt: input.exportStartedAt,
    appVersion: input.appVersion,
    build: {
      id: input.buildId,
      time: input.buildTime,
      packaged: input.packaged,
      portable: input.portable,
      platform: input.platform,
    },
    // 安装/更新/卸载由管理器解包部署完成；签名只作诊断，不参与放行
    deploymentCapabilities: {
      install: input.deployment.install,
      update: input.deployment.update,
      uninstall: input.deployment.uninstall,
      builtInUpdateControl: input.deployment.builtInUpdateControl,
      signatureGate: false,
      source: "current-code",
    },
    scan: {
      status: input.scanStatus.status,
      startedAt: input.scanStatus.startedAt,
      scannedAt: input.scanStatus.scannedAt,
      durationMs: input.scanStatus.durationMs,
      failure: input.scanStatus.failure
        ? { code: input.scanStatus.failure.code, message: sanitizeText(input.scanStatus.failure.message) }
        : null,
      // 扫描本身只读；这是扫描属性，不代表整个产品处于只读模式
      mode: "read-only-scan",
      products: (scan?.products ?? []).map((discovery) => ({
        product: discovery.product,
        state: discovery.state,
        copyCount: discovery.copyCount,
        pendingPathCount: discovery.pendingPath.length,
        installs: discovery.installs.map((record) => ({
          product: record.product as ProductId | null,
          identity: record.identity,
          confidence: record.identityCheck?.confidence ?? "none",
          observedVersion: record.identityCheck?.observedVersion ?? record.displayVersion,
          locationSource: record.locationSource,
          clueKinds: [...new Set(record.clues.map((c) => c.kind))],
          duplicateRegistrations: record.duplicateRegistrations,
          needsReview: record.needsReview,
          conflicts: record.conflicts,
          path: maskPath(record.installLocation),
        })),
      })),
      sources: (scan?.sources ?? []).map((source) => ({ kind: source.kind, count: source.count })),
      // 被忽略的线索（例如盘符根进程路径）：单独计数，不混进“已发现实例”
      ignoredClues: (() => {
        const ignored = (scan?.skippedSources ?? []).filter((item) => item.source === "processes:invalid-path");
        return { count: ignored.length, reasons: aggregate(ignored.map((item) => item.reason)) };
      })(),
      skipped: aggregate((scan?.skippedSources ?? []).map((item) => item.reason)),
      conflicts: aggregate(scan?.conflicts ?? []),
      records: (scan?.records ?? [])
        .filter((record) => !(record.installLocation && isDriveRoot(record.installLocation)))
        .map(maskRecord),
      totals: {
        records: scan?.records.length ?? 0,
        identified: scan?.records.filter((r) => r.identity === "identified").length ?? 0,
        unverified: scan?.records.filter((r) => r.identity === "unverified").length ?? 0,
        conflicts: scan?.records.filter((r) => r.identity === "conflict").length ?? 0,
        needsReview: scan?.records.filter((r) => r.needsReview).length ?? 0,
        managerSelf: scan?.records.filter((r) => r.isManagerSelf).length ?? 0,
      },
    },
    managedInstances: input.managedInstances.map((instance) => ({
      instanceId: instance.instanceId,
      product: instance.product,
      version: instance.version,
      active: instance.active,
      origin: instance.origin,
      registeredAt: instance.registeredAt,
      executableRelativePath: instance.executableRelativePath,
      executablePresent: instance.executablePresent,
      path: maskPath(instance.directory),
    })),
    scanToManaged: input.scanToManaged,
    recentOperations: input.recentOperations.slice(0, 20).map((operation) => ({
      operationId: operation.operationId,
      kind: operation.kind,
      product: operation.product,
      version: operation.version,
      state: operation.state,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      failureCode: operation.failure?.code ?? null,
      failureMessage: operation.failure ? sanitizeText(operation.failure.message) : null,
      completedSteps: operation.steps.filter((step) => step.state === "done").length,
      totalSteps: operation.steps.length,
    })),
    recentErrors: input.recentErrors.slice(0, 20).map((error) => ({
      at: error.at,
      operation: error.operation,
      product: error.product,
      instanceId: error.instanceId,
      stage: error.stage,
      code: error.code,
      message: sanitizeText(error.message),
      rolledBack: error.rolledBack,
    })),
    lastOperation,
    historyStatus: {
      ...input.history,
      sortWarning,
    },
    instanceRegistry: {
      source: input.instanceRegistry.source,
      readable: input.instanceRegistry.readable,
      count: input.instanceRegistry.count,
    },
    errorLog: {
      directory: maskPath(input.errorLogDirectory),
      total: input.history.errorLogTotal,
      corrupted: input.history.errorLogCorrupted,
      readable: input.history.errorLogReadable,
    },
    settings: {
      managementRoot: maskPath(input.settings.managementRoot),
      userScanRootCount: input.settings.userScanRoots.length,
      userScanRoots: input.settings.userScanRoots.map((root) => maskPath(root)),
    },
  };
}

function sanitizeDeep(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeDeep(item)]),
    );
  }
  return value;
}

export function serializeDiagnostics(input: DiagnosticsInput): string {
  // 逐字段清洗后再序列化：对整段 JSON 做正则替换可能破坏转义
  const payload = sanitizeDeep(buildDiagnostics(input));
  return JSON.stringify(payload, null, 2);
}
