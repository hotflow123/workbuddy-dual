import path from "node:path";
import { fail, ok, type Result } from "./contracts";

/**
 * 路径守卫：任何写操作在落盘前都必须经过这里。
 * 目标必须严格位于用户选择的管理根目录之下，且不能是系统目录、用户数据目录、
 * 网络共享、重解析点（符号链接/junction）或 8.3 短名绕过。
 */

const SHORT_NAME = /(^|\\)[^\\]{1,7}~\d(\\|$)/i;

export function toCompareKey(p: string): string {
  const resolved = path.resolve(p);
  const trimmed = resolved.replace(/[\\/]+$/, "");
  return (process.platform === "win32" ? trimmed.toLowerCase() : trimmed).replace(/\//g, "\\");
}

/** 盘符根目录（D:\、D:/、D:）—— 永远不能作为安装实例或占用目录 */
export function isDriveRoot(target: string): boolean {
  if (typeof target !== "string") return false;
  const trimmed = target.trim().replace(/[\\/]+$/, "");
  return /^[A-Za-z]:$/i.test(trimmed);
}

export function isSubPath(parent: string, child: string): boolean {
  const p = toCompareKey(parent);
  const c = toCompareKey(child);
  if (p === c) return false;
  return c.startsWith(p.endsWith("\\") ? p : `${p}\\`);
}

export interface PathGuardConfig {
  /** 用户选择的管理根目录（绝对路径） */
  managementRoot: string;
  /** 额外的禁写目录（系统目录、用户数据目录等） */
  forbiddenRoots?: string[];
  /**
   * 受控例外：允许写入管理根之外的**精确目录**（用于原位更新/卸载已接管的官方安装）。
   * 只能由“已接管实例”的目录填充；禁用通配或盘符根。
   */
  externalRoots?: string[];
}

export interface ResolvedTarget {
  /** 规范化后的绝对路径 */
  absolute: string;
  /** 相对管理根目录的路径 */
  relative: string;
}

export class PathGuard {
  private readonly root: string;
  private readonly forbidden: string[];

  private readonly external: string[];

  constructor(config: PathGuardConfig) {
    this.root = path.resolve(config.managementRoot);
    this.forbidden = (config.forbiddenRoots ?? []).map((p) => path.resolve(p));
    this.external = (config.externalRoots ?? [])
      .map((p) => path.resolve(p))
      .filter((p) => toCompareKey(p) !== toCompareKey(path.parse(p).root));
  }

  get managementRoot(): string {
    return this.root;
  }

  /** 只做静态检查，不做 IO（便于单元测试与预演阶段使用）。 */
  check(candidate: string): Result<ResolvedTarget> {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      return fail("E_PATH_REJECTED", "路径为空");
    }
    if (candidate.includes("\u0000")) {
      return fail("E_PATH_REJECTED", "路径包含非法字符");
    }
    if (/^\\\\[?.]\\/.test(candidate)) {
      return fail("E_PATH_REJECTED", "拒绝设备命名空间路径");
    }
    if (!path.isAbsolute(candidate)) {
      return fail("E_PATH_REJECTED", "必须使用绝对路径");
    }
    if (/^\\\\/.test(candidate)) {
      return fail("E_PATH_REJECTED", "MVP 不支持网络共享路径");
    }
    if (SHORT_NAME.test(candidate)) {
      return fail("E_PATH_REJECTED", "拒绝 8.3 短名路径，请使用完整路径");
    }
    const absolute = path.resolve(candidate);
    const parsed = path.parse(absolute);
    if (toCompareKey(absolute) === toCompareKey(parsed.root)) {
      return fail("E_PATH_REJECTED", "拒绝磁盘根目录");
    }
    if (toCompareKey(absolute) === toCompareKey(this.root)) {
      return fail("E_PATH_REJECTED", "拒绝把管理根目录本身作为写入目标");
    }
    for (const forbidden of this.forbidden) {
      if (toCompareKey(absolute) === toCompareKey(forbidden) || isSubPath(forbidden, absolute)) {
        return fail("E_PATH_REJECTED", "拒绝写入系统目录或用户数据目录", { target: forbidden });
      }
    }
    const inManagementRoot = isSubPath(this.root, absolute);
    const externalRoot = this.external.find(
      (root) => toCompareKey(root) === toCompareKey(absolute) || isSubPath(root, absolute),
    );
    if (!inManagementRoot && !externalRoot) {
      return fail("E_PATH_REJECTED", "目标不在管理根目录之内，也不在已接管实例的目录内");
    }
    return ok({
      absolute,
      relative: inManagementRoot ? path.relative(this.root, absolute) : absolute,
    });
  }

  /**
   * 需要真实 IO 的检查：目标或其父链上若存在重解析点，说明可能逃逸到管理根之外。
   * `realpath` 由调用方注入，便于在测试中使用假实现。
   */
  async checkWithRealPath(
    candidate: string,
    realpath: (p: string) => Promise<string>,
    exists: (p: string) => Promise<boolean>,
  ): Promise<Result<ResolvedTarget>> {
    const staticCheck = this.check(candidate);
    if (!staticCheck.ok) return staticCheck;

    let probe = staticCheck.value.absolute;
    // 自底向上找到第一个存在的祖先，再求真实路径
    for (;;) {
      if (await exists(probe)) break;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    try {
      const real = await realpath(probe);
      if (!isSubPath(this.root, real) && toCompareKey(real) !== toCompareKey(this.root)) {
        return fail("E_PATH_REJECTED", "目标经重解析点后逃逸出管理根目录", { resolved: real });
      }
      if (toCompareKey(real) !== toCompareKey(probe)) {
        // 真实路径与字面路径不一致：可能是符号链接/短名，MVP 一律拒绝
        return fail("E_PATH_REJECTED", "目标路径包含重解析点或非规范形式，已拒绝");
      }
    } catch (error) {
      return fail("E_PERMISSION", "无法解析目标路径的真实位置", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return staticCheck;
  }
}

/** 受管目录布局：<管理根>\WorkBuddy-CN\versions\<版本> 与 <管理根>\WorkBuddy-AI\versions\<版本> */
export function productFolderName(product: "workbuddy-cn" | "workbuddy-ai"): string {
  return product === "workbuddy-cn" ? "WorkBuddy-CN" : "WorkBuddy-AI";
}

export function versionDirectory(root: string, product: "workbuddy-cn" | "workbuddy-ai", version: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,40}$/.test(version)) {
    throw new Error("版本号包含非法字符，拒绝拼接到路径");
  }
  return path.join(root, productFolderName(product), "versions", version);
}

export function backupsDirectory(root: string, product: "workbuddy-cn" | "workbuddy-ai"): string {
  return path.join(root, productFolderName(product), "backups");
}

/* ------------------------------------------------------------------ 用户选择的安装目标 */

export interface InstallTargetDeps {
  exists(target: string): Promise<boolean>;
  isDirectory(target: string): Promise<boolean>;
  listDirectory(directory: string): Promise<string[]>;
  realpath(target: string): Promise<string>;
  isWritable(target: string): Promise<boolean>;
}

export interface InstallTargetInput {
  target: string;
  /** 禁止安装的系统目录（Windows / Program Files / ProgramData 等） */
  forbiddenRoots?: string[];
  /** 管理器自身运行/打包目录 */
  selfDirectories?: string[];
  /** 已被实例或扫描安装占用的目录（不得覆盖） */
  occupiedDirectories?: string[];
}

export interface InstallTargetResult {
  /** 规范化后的绝对路径 */
  absolute: string;
  /** 父目录（必须存在） */
  parent: string;
  /** 是否已存在（存在时必须为空目录） */
  existing: boolean;
}

/**
 * 校验“用户明确选择的安装目标”。与 PathGuard 的“管理根内部写入”区分：
 *  - 这里允许任意本地固定磁盘目录（C/D/…），但只允许**空目录或尚不存在的目录**；
 *  - 不做提权，父目录不可写时返回权限错误，让用户自己换目录；
 *  - 拒绝 UNC/设备/根目录/系统目录/管理器自身目录/重解析点/被其他实例占用的目录。
 */
export async function validateInstallTarget(
  input: InstallTargetInput,
  deps: InstallTargetDeps,
): Promise<Result<InstallTargetResult>> {
  const raw = (input.target ?? "").trim();
  if (raw === "") return fail("E_PATH_REJECTED", "请先选择安装目录：安装目标不能为空");
  if (raw.includes("\u0000")) return fail("E_PATH_REJECTED", "路径包含非法字符");
  if (/^\\\\[?.]\\/.test(raw)) return fail("E_PATH_REJECTED", "拒绝设备命名空间路径");
  if (!path.isAbsolute(raw)) return fail("E_PATH_REJECTED", "安装目录必须是绝对路径");
  if (/^\\\\/.test(raw)) return fail("E_PATH_REJECTED", "安装目录必须是本地磁盘路径，不支持网络共享");
  if (SHORT_NAME.test(raw)) return fail("E_PATH_REJECTED", "拒绝 8.3 短名路径，请使用完整路径");

  const absolute = path.resolve(raw);
  if (toCompareKey(absolute) === toCompareKey(path.parse(absolute).root)) {
    return fail("E_PATH_REJECTED", "不能直接安装到磁盘根目录");
  }

  for (const forbidden of input.forbiddenRoots ?? []) {
    if (!forbidden) continue;
    const normalized = path.resolve(forbidden);
    if (toCompareKey(absolute) === toCompareKey(normalized) || isSubPath(normalized, absolute)) {
      return fail("E_PATH_REJECTED", `不能安装到系统目录：${normalized}`);
    }
  }
  for (const self of input.selfDirectories ?? []) {
    if (!self) continue;
    const normalized = path.resolve(self);
    if (toCompareKey(absolute) === toCompareKey(normalized) || isSubPath(normalized, absolute)) {
      return fail("E_PATH_REJECTED", "不能安装到管理器自身的目录");
    }
  }
  for (const occupied of input.occupiedDirectories ?? []) {
    // 防御：旧实例登记或异常调用方可能塞入盘符根/相对路径/空值。
    // 盘符根不是安装实例，不能因为它拦住该盘所有安装目标。
    if (!occupied || typeof occupied !== "string" || occupied.trim() === "") continue;
    if (!path.isAbsolute(occupied)) continue;
    if (isDriveRoot(occupied)) continue;
    const normalized = path.resolve(occupied);
    if (toCompareKey(absolute) === toCompareKey(normalized) || isSubPath(normalized, absolute)) {
      return fail("E_CONFLICT", `该目录已被现有实例占用：${normalized}`);
    }
    // 反向：不能把安装目标放到已有实例的父目录上覆盖它
    if (isSubPath(absolute, normalized)) {
      return fail("E_CONFLICT", "安装目录不能包含已有的安装实例");
    }
  }

  const parent = path.dirname(absolute);
  const existing = await deps.exists(absolute);

  if (existing) {
    if (!(await deps.isDirectory(absolute))) {
      return fail("E_PATH_REJECTED", "目标路径已存在且不是目录");
    }
    const entries = await deps.listDirectory(absolute);
    if (entries.length > 0) {
      return fail("E_TARGET_EXISTS", "目标目录非空，拒绝覆盖；请换一个空目录，或对该实例使用“更新”");
    }
    if (!(await deps.isWritable(absolute))) {
      return fail("E_PERMISSION", `当前账户无权写入该目录：${absolute}`);
    }
  } else {
    if (!(await deps.exists(parent))) {
      return fail("E_PATH_REJECTED", `父目录不存在：${parent}`);
    }
    if (!(await deps.isDirectory(parent))) {
      return fail("E_PATH_REJECTED", `父路径不是目录：${parent}`);
    }
    if (!(await deps.isWritable(parent))) {
      return fail("E_PERMISSION", `当前账户无权在父目录创建安装目录：${parent}`);
    }
  }

  // 重解析点检查：用最近存在的祖先做 realpath，必须与字面路径一致
  let probe = existing ? absolute : parent;
  for (;;) {
    if (await deps.exists(probe)) break;
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  try {
    const real = await deps.realpath(probe);
    if (toCompareKey(real) !== toCompareKey(probe)) {
      return fail("E_PATH_REJECTED", "安装目录包含重解析点（符号链接/junction）或非规范形式，已拒绝");
    }
  } catch (error) {
    return fail("E_PERMISSION", "无法解析安装目录的真实位置", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return ok({ absolute, parent, existing });
}
