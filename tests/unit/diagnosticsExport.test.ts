import { describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppService } from "../../src/main/services/appService";
import { NodeFsPort } from "../../src/main/adapters/fsPort";
import { FileErrorLog } from "../../src/main/errorLog";
import type { JournalStore } from "../../src/core/journal";
import type { OperationRecord, ScanReport } from "../../src/core/contracts";
import type { ArchivePort } from "../../src/main/adapters/sevenZip";

function memoryJournal(): JournalStore {
  const store = new Map<string, OperationRecord>();
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
    scannedAt: "2026-10-18T12:00:00.000Z",
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

const fakeArchive: ArchivePort = {
  list: async () => [],
  extract: async () => {
    throw new Error("diagnostics 测试不应解包");
  },
};

/**
 * 导出诊断的服务级测试：验证“导出前真的重新扫描”“登记实例单独输出”
 * “journal 为空时错误日志仍能成为最近操作”。
 */

interface Built {
  service: AppService;
  root: string;
  stateDir: string;
  errorLog: FileErrorLog;
  scans: () => number;
}

async function build(options: {
  scan?: () => Promise<unknown>;
  now?: () => string;
} = {}): Promise<Built> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-diagexport-"));
  const stateDir = path.join(root, "state");
  await fsp.mkdir(stateDir, { recursive: true });
  const managementRoot = path.join(root, "managed");
  const errorLog = new FileErrorLog(path.join(stateDir, "errors"), () => "2026-10-18T12:00:00.000Z");
  let scans = 0;
  const service = new AppService({
    appVersion: "0.6.3-test",
    stateDir,
    managementRoot,
    isWindows: true,
    portable: false,
    selfDirectories: [],
    fs: new NodeFsPort(),
    registry: { readUninstallEntries: async () => ({ entries: [], skipped: [] }) },
    journal: memoryJournal(),
    now: options.now ?? (() => "2026-10-18T12:00:00.000Z"),
    bundledEvidenceFile: path.join(stateDir, "missing.json"),
    configDirectory: path.join(root, "config"),
    archive: fakeArchive,
    inspectFile: async () => ({
      authenticode: { status: "Valid", signerSubject: "CN=Tencent", signerThumbprint: "ABC", notAfter: null, chainOk: true },
      versionInfo: { productName: "WorkBuddy", fileDescription: "WorkBuddy", fileVersion: "5.8.3" },
    }),
    env: {},
    scanImplementation: async () => {
      scans += 1;
      return options.scan ? ((await options.scan()) as never) : emptyReport();
    },
    errorLog,
  });
  await service.init();
  return { service, root, stateDir, errorLog, scans: () => scans };
}

async function exportJson(service: AppService, root: string): Promise<Record<string, unknown>> {
  const outDir = path.join(root, "out");
  await fsp.mkdir(outDir, { recursive: true });
  const result = await service.exportDiagnostics(outDir);
  expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return JSON.parse(await fsp.readFile(result.value, "utf8"));
}

