import { promises as fsp } from "node:fs";
import path from "node:path";
import type { CommonLocationProvider } from "../../core/scanner";

/**
 * 有界常见安装位置：只看三个标准目录的**直接子目录**，并按名称相关性过滤。
 * 不做全盘递归、不遍历用户文档/桌面数据。
 */

function roots(): { path: string; label: string }[] {
  const list: { path: string; label: string }[] = [];
  const localAppData = process.env["LOCALAPPDATA"];
  const programFiles = process.env["ProgramFiles"];
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (localAppData) list.push({ path: path.join(localAppData, "Programs"), label: "%LOCALAPPDATA%\\Programs" });
  if (programFiles) list.push({ path: programFiles, label: "%ProgramFiles%" });
  if (programFilesX86) list.push({ path: programFilesX86, label: "%ProgramFiles(x86)%" });
  return list;
}

export class WindowsCommonLocationReader implements CommonLocationProvider {
  async list(): Promise<{ path: string; source: string }[]> {
    if (process.platform !== "win32") return [];
    const results: { path: string; source: string }[] = [];
    for (const root of roots()) {
      let entries;
      try {
        entries = await fsp.readdir(root.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.toLowerCase().includes("workbuddy")) continue;
        const candidate = path.join(root.path, entry.name);
        try {
          const stat = await fsp.stat(candidate);
          if (!stat.isDirectory()) continue;
        } catch {
          continue;
        }
        results.push({ path: candidate, source: root.label });
      }
    }
    return results;
  }
}
