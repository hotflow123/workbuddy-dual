import path from "node:path";
import { fail, ok, type Result } from "./contracts";

/**
 * 归档安全校验。
 *
 * 目标：在任何文件写入磁盘之前，先把不可信归档里的危险条目挑出来。
 * 覆盖：路径穿越、绝对路径/盘符/UNC/设备命名空间、符号链接、条目数与总解压体积上限、
 * 嵌套层数上限、超长路径、空路径与重复条目。
 */

export interface ArchiveEntry {
  /** 归档内相对路径（7za 原样） */
  path: string;
  /** 解压后大小（目录为 0） */
  size: number;
  /** 7za 的 Attributes 字段，含 l / L 表示链接 */
  attributes: string;
  isDirectory: boolean;
}

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxPathLength: number;
  maxDepth: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 60_000,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxPathLength: 512,
  maxDepth: 32,
};

const DRIVE_PREFIX = /^[A-Za-z]:/;
const DEVICE_PREFIX = /^\\\\[.?]\\/;

function normalizeEntryPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 单条目的路径安全判定 */
export function isSafeEntryPath(raw: string, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): { ok: boolean; reason?: string } {
  const value = normalizeEntryPath(raw);
  if (value === "" || value === ".") return { ok: false, reason: "空条目路径" };
  if (value.includes("\0")) return { ok: false, reason: "条目路径包含 NUL" };
  if (value.startsWith("/")) return { ok: false, reason: "绝对路径" };
  if (value.startsWith("//")) return { ok: false, reason: "UNC 路径" };
  if (DRIVE_PREFIX.test(value)) return { ok: false, reason: "含盘符的绝对路径" };
  if (DEVICE_PREFIX.test(raw) || value.startsWith("//./") || value.startsWith("//?/")) {
    return { ok: false, reason: "设备命名空间路径" };
  }
  const segments = value.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "..")) return { ok: false, reason: "包含 .. 路径穿越" };
  if (segments.length > limits.maxDepth) return { ok: false, reason: `嵌套层数超过 ${limits.maxDepth}` };
  if (value.length > limits.maxPathLength) return { ok: false, reason: `路径长度超过 ${limits.maxPathLength}` };
  // Windows 保留名（CON/PRN/AUX/NUL/COM1..）会触发设备写入
  if (segments.some((segment) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment))) {
    return { ok: false, reason: "包含 Windows 保留设备名" };
  }
  return { ok: true };
}

export function isLinkEntry(entry: ArchiveEntry): boolean {
  const attributes = entry.attributes ?? "";
  // 7za 对小写 l / 大写 L 都用于标记链接；目录标记为 D
  return /[lL]/.test(attributes);
}

export interface ArchiveValidation {
  entries: ArchiveEntry[];
  totalBytes: number;
  blocking: string[];
}

/**
 * 校验整个归档清单。返回阻断项（非空即拒绝解包）。
 * 重复条目会被标记，因为后写覆盖前写在部署场景里不可审计。
 */
export function validateArchiveEntries(
  entries: ArchiveEntry[],
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Result<ArchiveValidation> {
  const blocking: string[] = [];
  if (entries.length === 0) blocking.push("归档为空或无法读取条目");
  if (entries.length > limits.maxEntries) blocking.push(`条目数 ${entries.length} 超过上限 ${limits.maxEntries}`);

  let totalBytes = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const safety = isSafeEntryPath(entry.path, limits);
    if (!safety.ok) blocking.push(`不安全条目（${safety.reason}）：${entry.path.slice(0, 160)}`);
    if (isLinkEntry(entry)) blocking.push(`归档包含链接条目，拒绝解包：${entry.path.slice(0, 160)}`);
    const key = normalizeEntryPath(entry.path).toLowerCase();
    if (seen.has(key)) blocking.push(`重复条目：${entry.path.slice(0, 160)}`);
    seen.add(key);
    if (!entry.isDirectory) totalBytes += Math.max(0, entry.size);
  }
  if (totalBytes > limits.maxTotalBytes) {
    blocking.push(`解压后体积 ${Math.round(totalBytes / 1024 / 1024)}MB 超过上限 ${Math.round(limits.maxTotalBytes / 1024 / 1024)}MB`);
  }
  const unique = [...new Set(blocking)].slice(0, 12);
  if (unique.length > 0) {
    return fail("E_PACKAGE_FORMAT", `归档未通过安全校验：${unique.join("；")}`, { blocking: unique });
  }
  return ok({ entries, totalBytes, blocking: [] });
}

/** 目录遍历端口（解包后复核用） */
export interface TreeProbe {
  listDirectory(directory: string): Promise<string[]>;
  isReparsePoint(target: string): Promise<boolean>;
  stat(target: string): Promise<{ size: number; isDirectory: boolean } | null>;
}

export interface TreeValidation {
  files: number;
  bytes: number;
  blocking: string[];
}

/**
 * 解包后复核：所有条目必须落在 root 内、不能是重解析点、累计体积不得超限。
 * 这里用 path.resolve 做前缀比较，防止归档工具“解到外面”。
 */
export async function validateExtractedTree(
  root: string,
  probe: TreeProbe,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<Result<TreeValidation>> {
  const resolvedRoot = path.resolve(root);
  const blocking: string[] = [];
  let files = 0;
  let bytes = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (blocking.length > 6) return;
    if (depth > limits.maxDepth) {
      blocking.push(`目录嵌套超过 ${limits.maxDepth} 层：${directory}`);
      return;
    }
    let names: string[];
    try {
      names = await probe.listDirectory(directory);
    } catch (error) {
      blocking.push(`目录不可读：${directory}（${error instanceof Error ? error.message : "未知错误"}）`);
      return;
    }
    for (const name of names) {
      const target = path.join(directory, name);
      const resolved = path.resolve(target);
      if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
        blocking.push(`条目逃逸出解包目录：${target}`);
        continue;
      }
      if (await probe.isReparsePoint(target)) {
        blocking.push(`包含重解析点（符号链接/junction）：${target}`);
        continue;
      }
      const stat = await probe.stat(target);
      if (!stat) continue;
      if (stat.isDirectory) {
        await walk(target, depth + 1);
      } else {
        files += 1;
        bytes += stat.size;
        if (files > limits.maxEntries) {
          blocking.push(`文件数超过上限 ${limits.maxEntries}`);
          return;
        }
        if (bytes > limits.maxTotalBytes) {
          blocking.push(`解压体积超过上限 ${Math.round(limits.maxTotalBytes / 1024 / 1024)}MB`);
          return;
        }
      }
    }
  };

  await walk(resolvedRoot, 0);
  const unique = [...new Set(blocking)].slice(0, 12);
  if (unique.length > 0) {
    return fail("E_PACKAGE_FORMAT", `解包结果未通过安全复核：${unique.join("；")}`, { blocking: unique });
  }
  return ok({ files, bytes, blocking: [] });
}
