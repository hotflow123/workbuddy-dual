import path from "node:path";
import type { ProductId } from "./contracts";

/**
 * 桌面快捷方式的规格（纯函数，便于测试）。
 * 名称与目标都由产品决定，不接受渲染进程传入的任意路径。
 */

export const SHORTCUT_NAMES: Record<ProductId, string> = {
  "workbuddy-cn": "WorkBuddy（国内版）.lnk",
  "workbuddy-ai": "WorkBuddy AI（国际版）.lnk",
};

export interface ShortcutSpec {
  /** 桌面上的文件名，含 .lnk */
  name: string;
  /** 快捷方式目标：实例目录内的主程序 */
  target: string;
  /** 工作目录：实例目录 */
  workingDirectory: string;
  /** 图标：优先主程序本身 */
  icon: string | null;
}

export type ShortcutSpecResult =
  | { ok: true; spec: ShortcutSpec }
  | { ok: false; reason: string };

/**
 * 生成快捷方式规格。要求：
 *  - 主程序相对路径已知；
 *  - 拼接后的目标仍位于实例目录内（防目录穿越）；
 *  - 主程序确实存在（由调用方通过 exists 注入，避免在纯函数里碰文件系统）。
 */
export function buildShortcutSpec(input: {
  product: ProductId;
  directory: string;
  executableRelativePath: string | null;
  exists: (target: string) => boolean;
}): ShortcutSpecResult {
  const { product, directory, executableRelativePath, exists } = input;
  if (!executableRelativePath) {
    return { ok: false, reason: "未识别到主程序相对路径，无法创建快捷方式" };
  }
  const base = path.resolve(directory);
  const target = path.resolve(base, executableRelativePath);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, reason: "主程序路径越出实例目录，已拒绝创建快捷方式" };
  }
  if (!exists(target)) {
    return { ok: false, reason: `主程序不存在：${executableRelativePath}` };
  }
  return {
    ok: true,
    spec: {
      name: SHORTCUT_NAMES[product],
      target,
      workingDirectory: base,
      icon: target,
    },
  };
}
