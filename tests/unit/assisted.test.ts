import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  compareAfterLaunch,
  deriveOperationAvailability,
  evaluateAssistedPackage,
  parseUninstallCommand,
  snapshotOf,
} from "../../src/core/assisted";
import type {
  InstallRecord,
  PackageCheck,
  ProductDiscovery,
  ProductId,
  ScanReport,
} from "../../src/core/contracts";
import { assistedInputSchema } from "../../src/shared/ipc";
import { AppService } from "../../src/main/services/appService";
import { NodeFsPort } from "../../src/main/adapters/fsPort";
import type { JournalStore } from "../../src/core/journal";

/* ------------------------------------------------------------------ 夹具 */

function record(overrides: Partial<InstallRecord> = {}): InstallRecord {
  return {
    id: "path:e:\\programs\\workbuddy",
    product: "workbuddy-cn",
    productHint: "workbuddy-cn",
    displayName: "WorkBuddy",
    displayVersion: "5.8.3",
    publisher: "Tencent",
    installLocation: "E:\\Programs\\workbuddy",
    locationSource: "shortcut",
    uninstallString: '"E:\\Programs\\workbuddy\\Uninstall WorkBuddy.exe"',
    primarySource: "shortcut",
    clues: [{ kind: "shortcut", source: "WorkBuddy", detail: "E:\\Programs\\workbuddy\\WorkBuddy.exe" }],
    discovery: "path-found",
    identity: "identified",
    identityCheck: {
      root: "E:\\Programs\\workbuddy",
      expected: "workbuddy-cn",
      verdict: "match",
      confidence: "observed",
      observedProductName: "WorkBuddy",
      observedVersion: "5.8.3",
      observedDataFolderName: null,
      metadataSource: "resources/app/package.json",
      fields: [],
      reasons: [],
    },
    duplicateRegistrations: 1,
    needsReview: false,
    isManagerSelf: false,
    conflicts: [],
    managedByTool: false,
    ...overrides,
  };
}

function discovery(product: ProductId, installs: InstallRecord[]): ProductDiscovery {
  return {
    product,
    installs,
    pendingPath: [],
    state: installs.length > 0 ? "found" : "not-found",
    copyCount: installs.length,
  };
}

