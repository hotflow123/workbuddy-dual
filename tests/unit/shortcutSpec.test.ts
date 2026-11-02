import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildShortcutSpec, SHORTCUT_NAMES } from "../../src/core/shortcutSpec";

const DIR = "C:\\wb-test\\WorkBuddy-CN\\versions\\5.8.3";

describe("buildShortcutSpec", () => {
  it("国内版快捷方式名称固定为中文括号形式", () => {
    const result = buildShortcutSpec({
      product: "workbuddy-cn",
      directory: DIR,
      executableRelativePath: "WorkBuddy.exe",
      exists: () => true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.name).toBe("WorkBuddy（国内版）.lnk");
      expect(result.spec.target).toBe(path.join(DIR, "WorkBuddy.exe"));
      expect(result.spec.workingDirectory).toBe(path.resolve(DIR));
      expect(result.spec.icon).toBe(result.spec.target);
    }
  });

  it("国际版名称与主程序各自独立", () => {
    const result = buildShortcutSpec({
      product: "workbuddy-ai",
      directory: "D:\\Apps\\AI",
      executableRelativePath: "WorkBuddyAI.exe",
      exists: () => true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.name).toBe(SHORTCUT_NAMES["workbuddy-ai"]);
      expect(result.spec.name).toContain("国际版");
      expect(result.spec.target).toContain("WorkBuddyAI.exe");
    }
  });

  it("未识别主程序时拒绝创建", () => {
    const result = buildShortcutSpec({
      product: "workbuddy-cn",
      directory: DIR,
      executableRelativePath: null,
      exists: () => true,
    });
    expect(result.ok).toBe(false);
  });

  it("主程序不存在时拒绝创建", () => {
    const result = buildShortcutSpec({
      product: "workbuddy-cn",
      directory: DIR,
      executableRelativePath: "WorkBuddy.exe",
      exists: () => false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("主程序不存在");
  });

  it("相对路径逃出实例目录时拒绝", () => {
    const result = buildShortcutSpec({
      product: "workbuddy-cn",
      directory: DIR,
      executableRelativePath: "..\\..\\Windows\\System32\\cmd.exe",
      exists: () => true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("越出");
  });

  it("只有 C 盘时也能生成（不依赖固定盘符）", () => {
    const result = buildShortcutSpec({
      product: "workbuddy-ai",
      directory: "C:\\Users\\me\\AppData\\Local\\Programs\\WorkBuddyAI",
      executableRelativePath: "WorkBuddyAI.exe",
      exists: () => true,
    });
    expect(result.ok).toBe(true);
  });
});
