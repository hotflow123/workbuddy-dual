import os from "node:os";
import path from "node:path";
import { existsSync, promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppService } from "../../src/main/services/appService";
import { NodeFsPort } from "../../src/main/adapters/fsPort";
import { SevenZipAdapter } from "../../src/main/adapters/sevenZip";
import type { JournalStore } from "../../src/core/journal";
import type { ScanReport } from "../../src/core/contracts";

/**
 * 用**真实官方安装包**在隔离管理根里跑完整安装流程（services 层，不经过 UI）。
 *
 * 开关：WB_REAL_INSTALL=1（默认跳过，避免常规测试变慢）。
 * 只写 artifacts 下的隔离目录，不触碰用户已安装客户端。
 */
const PACKAGE_DIR = path.join(process.cwd(), "artifacts", "official-packages");
const CN_PACKAGE = path.join(PACKAGE_DIR, "workbuddy-cn-setup.exe");
const enabled = process.env["WB_REAL_INSTALL"] === "1" && existsSync(CN_PACKAGE);
const sevenZip = SevenZipAdapter.resolve(SevenZipAdapter.defaultCandidates(process.cwd(), null));
const maybe = enabled && sevenZip ? describe : describe.skip;

function memoryJournal(): JournalStore {
  const store = new Map<string, import("../../src/core/contracts").OperationRecord>();
  return {
    read: async (id) => store.get(id) ?? null,
    write: async (record) => {
      store.set(record.operationId, record);
    },
    list: async () => [...store.values()],
  };
}

function emptyReport(): ScanReport {
  return {
    scannedAt: "2026-10-19T00:00:00.000Z",
    readOnly: true,
    records: [],
    skippedSources: [],
    conflicts: [],
    products: [
      { product: "workbuddy-cn", installs: [], pendingPath: [], state: "not-found", copyCount: 0 },
      { product: "workbuddy-ai", installs: [], pendingPath: [], state: "not-found", copyCount: 0 },
    ],
    sources: [],
  };
}

maybe("真实官方包隔离安装（services 层）", () => {
  it("国内版官方包可安装到隔离管理根并自动登记", async () => {
    const base = path.join(process.cwd(), "artifacts", "real-install");
    const stateDir = path.join(base, "state");
    const managementRoot = path.join(base, "managed");
    await fsp.mkdir(managementRoot, { recursive: true });

    const service = new AppService({
      appVersion: "0.6.0-test",
      stateDir,
      managementRoot,
      isWindows: true,
      portable: false,
      selfDirectories: [],
      fs: new NodeFsPort(),
      registry: { readUninstallEntries: async () => ({ entries: [], skipped: [] }) },
      journal: memoryJournal(),
      now: () => new Date().toISOString(),
      bundledEvidenceFile: path.join(stateDir, "missing.json"),
      configDirectory: path.join(base, "config"),
      archive: sevenZip!,
      // 真实签名读取已在 e2e 探针验证过；这里固定官方包的实测值，专注于部署管线
      inspectFile: async () => ({
        authenticode: {
          status: "Valid",
          signerSubject: "CN=Tencent Technology (Shenzhen) Company Limited",
          signerThumbprint: "2241B013E2D6B9AAD7590E8056BF5E17CB1C795B",
          notAfter: "2027-01-01T00:00:00Z",
          chainOk: true,
        },
        versionInfo: { productName: "WorkBuddy", fileDescription: "WorkBuddy", fileVersion: "5.8.3" },
      }),
      env: {},
      scanImplementation: async () => emptyReport(),
    });
    await service.init();
    await service.scan();

    const result = await service.installFromPackage({
      product: "workbuddy-cn",
      packagePath: CN_PACKAGE,
    });
    expect(result.ok, result.ok ? "" : `${result.error.code}: ${result.error.message}`).toBe(true);
    if (!result.ok) return;

    const directory = result.value.instance.directory;
    const fsPort = new NodeFsPort();
    // 计划要求的完整应用树
    expect(await fsPort.isFile(path.join(directory, "WorkBuddy.exe"))).toBe(true);
    expect(await fsPort.isFile(path.join(directory, "resources", "app.asar"))).toBe(true);
    expect(await fsPort.isFile(path.join(directory, "resources.pak"))).toBe(true);
    const entries = await fsp.readdir(directory);
    expect(entries).toContain("locales");

    // 安装后自动登记，实例立即可见
    const instances = await service.listInstances();
    expect(instances.some((item) => item.instanceId === result.value.instance.instanceId)).toBe(true);
    const state = await service.getState();
    expect(state.instances.length).toBeGreaterThan(0);

    console.log(`真实安装目录：${directory}`);
  }, 900_000);
});
