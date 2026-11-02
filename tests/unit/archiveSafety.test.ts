import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARCHIVE_LIMITS,
  isSafeEntryPath,
  validateArchiveEntries,
  validateExtractedTree,
  type ArchiveEntry,
  type TreeProbe,
} from "../../src/core/archiveSafety";
import { evaluateAppTree } from "../../src/core/appTree";

function entry(path: string, size = 10, attributes = "A"): ArchiveEntry {
  return { path, size, attributes, isDirectory: false };
}

describe("归档条目路径安全", () => {
  it("接受正常相对路径", () => {
    expect(isSafeEntryPath("resources/app/package.json").ok).toBe(true);
    expect(isSafeEntryPath("WorkBuddy.exe").ok).toBe(true);
  });

  it("拒绝路径穿越、绝对路径、UNC 与设备命名空间", () => {
    for (const bad of [
      "../evil.exe",
      "resources/../../evil.exe",
      "C:\\Windows\\evil.exe",
      "/etc/passwd",
      "//server/share/evil.exe",
      "\\\\?\\C:\\evil.exe",
      "\\\\.\\PhysicalDrive0",
    ]) {
      expect(isSafeEntryPath(bad).ok, bad).toBe(false);
    }
  });

  it("拒绝 Windows 保留设备名", () => {
    expect(isSafeEntryPath("CON").ok).toBe(false);
    expect(isSafeEntryPath("resources/NUL.txt").ok).toBe(false);
  });

  it("拒绝过深与过长路径", () => {
    const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join("/");
    expect(isSafeEntryPath(deep).ok).toBe(false);
    const long = `resources/${"a".repeat(DEFAULT_ARCHIVE_LIMITS.maxPathLength)}`;
    expect(isSafeEntryPath(long).ok).toBe(false);
  });
});

describe("归档清单校验", () => {
  it("正常清单通过", () => {
    const result = validateArchiveEntries([entry("WorkBuddy.exe"), entry("resources/app.asar")]);
    expect(result.ok).toBe(true);
  });

  it("危险条目、链接条目、重复条目一并拒绝", () => {
    const result = validateArchiveEntries([
      entry("../evil.exe"),
      entry("resources/link.dll", 0, "l"),
      entry("a.txt"),
      entry("A.TXT"),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = result.error.message;
      expect(text).toContain("路径穿越");
      expect(text).toContain("链接条目");
      expect(text).toContain("重复条目");
    }
  });

  it("超过条目数上限拒绝", () => {
    const many = Array.from({ length: 5 }, (_, i) => entry(`f${i}.bin`, 1));
    const result = validateArchiveEntries(many, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 3 });
    expect(result.ok).toBe(false);
  });

  it("超过解压体积上限拒绝", () => {
    const result = validateArchiveEntries([entry("big.bin", 2048)], {
      ...DEFAULT_ARCHIVE_LIMITS,
      maxTotalBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("体积");
  });
});

describe("解包结果复核", () => {
  it("正常目录通过", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-tree-ok-"));
    await fsp.mkdir(path.join(root, "resources", "app"), { recursive: true });
    await fsp.writeFile(path.join(root, "resources", "app", "package.json"), "{}", "utf8");
    await fsp.writeFile(path.join(root, "WorkBuddy.exe"), "x", "utf8");

    const probe: TreeProbe = {
      listDirectory: (dir) => fsp.readdir(dir),
      isReparsePoint: async () => false,
      stat: async (target) => {
        try {
          const stat = await fsp.stat(target);
          return { size: stat.size, isDirectory: stat.isDirectory() };
        } catch {
          return null;
        }
      },
    };
    const result = await validateExtractedTree(root, probe);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.files).toBe(2);
  });

  it("发现重解析点即拒绝", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-tree-link-"));
    await fsp.writeFile(path.join(root, "a.txt"), "x", "utf8");
    const probe: TreeProbe = {
      listDirectory: (dir) => fsp.readdir(dir),
      isReparsePoint: async (target) => target.endsWith("a.txt"),
      stat: async () => ({ size: 1, isDirectory: false }),
    };
    const result = await validateExtractedTree(root, probe);
    expect(result.ok).toBe(false);
  });

  it("超出体积上限即拒绝", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-tree-big-"));
    await fsp.writeFile(path.join(root, "big.bin"), "x", "utf8");
    const probe: TreeProbe = {
      listDirectory: (dir) => fsp.readdir(dir),
      isReparsePoint: async () => false,
      stat: async () => ({ size: 4096, isDirectory: false }),
    };
    const result = await validateExtractedTree(root, probe, { ...DEFAULT_ARCHIVE_LIMITS, maxTotalBytes: 1024 });
    expect(result.ok).toBe(false);
  });
});

describe("完整应用树判定", () => {
  const complete = [
    "WorkBuddy.exe",
    "ffmpeg.dll",
    "resources/app.asar",
    "locales/zh-CN.pak",
  ];

  it("主 exe + 应用代码 + runtime 齐全时通过", () => {
    const report = evaluateAppTree(complete);
    expect(report.ok).toBe(true);
    expect(report.mainExecutable).toBe("WorkBuddy.exe");
    expect(report.hasAsar).toBe(true);
  });

  it("缺主 exe 时不通过", () => {
    const report = evaluateAppTree(["ffmpeg.dll", "resources/app.asar"]);
    expect(report.ok).toBe(false);
    expect(report.missing.join()).toContain("主可执行文件");
  });

  it("不因官方包内部应用代码文件名变化而阻断", () => {
    const report = evaluateAppTree(["WorkBuddy.exe", "ffmpeg.dll"]);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it("缺 Electron runtime 时不通过", () => {
    const report = evaluateAppTree(["WorkBuddy.exe", "resources/app.asar"]);
    expect(report.ok).toBe(false);
    expect(report.missing.join()).toContain("Electron runtime");
  });
});
