import { describe, expect, it } from "vitest";
import path from "node:path";
import { SevenZipAdapter } from "../../src/main/adapters/sevenZip";

describe("内置 7-Zip 路径", () => {
  it("开发态优先使用项目内置的官方组件", () => {
    const candidates = SevenZipAdapter.defaultCandidates("C:\\app", null);
    expect(candidates[0]).toBe(path.join("C:\\app", "resources", "7zip", "7za.exe"));
  });

  it("打包态从 Electron resources 下定位内置组件", () => {
    const candidates = SevenZipAdapter.defaultCandidates("C:\\app", "C:\\app\\resources");
    expect(candidates[0]).toBe(path.join("C:\\app\\resources", "7zip", "7za.exe"));
  });
});
