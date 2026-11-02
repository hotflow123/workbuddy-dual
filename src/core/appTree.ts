import path from "node:path";
import { fail, ok, type Result } from "./contracts";

/**
 * 轻量应用目录检查。
 *
 * 官方客户端内部布局可能变化，安装器只依赖主程序与 Electron runtime；
 * 不把 app.asar/package.json 等内部文件名当作硬性安装门槛。
 */

export interface AppTreeReport {
  ok: boolean;
  mainExecutable: string | null;
  hasAsar: boolean;
  hasAppDir: boolean;
  runtimeFiles: string[];
  missing: string[];
  notes: string[];
}

export interface AppTreeOptions {
  /** 该产品已知的主程序文件名（来自 knownProducts），仅作优先匹配 */
  executableNames?: string[];
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function topLevelFiles(entries: string[]): string[] {
  return entries.map(normalize).filter((entry) => entry !== "" && !entry.endsWith("/") && !entry.includes("/"));
}

/** 基于归档/目录条目（相对路径列表）判定应用树是否完整 */
export function evaluateAppTree(entries: string[], options: AppTreeOptions = {}): AppTreeReport {
  const normalized = entries.map(normalize).filter((entry) => entry !== "");
  const topFiles = topLevelFiles(normalized);
  const lower = normalized.map((entry) => entry.toLowerCase());

  const executables = topFiles.filter((file) => file.toLowerCase().endsWith(".exe"));
  const preferred = options.executableNames ?? [];
  const mainExecutable =
    preferred.find((name) => executables.some((file) => file.toLowerCase() === name.toLowerCase())) ??
    executables.find((file) => /workbuddy/i.test(file)) ??
    executables[0] ??
    null;

  const hasAsar = lower.some((entry) => entry === "resources/app.asar");
  const hasAppDir = lower.some((entry) => entry === "resources/app/package.json" || entry === "resources/app/product.json");

  const runtimeFiles: string[] = [];
  for (const file of topFiles) {
    if (file.toLowerCase().endsWith(".dll")) runtimeFiles.push(file);
    if (file.toLowerCase().endsWith(".pak")) runtimeFiles.push(file);
  }
  for (const entry of normalized) {
    if (entry.toLowerCase().endsWith(".pak")) runtimeFiles.push(entry);
    if (entry.toLowerCase().endsWith(".bin") && entry.toLowerCase().startsWith("snapshot")) runtimeFiles.push(entry);
  }
  const uniqueRuntime = [...new Set(runtimeFiles)];

  const missing: string[] = [];
  if (!mainExecutable) missing.push("主可执行文件（顶层 .exe）");
  if (uniqueRuntime.length === 0) missing.push("Electron runtime（顶层 .dll / .pak / snapshot_blob.bin）");
  if (executables.length === 0) {
    // 已在上面记录，这里保持顺序稳定
  }

  const notes: string[] = [];
  if (executables.length > 1) notes.push(`顶层有 ${executables.length} 个可执行文件，选定 ${mainExecutable ?? "无"}`);
  if (hasAsar) notes.push("应用代码以 app.asar 打包");
  if (!hasAsar && hasAppDir) notes.push("应用代码以 resources/app 目录形式存在");

  return {
    ok: missing.length === 0,
    mainExecutable,
    hasAsar,
    hasAppDir,
    runtimeFiles: uniqueRuntime.slice(0, 12),
    missing,
    notes,
  };
}

export interface TreeReader {
  listDirectory(directory: string): Promise<string[]>;
  isFile(target: string): Promise<boolean>;
  isReparsePoint(target: string): Promise<boolean>;
}

/**
 * 对已落盘的目录做完整树判定（部署后核验）。
 *
 * 只按**相对路径逐个 stat**，不做深度递归——官方目录里 `resources/app.asar.unpacked`
 * 有数万文件，递归既慢又容易把大文件误判成目录。
 */
export async function evaluateAppDirectory(
  root: string,
  reader: TreeReader,
  options: AppTreeOptions = {},
): Promise<Result<AppTreeReport>> {
  const executors = options.executableNames?.length
    ? options.executableNames
    : ["WorkBuddy.exe", "WorkBuddyAI.exe"];
  const topLevel = await reader.listDirectory(root).catch(() => [] as string[]);

  const mainExecutable =
    executors.find((name) => topLevel.some((entry) => entry.toLowerCase() === name.toLowerCase())) ??
    topLevel.find((entry) => /^workbuddy(ai)?\.exe$/i.test(entry)) ??
    topLevel.find((entry) => entry.toLowerCase().endsWith(".exe") && !/uninstall|repair|update|crash/i.test(entry)) ??
    null;

  const hasAsar = await reader.isFile(path.join(root, "resources", "app.asar"));
  const hasAppDir =
    (await reader.isFile(path.join(root, "resources", "app", "package.json"))) ||
    (await reader.isFile(path.join(root, "resources", "app", "product.json")));

  const runtimeCandidates = ["resources.pak", "ffmpeg.dll", "libEGL.dll", "icudtl.dat", "snapshot_blob.bin"];
  const runtimeFiles: string[] = [];
  for (const candidate of runtimeCandidates) {
    if (await reader.isFile(path.join(root, candidate))) runtimeFiles.push(candidate);
  }
  if (runtimeFiles.length === 0) {
    // 退一步：顶层任意 dll / pak 也算 runtime 证据
    for (const entry of topLevel) {
      if (/\.(dll|pak)$/i.test(entry)) runtimeFiles.push(entry);
    }
  }

  const missing: string[] = [];
  if (!mainExecutable) missing.push("主可执行文件（顶部 WorkBuddy.exe / WorkBuddyAI.exe）");
  if (runtimeFiles.length === 0) missing.push("Electron runtime（resources.pak / *.dll）");

  if (missing.length > 0) {
    return fail(
      "E_PACKAGE_FORMAT",
      `应用目录不完整：缺少 ${missing.join("、")}（${root}）`,
      { missing, root, topLevel: topLevel.slice(0, 20) },
    );
  }

  const notes: string[] = [];
  if (hasAsar) notes.push("应用代码以 app.asar 打包");
  if (!hasAsar && hasAppDir) notes.push("应用代码以 resources/app 目录形式存在");
  if (topLevel.filter((entry) => /\.exe$/i.test(entry)).length > 1) {
    notes.push(`顶层有多个可执行文件，选定 ${mainExecutable}`);
  }

  return ok({
    ok: true,
    mainExecutable,
    hasAsar,
    hasAppDir,
    runtimeFiles: [...new Set(runtimeFiles)].slice(0, 12),
    missing: [],
    notes,
  });
}
