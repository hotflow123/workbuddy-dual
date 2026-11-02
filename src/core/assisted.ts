import path from "node:path";
import { fail, ok, type Result } from "./contracts";
import {
  PRODUCT_LABELS,
  type AssistedKind,
  type AssistedTarget,
  type InstallRecord,
  type OperationAvailability,
  type PackageCheck,
  type ProductDiscovery,
  type ProductId,
  type ScanReport,
  type SnapshotSummary,
} from "./contracts";

/**
 * 辅助操作的能力派生与安全检查。
 *
 * 设计红线（与 EXECUTION_PLAN 第 2/3/4 步一致）：
 *  - 只允许启动原厂交互式界面，不拼静默参数、不模拟点击、不绕过 UAC。
 *  - 没有可用的发布者基线时 fail-closed；绝不因文件名或目录名信任安装包。
 *  - 多副本不做自动择一；无法可靠约束目标时降级为人工指引。
 */

/* ------------------------------------------------------------------ 卸载命令解析 */

export type UninstallKind = "direct-exe" | "msiexec" | "system-executor" | "not-executable" | "empty";

export interface ParsedUninstall {
  kind: UninstallKind;
  /** 可直接启动的本地可执行文件（仅 direct-exe 才有） */
  executable: string | null;
  /** 原始命令（仅用于展示，不执行） */
  raw: string | null;
  detail: string;
}

const ENV_VAR = /%([^%]+)%/g;

function expandEnv(value: string, env: Record<string, string | undefined>): string {
  return value.replace(ENV_VAR, (whole, name: string) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === String(name).toLowerCase());
    const found = key ? env[key] : undefined;
    return found && found.length > 0 ? found : whole;
  });
}

/** 从 UninstallString 中拆出可执行文件路径；只做字符串解析，从不执行。 */
export function parseUninstallCommand(
  command: string | null,
  env: Record<string, string | undefined> = process.env,
): ParsedUninstall {
  const raw = command?.trim() ?? "";
  if (raw === "") {
    return { kind: "empty", executable: null, raw: null, detail: "该安装没有可用的卸载命令" };
  }

  let executable: string | null = null;
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    executable = end > 1 ? raw.slice(1, end) : null;
  } else {
    const match = /^(.*?\.exe)(\s|$)/i.exec(raw);
    if (match?.[1]) executable = match[1];
  }

  if (!executable) {
    return { kind: "not-executable", executable: null, raw, detail: "卸载命令无法解析出本地可执行文件" };
  }

  const expanded = expandEnv(executable, env);
  const base = path.basename(expanded).toLowerCase();
  if (base === "msiexec.exe") {
    return {
      kind: "msiexec",
      executable: null,
      raw,
      detail: "该安装由 Windows Installer 托管：不做静默调用，请在「应用和功能」中手动卸载",
    };
  }
  if (base === "rundll32.exe" || base === "cmd.exe" || base === "powershell.exe" || base === "pwsh.exe") {
    return {
      kind: "system-executor",
      executable: null,
      raw,
      detail: `卸载命令通过系统解释器 ${base} 执行：本工具不代执行，请手动运行官方卸载入口`,
    };
  }
  return { kind: "direct-exe", executable: expanded, raw, detail: "可启动官方卸载程序（交互式）" };
}

/* ------------------------------------------------------------------ 实例与能力 */

export interface AvailabilityInput {
  product: ProductId;
  discovery: ProductDiscovery | null;
  /** 官方在线来源是否已配置且核验通过 */
  onlineVerified: boolean;
  /** 判断卸载命令里的可执行文件是否存在 */
  exists?: (target: string) => boolean;
  env?: Record<string, string | undefined>;
}

function installsOf(discovery: ProductDiscovery | null): InstallRecord[] {
  if (!discovery) return [];
  return [...discovery.installs, ...discovery.pendingPath];
}