function packageCheck(overrides: Partial<PackageCheck> = {}): PackageCheck {
  return {
    file: "E:\\downloads\\WorkBuddySetup.exe",
    sizeBytes: 1024 * 1024,
    sha256: "a".repeat(64),
    authenticode: {
      status: "Valid",
      signerSubject: "CN=Tencent Technology (Shenzhen) Company Limited",
      signerThumbprint: "ABC",
      notAfter: "2027-01-01T00:00:00Z",
      chainOk: true,
    },
    productName: "WorkBuddy",
    productVersion: "5.8.3",
    verdict: "valid",
    reasons: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ 卸载命令解析 */

describe("parseUninstallCommand", () => {
  it("解析带引号的卸载程序路径", () => {
    const parsed = parseUninstallCommand('"C:\\Program Files\\WorkBuddy\\uninst.exe" --flag', {});
    expect(parsed.kind).toBe("direct-exe");
    expect(parsed.executable).toBe("C:\\Program Files\\WorkBuddy\\uninst.exe");
  });

  it("解析无引号但含空格的路径", () => {
    const parsed = parseUninstallCommand("C:\\Program Files\\WorkBuddy\\uninst.exe /S", {});
    expect(parsed.kind).toBe("direct-exe");
    expect(parsed.executable).toBe("C:\\Program Files\\WorkBuddy\\uninst.exe");
  });

  it("展开 %VAR% 形式的环境变量", () => {
    const parsed = parseUninstallCommand('"%LOCALAPPDATA%\\WorkBuddy\\uninst.exe"', {
      LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
    });
    expect(parsed.executable).toBe("C:\\Users\\someone\\AppData\\Local\\WorkBuddy\\uninst.exe");
  });

  it("Windows Installer 托管时不提供可启动路径", () => {
    const parsed = parseUninstallCommand("MsiExec.exe /X{11111111-2222-3333-4444-555555555555}", {});
    expect(parsed.kind).toBe("msiexec");
    expect(parsed.executable).toBeNull();
    expect(parsed.detail).toContain("手动卸载");
  });

  it("系统解释器不代执行", () => {
    const parsed = parseUninstallCommand("rundll32.exe appwiz.cpl,RemoveProgram", {});
    expect(parsed.kind).toBe("system-executor");
    expect(parsed.executable).toBeNull();
  });

  it("空卸载命令", () => {
    expect(parseUninstallCommand(null, {}).kind).toBe("empty");
    expect(parseUninstallCommand("   ", {}).kind).toBe("empty");
  });
});

/* ------------------------------------------------------------------ 能力派生 */

describe("deriveOperationAvailability", () => {
  it("没有安装时：安装可辅助，更新与卸载只给指引", () => {
    const list = deriveOperationAvailability({
      product: "workbuddy-cn",
      discovery: discovery("workbuddy-cn", []),
      onlineVerified: false,
    });
    expect(list.map((item) => item.kind)).toEqual(["install", "update", "uninstall"]);
    expect(list[0]!.state).toBe("assisted");
    expect(list[1]!.state).toBe("guidance-only");
    expect(list[2]!.state).toBe("guidance-only");
  });

  it("单副本：安装/更新可辅助，更新必须指定实例", () => {
    const list = deriveOperationAvailability({
      product: "workbuddy-cn",
      discovery: discovery("workbuddy-cn", [record()]),
      onlineVerified: false,
      exists: () => true,
    });
    const [install, update, uninstall] = list;
    expect(install!.state).toBe("assisted");
    expect(install!.requiresTarget).toBe(false);
    expect(update!.state).toBe("assisted");
    expect(update!.requiresTarget).toBe(true);
    expect(update!.reason).toContain("未配置已核验的官方在线更新来源");
    expect(uninstall!.state).toBe("assisted");
    expect(uninstall!.targets[0]!.uninstallerPath).toBe("E:\\Programs\\workbuddy\\Uninstall WorkBuddy.exe");
  });

  it("多副本：更新降级为手动指引，卸载按实例分别开放", () => {
    const second = record({ id: "path:e:\\workbuddy-cn", installLocation: "E:\\WorkBuddy-CN" });
    const list = deriveOperationAvailability({
      product: "workbuddy-cn",
      discovery: discovery("workbuddy-cn", [record(), second]),
      onlineVerified: true,
      exists: () => true,
    });
    const [install, update, uninstall] = list;
    expect(install!.state).toBe("assisted");
    expect(install!.reason).toContain("不会替你选择目标");
    expect(update!.state).toBe("guidance-only");
    expect(update!.reason).toContain("无法被可靠约束");
    expect(uninstall!.state).toBe("assisted");
    expect(uninstall!.targets).toHaveLength(2);
    expect(uninstall!.reason).toContain("逐个选择");
  });

  it("存在需人工确认的记录时阻止安装与更新", () => {
    const list = deriveOperationAvailability({
      product: "workbuddy-cn",
      discovery: discovery("workbuddy-cn", [record({ needsReview: true, identity: "conflict" })]),
      onlineVerified: true,
      exists: () => true,
    });
    expect(list[0]!.state).toBe("blocked");
    expect(list[1]!.state).toBe("blocked");
  });

  it("卸载命令由 Windows Installer 托管时只给指引", () => {
    const list = deriveOperationAvailability({
      product: "workbuddy-cn",
      discovery: discovery("workbuddy-cn", [record({ uninstallString: "MsiExec.exe /X{GUID}" })]),
      onlineVerified: false,
      exists: () => true,
    });
    expect(list[2]!.state).toBe("guidance-only");
    expect(list[2]!.targets[0]!.uninstallerPath).toBeNull();
  });

  it("卸载程序文件不存在时不提供启动入口", () => {
    const list = deriveOperationAvailability({
      product: "workbuddy-cn",
      discovery: discovery("workbuddy-cn", [record()]),
      onlineVerified: false,
      exists: () => false,
    });
    expect(list[2]!.state).toBe("guidance-only");
    expect(list[2]!.targets[0]!.uninstallerDetail).toContain("不存在");
  });
});

/* ------------------------------------------------------------------ 安装包判定 */

describe("evaluateAssistedPackage（0.6.1：签名只作诊断）", () => {
  const baseline = {
    source: "observed-install" as const,
    subjects: ["CN=Tencent Technology (Shenzhen) Company Limited"],
  };

  it("NotSigned 但产品身份可读时允许部署", () => {
    const verdict = evaluateAssistedPackage(
      packageCheck({ authenticode: { ...packageCheck().authenticode!, status: "NotSigned", signerSubject: null } }),
      baseline,
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.reasons.join("；")).toContain("仅诊断");
  });

  it("Unknown 签名状态不阻断", () => {
    const verdict = evaluateAssistedPackage(
      packageCheck({ authenticode: { ...packageCheck().authenticode!, status: "Unknown" } }),
      baseline,
    );
    expect(verdict.allowed).toBe(true);
  });

  it("证书换签（发布者/指纹变化）不阻断", () => {
    const verdict = evaluateAssistedPackage(
      packageCheck({
        authenticode: { ...packageCheck().authenticode!, signerSubject: "CN=Another Signer Ltd", signerThumbprint: "FFEE" },
      }),
      baseline,
    );
    expect(verdict.allowed).toBe(true);
  });

  it("没有发布者基线也能继续", () => {
    const verdict = evaluateAssistedPackage(packageCheck(), { source: "none", subjects: [] });
    expect(verdict.allowed).toBe(true);
  });

  it("归档/哈希致命问题仍然拒绝", () => {
    const verdict = evaluateAssistedPackage(
      packageCheck({ verdict: "invalid", reasons: ["归档包含路径穿越"] }),
      baseline,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join("；")).toContain("路径穿越");
  });

  it("包内没有产品名时拒绝（无法确认产品）", () => {
    const verdict = evaluateAssistedPackage(packageCheck({ productName: null, verdict: "unknown" }), baseline);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join("；")).toContain("产品名称");
  });
});

/* ------------------------------------------------------------------ 复扫对比 */

describe("compareAfterLaunch", () => {
  it("版本变化且另一版未变才算确认", () => {
    const result = compareAfterLaunch(
      "update",
      { version: "5.8.2", paths: ["E:\\a"] },
      { version: "5.8.3", paths: ["E:\\a"] },
      { version: "5.8.4", paths: ["F:\\b"] },
      { version: "5.8.4", paths: ["F:\\b"] },
      "workbuddy-cn",
    );
    expect(result.rescanConfirmed).toBe(true);
    expect(result.counterpartChanged).toBe(false);
  });

  it("另一版也变化时不能宣称成功", () => {
    const result = compareAfterLaunch(
      "install",
      { version: null, paths: [] },
      { version: "5.8.3", paths: ["E:\\a"] },
      { version: "5.8.4", paths: ["F:\\b"] },
      { version: null, paths: [] },
      "workbuddy-cn",
    );
    expect(result.rescanConfirmed).toBe(false);
    expect(result.counterpartChanged).toBe(true);
    expect(result.notes.join("；")).toContain("人工确认");
  });

  it("卸载后仍能检测到原路径时不算完成", () => {
    const result = compareAfterLaunch(
      "uninstall",
      { version: "5.8.3", paths: ["E:\\a"] },
      { version: "5.8.3", paths: ["E:\\a"] },
      { version: "5.8.4", paths: ["F:\\b"] },
      { version: "5.8.4", paths: ["F:\\b"] },
      "workbuddy-cn",
    );
    expect(result.rescanConfirmed).toBe(false);
    expect(result.notes.join("；")).toContain("残留");
  });

  it("卸载后路径消失且另一版未变时确认完成", () => {
    const result = compareAfterLaunch(
      "uninstall",
      { version: "5.8.3", paths: ["E:\\a"] },
      { version: null, paths: [] },
      { version: "5.8.4", paths: ["F:\\b"] },
      { version: "5.8.4", paths: ["F:\\b"] },
      "workbuddy-cn",
    );
    expect(result.rescanConfirmed).toBe(true);
  });

  it("snapshotOf 只汇总目标产品", () => {
    const report = {
      scannedAt: "2026-10-18T00:00:00Z",
      readOnly: true as const,
      records: [],
      skippedSources: [],
      conflicts: [],
      sources: [],
      products: [discovery("workbuddy-cn", [record()]), discovery("workbuddy-ai", [])],
    } satisfies ScanReport;
    expect(snapshotOf(report, "workbuddy-cn")).toEqual({ version: "5.8.3", paths: ["E:\\Programs\\workbuddy"] });
    expect(snapshotOf(report, "workbuddy-ai")).toEqual({ version: null, paths: [] });
  });
});


/* ------------------------------------------------------------------ 诊断导出 */

describe("诊断导出不再输出辅助/可用性旧字段", () => {
  it("schemaVersion 4 且没有 availability / assisted", async () => {
    const { buildDiagnostics } = await import("../../src/core/diagnostics");
    const payload = buildDiagnostics({
      generatedAt: "2026-10-18T00:00:00.000Z",
      exportStartedAt: "2026-10-18T00:00:00.000Z",
      appVersion: "0.6.3-test",
      platform: "win32",
      portable: false,
      deployment: { install: true, update: true, uninstall: true, builtInUpdateControl: false },
      buildId: "b-1",
      buildTime: "2026-10-19T00:00:00.000Z",
      packaged: false,
      scan: null,
      scanStatus: {
        status: "failed",
        startedAt: "2026-10-18T00:00:00.000Z",
        scannedAt: null,
        durationMs: 1,
        failure: { code: "E_TEST", message: "test" },
      },
      managedInstances: [],
      scanToManaged: [],
      recentOperations: [],
      recentErrors: [],
      history: {
        state: "no-history",
        journalReadable: true,
        journalTotal: 0,
        errorLogReadable: true,
        errorLogTotal: 0,
        errorLogCorrupted: 0,
        notes: [],
      },
      instanceRegistry: { source: "file", readable: true, count: 0 },
      errorLogDirectory: null,
      settings: { managementRoot: "C:\\managed", userScanRoots: [] },
    });
    expect(payload["schemaVersion"]).toBe(4);
    expect(payload["availability"]).toBeUndefined();
    expect(payload["assisted"]).toBeUndefined();
    expect((payload["deploymentCapabilities"] as Record<string, unknown>)["install"]).toBe(true);
  });
});
