import path from "node:path";
import type { PackageFormat } from "./contracts";

/**
 * 安装包格式识别（纯函数，便于单测）。
 *
 * 只根据「扩展名 + 归档条目列表」判断，不执行安装包，也不依赖文件名里的产品名。
 * 无法判定时返回 unknown —— 调用方必须 fail-closed。
 */

const INNER_ARCHIVE = /\.(7z|zip)$/i;
const ELECTRON_APP_MARKER = /(^|\/)resources[\\/]app[\\/](package\.json|product\.json|app\.asar)$/i;
const ASAR_MARKER = /(^|\/)resources[\\/]app\.asar$/i;

export function classifyPackage(file: string, entries: string[]): PackageFormat {
  const extension = path.extname(file).toLowerCase();
  const normalized = entries.map((entry) => entry.replace(/\\/g, "/"));

  const hasNsisMarkers =
    normalized.some((entry) => /^\$PLUGINSDIR\//i.test(entry)) ||
    normalized.some((entry) => /(^|\/)app-\d+(\.\d+)?\.7z$/i.test(entry)) ||
    normalized.some((entry) => /^\[NSIS\]/i.test(entry));
  if (hasNsisMarkers) return "nsis";

  const hasAppTree =
    normalized.some((entry) => ELECTRON_APP_MARKER.test(entry)) ||
    normalized.some((entry) => ASAR_MARKER.test(entry)) ||
    (normalized.some((entry) => /\.exe$/i.test(entry)) && normalized.some((entry) => /(^|\/)resources\//i.test(entry)));

  if (extension === ".7z") return "7z";
  if (extension === ".zip") return "zip";
  if (hasAppTree) return "nsis";
  if (extension === ".exe") return "nsis";
  return "unknown";
}

/** NSIS/7z 包装里可能再套一层归档（electron-builder 常见为 app-64.7z）。 */
export function findInnerArchive(entries: string[]): string | null {
  const normalized = entries.map((entry) => entry.replace(/\\/g, "/"));
  // Some current official packages expose the complete Electron tree directly,
  // while containing unrelated archives (for example resources/vendor/node.zip).
  // Never descend into those when the app tree is already present.
  if (findAppRoot(normalized) !== null) return null;

  const archives = normalized.filter((entry) => INNER_ARCHIVE.test(entry) && !entry.endsWith("/"));
  if (archives.length === 0) return null;
  const preferred = archives.find((entry) => /(^|\/)app-\d+(\.\d+)?\.7z$/i.test(entry));
  if (preferred) return preferred;

  // Only consider payload archives at the outer package level or in NSIS's
  // plugin directory; nested app dependencies are not installer payloads.
  const payloads = archives.filter((entry) => {
    const parts = entry.split("/");
    return parts.length === 1 || /^\$PLUGINSDIR$/i.test(parts[0] ?? "");
  });
  return payloads.sort((a, b) => a.split("/").length - b.split("/").length)[0] ?? null;
}

/**
 * 解包后定位真正的应用根目录：包含 `resources/app/**` 的那一层。
 * 返回相对路径（"" 表示解包根目录本身就是应用根）。
 */
export function findAppRoot(entries: string[]): string | null {
  const normalized = entries.map((entry) => entry.replace(/\\/g, "/"));
  const markers = normalized.filter(
    (entry) => ELECTRON_APP_MARKER.test(entry) || ASAR_MARKER.test(entry),
  );
  if (markers.length === 0) return null;
  const depths = markers.map((marker) => {
    const index = marker.toLowerCase().indexOf("resources/");
    return index <= 0 ? "" : marker.slice(0, Math.max(0, index - 1));
  });
  // 选最浅的一个作为应用根
  return depths.sort((a, b) => a.split("/").filter(Boolean).length - b.split("/").filter(Boolean).length)[0] ?? "";
}

/** 判断解包目录里是否像 Electron 应用（用于部署前预检） */
export function looksLikeElectronApp(entries: string[]): boolean {
  return findAppRoot(entries) !== null;
}