function toTarget(record: InstallRecord, input: AvailabilityInput): AssistedTarget {
  const parsed = parseUninstallCommand(record.uninstallString, input.env);
  const usable = parsed.executable !== null && (input.exists ? input.exists(parsed.executable) : true);
  return {
    recordId: record.id,
    path: record.installLocation,
    version: record.displayVersion ?? record.identityCheck?.observedVersion ?? null,
    displayName: record.displayName,
    uninstallerPath: usable ? parsed.executable : null,
    uninstallerDetail: usable
      ? "可启动官方卸载程序（交互式）；卸载器可能影响用户数据"
      : parsed.executable !== null
        ? "登记的卸载程序在当前电脑上不存在，无法启动"
        : parsed.detail,
  };
}

function blockedReview(records: InstallRecord[]): boolean {
  return records.some((record) => record.identity === "conflict" || record.needsReview);
}

export function deriveOperationAvailability(input: AvailabilityInput): OperationAvailability[] {
  const records = installsOf(input.discovery);
  const identified = records.filter((record) => record.identity === "identified");
  const copies = identified.filter((record) => record.installLocation !== null);
  const review = blockedReview(records);
  const targets = copies.map((record) => toTarget(record, input));

  /* ------------------------------------------------------------- 安装 */
  const install = ((): OperationAvailability => {
    const base = { product: input.product, kind: "install" as AssistedKind, requiresPackage: true, requiresTarget: false };
    if (review) {
      return {
        ...base,
        state: "blocked",
        reason: "存在需人工确认的安装记录（身份冲突或元数据异常）：请先处理冲突，再考虑安装或覆盖",
        targets,
      };
    }
    if (copies.length === 0) {
      return {
        ...base,
        state: "assisted",
        reason: "未发现已安装版本：选择官方安装包后可启动官方安装器（交互式，由安装器自行决定路径与权限）",
        targets,
      };
    }
    if (copies.length === 1) {
      return {
        ...base,
        state: "assisted",
        reason: "已发现 1 份安装：启动安装器可能覆盖该版本，安装器是否保留用户数据未知",
        targets,
      };
    }
    return {
      ...base,
      state: "assisted",
      reason: `已发现 ${copies.length} 份安装：安装器可能覆盖其中一份或新建路径，本工具不会替你选择目标`,
      targets,
    };
  })();

  /* ------------------------------------------------------------- 更新 */
  const update = ((): OperationAvailability => {
    const base = { product: input.product, kind: "update" as AssistedKind, requiresPackage: true };
    if (review) {
      return {
        ...base,
        state: "blocked",
        requiresTarget: copies.length > 1,
        reason: "存在需人工确认的安装记录：请先处理冲突，再进行更新",
        targets,
      };
    }
    if (copies.length === 0) {
      return {
        ...base,
        state: "guidance-only",
        requiresTarget: false,
        reason: "未发现该产品的已安装版本，没有可更新的目标；如需安装请使用安装入口",
        targets,
      };
    }
    if (copies.length > 1) {
      return {
        ...base,
        state: "guidance-only",
        requiresTarget: false,
        reason: `发现 ${copies.length} 份安装：官方安装器无法被可靠约束为只更新指定副本，请按官方文档手动更新目标副本`,
        targets,
      };
    }
    const target = copies[0]!;
    const version = target.displayVersion ?? target.identityCheck?.observedVersion ?? "版本未知";
    return {
      ...base,
      state: "assisted",
      requiresTarget: true,
      reason: input.onlineVerified
        ? `当前安装 ${version}（${target.installLocation}）：可选择官方安装包启动官方安装器完成更新；结束后会自动复扫`
        : `当前安装 ${version}：未配置已核验的官方在线更新来源，只能选择本地官方安装包启动安装器；结束后会自动复扫`,
      targets,
    };
  })();

  /* ------------------------------------------------------------- 卸载 */
  const uninstall = ((): OperationAvailability => {
    const base = { product: input.product, kind: "uninstall" as AssistedKind, requiresPackage: false, requiresTarget: true };
    if (copies.length === 0) {
      return {
        ...base,
        state: "guidance-only",
        reason: targets.length > 0 ? "只找到卸载登记，没有可用安装路径：请从「应用和功能」手动卸载" : "未发现可卸载的安装",
        targets,
      };
    }
    const blockedCount = copies.filter((record) => record.identity !== "identified" || record.needsReview).length;
    const usable = targets.filter((target) => target.uninstallerPath !== null);
    if (usable.length === 0) {
      return {
        ...base,
        state: "guidance-only",
        reason: "没有可直接启动的官方卸载程序（Windows Installer、系统解释器或路径失效）：请从「应用和功能」手动卸载",
        targets,
      };
    }
    const parts: string[] = [];
    parts.push(`可为 ${usable.length} 个安装实例打开官方卸载程序；卸载器是否删除用户数据未知，可能影响聊天记录与登录态`);
    if (copies.length > 1) parts.push(`${copies.length} 份安装需逐个选择，不会自动择一`);
    if (blockedCount > 0) parts.push(`${blockedCount} 个实例身份待确认，已禁止对其操作`);
    return { ...base, state: "assisted", reason: parts.join("；"), targets };
  })();

  return [install, update, uninstall];
}