describe("导出诊断：真实扫描与登记关联", () => {
  it("导出会触发一次新的扫描，时间戳来自本次扫描", async () => {
    const built = await build();
    const before = built.scans();
    const payload = await exportJson(built.service, built.root);
    expect(built.scans()).toBe(before + 1);

    const scan = payload["scan"] as Record<string, unknown>;
    expect(scan["status"]).toBe("ok");
    expect(typeof scan["scannedAt"]).toBe("string");
    expect(scan["startedAt"]).toBe("2026-10-18T12:00:00.000Z");
    expect(payload["schemaVersion"]).toBe(4);
    expect(payload["diagnosticsBuildId"]).toBe(payload["build"] && (payload["build"] as Record<string, unknown>)["id"]);
  });

  it("扫描失败时标记 failed，不回退到旧扫描结果", async () => {
    let calls = 0;
    const built = await build({
      scan: async () => {
        calls += 1;
        if (calls > 1) throw new Error("扫描器崩了：C:\\Users\\zhangsan\\secret");
        return emptyReport();
      },
    });
    // 先跑一次成功扫描，制造“旧结果”存在
    await built.service.scan();
    const payload = await exportJson(built.service, built.root);
    const scan = payload["scan"] as Record<string, unknown>;
    expect(scan["status"]).toBe("failed");
    expect(scan["scannedAt"]).toBeNull();
    expect((scan["records"] as unknown[]).length).toBe(0);
    const failure = scan["failure"] as Record<string, string>;
    expect(failure["code"]).toBe("E_INTERNAL");
    expect(failure["message"]).not.toContain("zhangsan");
  });

  it("登记实例单独输出，即使扫描没有发现任何安装", async () => {
    const built = await build();
    const instances = [
      {
        instanceId: "workbuddy-cn@5.8.3@aaa",
        product: "workbuddy-cn",
        version: "5.8.3",
        directory: "D:\\Apps\\WorkBuddy-CN",
        origin: "deployed",
        active: true,
        source: "local-file",
        packageFile: "",
        packageSha256: "",
        packageFormat: "nsis",
        signerSubject: null,
        signerThumbprint: null,
        installedAt: "2026-10-18T10:00:00.000Z",
        operationId: "install-1",
        verified: true,
        executableRelativePath: "WorkBuddy.exe",
      },
    ];
    await fsp.writeFile(path.join(built.stateDir, "instances.json"), JSON.stringify(instances, null, 2), "utf8");

    const payload = await exportJson(built.service, built.root);
    const managed = payload["managedInstances"] as Record<string, unknown>[];
    expect(managed).toHaveLength(1);
    expect(managed[0]).toMatchObject({ product: "workbuddy-cn", version: "5.8.3", executablePresent: false });
    expect(JSON.stringify(managed)).not.toContain("Apps\\\\WorkBuddy-CN");

    const correlation = payload["scanToManaged"] as Record<string, unknown>[];
    expect(correlation.some((item) => item["status"] === "managed-not-found-on-disk")).toBe(true);
  });

  it("journal 为空时，错误日志成为 lastOperation", async () => {
    const built = await build();
    await built.errorLog.write({
      operation: "install",
      product: "workbuddy-cn",
      instanceId: null,
      stage: "deploy",
      code: "E_SPACE",
      message: "磁盘剩余空间不足：C:\\Users\\zhangsan",
      rolledBack: true,
    });
    const payload = await exportJson(built.service, built.root);
    const last = payload["lastOperation"] as Record<string, unknown>;
    expect(last["source"]).toBe("error-log");
    expect(last["failureCode"]).toBe("E_SPACE");
    expect(last["stage"]).toBe("deploy");
    expect(last["rolledBack"]).toBe(true);
    expect(String(last["failureMessage"])).not.toContain("zhangsan");

    const history = payload["historyStatus"] as Record<string, unknown>;
    expect(history["state"]).toBe("ok");
    expect((payload["recentErrors"] as unknown[]).length).toBe(1);
  });

  it("没有历史时明确标记 no-history，而不是假装有操作", async () => {
    const built = await build();
    const payload = await exportJson(built.service, built.root);
    expect(payload["lastOperation"]).toBeNull();
    expect((payload["historyStatus"] as Record<string, unknown>)["state"]).toBe("no-history");
  });

  it("报告不再包含旧字段（availability/assisted/readOnly/evidence 阻断）", async () => {
    const built = await build();
    const payload = await exportJson(built.service, built.root);
    expect(payload["availability"]).toBeUndefined();
    expect(payload["assisted"]).toBeUndefined();
    expect((payload["scan"] as Record<string, unknown>)["readOnly"]).toBeUndefined();
    const text = JSON.stringify(payload);
    expect(text).not.toContain("证据包");
    expect(text).not.toContain("只读检测");
  });
});

describe("实例登记不可读", () => {
  it("instances.json 变成目录时标记 registry-unreadable，并说明回退来源", async () => {
    const built = await build();
    // 用同名目录制造“登记文件不可读”
    await fsp.mkdir(path.join(built.stateDir, "instances.json"), { recursive: true });
    const payload = await exportJson(built.service, built.root);
    const registry = payload["instanceRegistry"] as Record<string, unknown>;
    expect(registry["source"]).toBe("memory");
    expect(registry["readable"]).toBe(false);
    const history = payload["historyStatus"] as Record<string, unknown>;
    expect(history["state"]).toBe("registry-unreadable");
    expect((history["notes"] as string[]).join("；")).toContain("回退");
  });
});
