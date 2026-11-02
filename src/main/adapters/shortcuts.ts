import { promises as fsp } from "node:fs";
import path from "node:path";
import { parseShortcutTarget } from "../../core/shortcut";
import type { ShortcutProvider } from "../../core/scanner";

/**
 * 只读枚举快捷方式：开始菜单（全局 + 当前用户）与桌面（公共 + 当前用户）。
 * 仅读取 .lnk 的目标路径，不执行快捷方式、不读取其参数或工作目录。
 */

const MAX_FILES = 500;
const MAX_DEPTH = 4;
const MAX_LINK_BYTES = 64 * 1024;

function candidateRoots(): string[] {
  const roots: string[] = [];
  const programData = process.env["PROGRAMDATA"];
  const appData = process.env["APPDATA"];
  const userProfile = process.env["USERPROFILE"];
  const publicDir = process.env["PUBLIC"];
  if (programData) roots.push(path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"));
  if (appData) roots.push(path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"));
  if (publicDir) roots.push(path.join(publicDir, "Desktop"));
  if (userProfile) roots.push(path.join(userProfile, "Desktop"));
  return roots;
}

async function walk(directory: string, depth: number, files: string[]): Promise<void> {
  if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(full, depth + 1, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".lnk")) {
      files.push(full);
    }
  }
}

export class WindowsShortcutReader implements ShortcutProvider {
  async list(): Promise<{ file: string; target: string | null }[]> {
    if (process.platform !== "win32") return [];
    const files: string[] = [];
    for (const root of candidateRoots()) {
      await walk(root, 0, files);
    }
    const results: { file: string; target: string | null }[] = [];
    for (const file of files) {
      try {
        const stat = await fsp.stat(file);
        if (!stat.isFile() || stat.size > MAX_LINK_BYTES) continue;
        const buffer = await fsp.readFile(file);
        results.push({ file, target: parseShortcutTarget(buffer) });
      } catch {
        results.push({ file, target: null });
      }
    }
    return results;
  }
}