/* ------------------------------------------------------------------ 安装包判定 */

export type SignerBaselineSource = "evidence" | "user-approved" | "observed-install" | "none";

export interface SignerBaseline {
  source: SignerBaselineSource;
  subjects: string[];
  /**
   * 证书指纹（十六进制，可带分隔符）。非空时**必须**指纹匹配才算通过——
   * 主体名称相同并不等于证书相同，同名证书轮换必须重新确认。
   */
  thumbprints?: string[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeThumbprint(value: string | null | undefined): string {
  return (value ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase();
}

export interface AssistedPackageVerdict {
  allowed: boolean;
  /** 仅用于诊断：签名与基线的匹配级别，不参与放行判定 */
  level: SignerBaselineSource;
  reasons: string[];
}

/**
 * 安装包预检（0.6.1）。
 *
 * 只做两件事：
 *  1. 结构性判定：归档/哈希等致命问题（check.verdict === "invalid"）仍然拒绝；
 *  2. 产品身份：必须能从包里读到产品名，具体是否与所选产品一致由 verifyPackage 判定。
 *
 * Authenticode 状态、发布者、证书指纹、信任基线**一律不阻断**，只写进 reasons 供诊断。
 */
export function evaluateAssistedPackage(check: PackageCheck, baseline: SignerBaseline): AssistedPackageVerdict {
  const reasons: string[] = [];
  if (check.verdict === "invalid") {
    return { allowed: false, level: "none", reasons: check.reasons.length > 0 ? check.reasons : ["安装包未通过校验"] };
  }
  if (!check.productName) {
    reasons.push("安装包内没有可读的产品名称，无法确认它与目标产品的对应关系");
    return { allowed: false, level: "none", reasons };
  }
  const auth = check.authenticode;
  reasons.push(
    auth
      ? `签名：${auth.status}${auth.signerSubject ? `（${auth.signerSubject}）` : ""}（仅诊断，不影响安装/更新）`
      : "签名：未能读取 Authenticode（仅诊断，不影响安装/更新）",
  );
  reasons.push(`产品身份：${check.productName}`);
  return { allowed: true, level: baseline.source, reasons };
}

/* ------------------------------------------------------------------ 操作前后对比 */

export function snapshotOf(report: ScanReport | null, product: ProductId): SnapshotSummary {
  if (!report) return { version: null, paths: [] };
  const discovery = report.products.find((item) => item.product === product);
  const records = discovery ? [...discovery.installs] : [];
  const paths = records.map((record) => record.installLocation ?? "(路径待解析)").sort();
  const versions = records
    .map((record) => record.displayVersion ?? record.identityCheck?.observedVersion ?? null)
    .filter((value): value is string => Boolean(value));
  return { version: versions[0] ?? null, paths };
}

export function sameSnapshot(a: SnapshotSummary, b: SnapshotSummary): boolean {
  return a.version === b.version && a.paths.join("|") === b.paths.join("|");
}

export interface RescanComparison {
  rescanConfirmed: boolean;
  changed: boolean;
  counterpartChanged: boolean;
  notes: string[];
}

/**
 * 复扫结论。只有“目标版本变化且另一版完全没变”才能算确认；
 * 其余一律如实标注不确定，不把进程退出码当成成功。
 */
export function compareAfterLaunch(
  kind: AssistedKind,
  before: SnapshotSummary,
  after: SnapshotSummary,
  counterpartBefore: SnapshotSummary,
  counterpartAfter: SnapshotSummary,
  product: ProductId,
): RescanComparison {
  const targetChanged = !sameSnapshot(before, after);
  const counterpartChanged = !sameSnapshot(counterpartBefore, counterpartAfter);
  const notes: string[] = [];
  const label = PRODUCT_LABELS[product];

  if (kind === "uninstall") {
    const removed = before.paths.filter((item) => !after.paths.includes(item));
    if (removed.length > 0) notes.push(`${label}：复扫已看不到 ${removed.length} 个原安装路径`);
    else notes.push(`${label}：复扫仍检测到原安装路径或登记，卸载可能未完成或存在残留`);
    if (counterpartChanged) notes.push("另一版本的检测结果也发生变化，需要人工确认是否被波及");
    return {
      rescanConfirmed: removed.length > 0 && !counterpartChanged,
      changed: targetChanged,
      counterpartChanged,
      notes,
    };
  }

  if (after.paths.length === 0) notes.push(`${label}：复扫没有发现安装，不能宣称安装或更新成功`);
  else if (before.version && after.version && before.version !== after.version) {
    notes.push(`${label}：版本 ${before.version} → ${after.version}`);
  } else if (after.version === before.version) {
    notes.push(`${label}：复扫版本仍为 ${after.version ?? "未知"}，可能已取消、覆盖安装同版本，或官方安装器未完成`);
  } else {
    notes.push(`${label}：复扫读到版本 ${after.version ?? "未知"}`);
  }
  if (counterpartChanged) notes.push("另一版本的检测结果也发生变化，需要人工确认是否被波及");

  return {
    rescanConfirmed: targetChanged && !counterpartChanged && after.paths.length > 0,
    changed: targetChanged,
    counterpartChanged,
    notes,
  };
}

/**
 * 结构化解析卸载调用（可执行文件 + 参数），只允许作用域明确的标准参数。
 *
 * 官方安装器写入的卸载命令形如 `"E:////Programs////workbuddy////Uninstall WorkBuddy.exe" /currentuser`。
 * 这里**只放行** `/currentuser` 与 `/allusers` 这类声明作用域的参数；
 * 其他参数（含 `/S` 静默、路径、脚本）一律拒绝，避免替用户执行未知行为。
 */
export interface UninstallInvocation {
  executable: string;
  args: string[];
  raw: string;
}

const ALLOWED_UNINSTALL_ARGS = new Set(["/currentuser", "/allusers"]);

export function parseUninstallInvocation(
  command: string | null,
  env: Record<string, string | undefined> = process.env,
): Result<UninstallInvocation> {
  const raw = command?.trim() ?? "";
  if (raw === "") return fail("E_VALIDATION", "卸载命令为空");

  let executablePart = "";
  let rest = "";
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    if (end <= 1) return fail("E_VALIDATION", "卸载命令的引号不完整");
    executablePart = raw.slice(1, end);
    rest = raw.slice(end + 1).trim();
  } else {
    const match = /^(.*?\.exe)(\s|$)/i.exec(raw);
    if (!match?.[1]) return fail("E_VALIDATION", "无法从卸载命令解析出可执行文件");
    executablePart = match[1];
    rest = raw.slice(match[1].length).trim();
  }

  const executable = expandEnv(executablePart, env);
  const args = rest === "" ? [] : rest.match(/"[^"]*"|\S+/g) ?? [];
  const normalized = args.map((arg) => arg.replace(/^"|"$/g, "").toLowerCase());
  const rejected = normalized.filter((arg) => arg.startsWith("/") || arg.startsWith("-")).filter((arg) => !ALLOWED_UNINSTALL_ARGS.has(arg));
  if (rejected.length > 0) {
    return fail("E_VALIDATION", `卸载命令包含未获允许的参数：${rejected.join(" ")}`);
  }
  return ok({ executable, args: args.map((arg) => arg.replace(/^"|"$/g, "")), raw });
}
