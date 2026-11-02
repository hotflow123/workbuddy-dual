import { describe, expect, it } from "vitest";
import {
  isDriveRoot,
  parseProcessOutput,
  parseProcessRows,
  resolveProcessCandidate,
} from "../../src/core/processPath";

describe("进程路径解析：盘符根与非法线索", () => {
  it("盘符根 + 客户端进程名不产生候选目录", () => {
    const result = resolveProcessCandidate({ path: "D:\\", name: "WorkBuddy.exe" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reject.reason).toBe("drive-root");
      expect(result.reject.detail).toContain("盘符根");
    }
  });

  it("目录路径、相对路径、无盘符路径都不是候选", () => {
    for (const [path, reason] of [
      ["D:\\Apps\\WorkBuddy", "not-executable"],
      ["Apps\\WorkBuddy\\WorkBuddy.exe", "not-absolute"],
      ["\\\\server\\share\\WorkBuddy.exe", "not-absolute"],
      ["", "empty-path"],
    ] as const) {
      const result = resolveProcessCandidate({ path, name: "WorkBuddy.exe" });
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.reject.reason).toBe(reason);
    }
  });

  it("卸载器、修复器、安装器、管理器自身都不是客户端安装", () => {
    for (const path of [
      "D:\\Apps\\WorkBuddy\\Uninstall WorkBuddy.exe",
      "D:\\Apps\\WorkBuddy\\RepairApp.exe",
      "D:\\Apps\\WorkBuddy\\WorkBuddySetup.exe",
      "D:\\Apps\\WorkBuddy\\WorkBuddy Dual Edition Manager.exe",
    ]) {
      const result = resolveProcessCandidate({ path, name: "WorkBuddy.exe" });
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.reject.reason).toBe("not-product-executable");
    }
  });

  it("临时解包目录被拒绝", () => {
    const result = resolveProcessCandidate(
      { path: "C:\\Users\\me\\AppData\\Local\\Temp\\wb-pack-123\\WorkBuddy.exe", name: "WorkBuddy.exe" },
      { tempDirectories: ["C:\\Users\\me\\AppData\\Local\\Temp"] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reject.reason).toBe("temp-directory");
  });

  it("真实客户端路径推导出父目录与产品", () => {
    const cn = resolveProcessCandidate({ path: "D:\\Apps\\WorkBuddy\\WorkBuddy.exe", name: "WorkBuddy.exe" });
    expect(cn.ok).toBe(true);
    if (cn.ok) {
      expect(cn.value.directory).toBe("D:\\Apps\\WorkBuddy");
      expect(cn.value.product).toBe("workbuddy-cn");
    }

    const ai = resolveProcessCandidate({ path: "H:\\Apps\\WorkBuddyAI\\WorkBuddyAI.exe", name: "WorkBuddyAI.exe" });
    expect(ai.ok).toBe(true);
    if (ai.ok) {
      expect(ai.value.directory).toBe("H:\\Apps\\WorkBuddyAI");
      expect(ai.value.product).toBe("workbuddy-ai");
    }
  });

  it("大小写与斜杠不影响判定", () => {
    const result = resolveProcessCandidate({ path: "d:/apps/workbuddy/WORKBUDDY.EXE", name: "WorkBuddy.exe" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.directory).toBe("d:\\apps\\workbuddy");
      expect(result.value.product).toBe("workbuddy-cn");
    }
  });
});

describe("isDriveRoot", () => {
  it("识别各种写法的盘符根", () => {
    for (const value of ["D:\\", "D:/", "D:", "c:\\"]) expect(isDriveRoot(value)).toBe(true);
  });

  it("普通目录不是盘符根", () => {
    for (const value of ["D:\\workbuddyCN", "D:\\Apps\\WorkBuddy", "\\\\server\\share"]) {
      expect(isDriveRoot(value)).toBe(false);
    }
  });
});

describe("进程输出解析", () => {
  it("解析数组与单对象", () => {
    expect(parseProcessRows([{ Name: "WorkBuddy.exe", ExecutablePath: "D:\\a\\WorkBuddy.exe" }])).toEqual([
      { path: "D:\\a\\WorkBuddy.exe", name: "WorkBuddy.exe" },
    ]);
    expect(parseProcessRows({ Name: "WorkBuddy.exe", ExecutablePath: "D:\\a\\WorkBuddy.exe" })).toEqual([
      { path: "D:\\a\\WorkBuddy.exe", name: "WorkBuddy.exe" },
    ]);
  });

  it("缺少路径的行被忽略；名字缺失时用文件名兜底", () => {
    expect(parseProcessRows([{ Name: "x" }, null, "nope"])).toEqual([]);
    expect(parseProcessRows([{ ExecutablePath: "D:\\a\\WorkBuddy.exe" }])).toEqual([
      { path: "D:\\a\\WorkBuddy.exe", name: "WorkBuddy.exe" },
    ]);
  });

  it("空输出、null、非法 JSON 返回空数组", () => {
    expect(parseProcessOutput("")).toEqual([]);
    expect(parseProcessOutput("null")).toEqual([]);
    expect(parseProcessOutput("{bad json")).toEqual([]);
  });
});
