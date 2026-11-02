import path from "node:path";
import type { ProductId } from "./contracts";
import { PRODUCT_IDS, traitsOf } from "./knownProducts";

/**
 * 进程线索解析（纯函数，便于在任意主机上单测）。
 *
 * 只有“绝对路径 + 客户端主程序 .exe”才算有效线索；盘符根目录、目录路径、
 * 卸载/修复/安装器、临时解包目录一律拒绝——盘符根绝不能变成安装实例。
 */

export interface ProcessRow {
  path: string;
  name: string;
}

export type ProcessRejectReason =
  | "empty-path"
  | "not-absolute"
  | "drive-root"
  | "not-executable"
  | "no-parent-directory"
  | "temp-directory"
  | "not-product-executable";

export interface ResolvedProcess {
  /** 原始可执行文件路径（规范化后） */
  path: string;
  name: string;
  /** 可执行文件所在目录 —— 这才是候选安装目录 */
  directory: string;
  /** 由文件名唯一匹配到的产品；无法唯一确定时为 null，交由身份判定 */
  product: ProductId | null;
}

export interface ProcessReject {
  path: string;
  name: string;
  reason: ProcessRejectReason;
  /** 面向用户的简短说明，不含完整个人路径 */
  detail: string;
}

export type ProcessResolution = { ok: true; value: ResolvedProcess } | { ok: false; reject: ProcessReject };

const ABSOLUTE_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const EXECUTABLE_NAME = /\.exe$/i;

/** 盘符根：`D:\`、`D:/`、`D:` 都算 */
export function isDriveRoot(target: string): boolean {
  const trimmed = target.trim().replace(/[\\/]+$/, "");
  return /^[A-Za-z]:$/i.test(trimmed);
}

function productByExecutable(fileName: string): ProductId | null {
  const lower = fileName.toLowerCase();
  const matches = PRODUCT_IDS.filter((product) =>
    traitsOf(product).executableNames.some((name) => name.toLowerCase() === lower),
  );
  // 映射不唯一时不下结论，只保留线索
  return matches.length === 1 ? matches[0]! : null;
}

function isUnder(directory: string, root: string): boolean {
  const parent = root.replace(/[\\/]+$/, "").toLowerCase();
  const child = directory.replace(/[\\/]+$/, "").toLowerCase();
  return child === parent || child.startsWith(`${parent}\\`);
}

/**
 * 把一条进程记录解析成候选安装目录。
 * `tempDirectories` 用于排除临时解包目录（调用方传入系统 temp / 管理器 staging 根）。
 */
export function resolveProcessCandidate(
  row: { path?: unknown; name?: unknown },
  options: { tempDirectories?: string[] } = {},
): ProcessResolution {
  const rawPath = typeof row.path === "string" ? row.path.trim() : "";
  const name = typeof row.name === "string" && row.name.trim() !== "" ? row.name.trim() : "";

  if (rawPath === "") {
    return { ok: false, reject: { path: "", name, reason: "empty-path", detail: "进程没有可读的可执行文件路径" } };
  }
  if (!ABSOLUTE_DRIVE_PATH.test(rawPath) || rawPath.startsWith("\\\\")) {
    return {
      ok: false,
      reject: { path: rawPath, name, reason: "not-absolute", detail: "进程路径不是本地绝对路径" },
    };
  }
  if (isDriveRoot(rawPath)) {
    return {
      ok: false,
      reject: { path: rawPath, name, reason: "drive-root", detail: "进程路径是盘符根目录，不是安装实例" },
    };
  }
  if (!EXECUTABLE_NAME.test(rawPath)) {
    return {
      ok: false,
      reject: { path: rawPath, name, reason: "not-executable", detail: "进程路径不是可执行文件" },
    };
  }

  const normalized = path.win32.normalize(rawPath);
  const fileName = path.win32.basename(normalized);
  const directory = path.win32.dirname(normalized);

  if (directory === "." || directory === "" || isDriveRoot(directory)) {
    return {
      ok: false,
      reject: {
        path: normalized,
        name,
        reason: directory === "" || directory === "." ? "no-parent-directory" : "drive-root",
        detail: "可执行文件位于盘符根目录，不能作为安装目录",
      },
    };
  }

  for (const temp of options.tempDirectories ?? []) {
    if (temp && isUnder(directory, temp)) {
      return {
        ok: false,
        reject: { path: normalized, name, reason: "temp-directory", detail: "可执行文件位于临时解包目录" },
      };
    }
  }

  const product = productByExecutable(fileName);
  if (product === null && !PRODUCT_IDS.some((id) => traitsOf(id).executableNames.some((n) => n.toLowerCase() === fileName.toLowerCase()))) {
    return {
      ok: false,
      reject: {
        path: normalized,
        name,
        reason: "not-product-executable",
        detail: "可执行文件名不是客户端主程序（可能是卸载器、修复器或安装器）",
      },
    };
  }

  return { ok: true, value: { path: normalized, name, directory, product } };
}

/** 解析 WMI `Get-CimInstance ... | ConvertTo-Json` 的输出（数组或单对象） */
export function parseProcessRows(raw: unknown): ProcessRow[] {
  const rows = Array.isArray(raw) ? raw : [raw];
  const result: ProcessRow[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const exePath = typeof record["ExecutablePath"] === "string" ? record["ExecutablePath"] : null;
    if (!exePath) continue;
    const name =
      typeof record["Name"] === "string" && record["Name"].trim() !== ""
        ? record["Name"].trim()
        : path.win32.basename(exePath);
    result.push({ path: exePath, name });
  }
  return result;
}

/** 解析一段 JSON 文本（进程查询的 stdout）；非法输入返回空数组 */
export function parseProcessOutput(text: string): ProcessRow[] {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "null") return [];
  try {
    return parseProcessRows(JSON.parse(trimmed));
  } catch {
    return [];
  }
}
