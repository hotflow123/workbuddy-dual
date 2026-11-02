import { describe, expect, it } from "vitest";
import {
  buildDiagnostics,
  correlateScanAndManaged,
  maskPath,
  mergeLastOperation,
  sanitizeText,
  serializeDiagnostics,
  type DiagnosticsInput,
  type ManagedInstanceDiagnostic,
} from "../../src/core/diagnostics";
import type { InstallRecord, OperationRecord, ScanReport } from "../../src/core/contracts";

function record(overrides: Partial<InstallRecord> = {}): InstallRecord {
  return {
    id: "path:e:\\programs\\workbuddy",
    product: "workbuddy-cn",
    productHint: "workbuddy-cn",
    displayName: "WorkBuddy",
    displayVersion: "5.8.3",
    publisher: "Tencent",
    installLocation: "E:\\Programs\\workbuddy",
    locationSource: "registry",
    uninstallString: '"E:\\Programs\\workbuddy\\Uninstall WorkBuddy.exe" /S --token=abcdef123456',
    primarySource: "registry",
    clues: [{ kind: "registry", source: "HKLM64", detail: "WorkBuddy" }],
    discovery: "path-found",
    identity: "identified",
    identityCheck: null,
    duplicateRegistrations: 2,
    needsReview: false,
    isManagerSelf: false,
    conflicts: ["duplicate-registration"],
    managedByTool: false,
    ...overrides,
  };
}

function scanReport(overrides: Partial<ScanReport> = {}): ScanReport {
  const cn = record();
  return {
    scannedAt: "2026-10-18T12:00:00.000Z",
    readOnly: true,
    records: [
      cn,
      record({
        id: "path:f:\\code\\win-unpacked",
        product: null,
        productHint: null,
        displayName: "win-unpacked",
        installLocation: "F:\\code\\win-unpacked",
        identity: "conflict",
        needsReview: true,
        conflicts: ["identity-mismatch"],
      }),
    ],
    skippedSources: [
      { source: "registry:uninstall", reason: "spawn EPERM C:\\Users\\zhangsan\\AppData\\Local" },
      { source: "user-root:E:\\Apps", reason: "目录不可读：C:\\Users\\zhangsan\\secret" },
      { source: "shortcuts", reason: "2 个与 WorkBuddy 相关的快捷方式无法解析出本地目标" },
    ],
    conflicts: ["E:\\Programs\\workbuddy：同一路径有 2 条卸载登记", "F:\\code\\win-unpacked：需人工确认"],
    products: [
      { product: "workbuddy-cn", installs: [cn], pendingPath: [], state: "found", copyCount: 1 },
      { product: "workbuddy-ai", installs: [], pendingPath: [], state: "not-found", copyCount: 0 },
    ],
    sources: [
      { kind: "registry", count: 2, note: null },
      { kind: "shortcut", count: 2, note: null },
    ],
    ...overrides,
  };
}

function managed(overrides: Partial<ManagedInstanceDiagnostic> = {}): ManagedInstanceDiagnostic {
  return {
    instanceId: "workbuddy-cn@5.8.3@aaa",
    product: "workbuddy-cn",
    version: "5.8.3",
    active: true,
    origin: "deployed",
    registeredAt: "2026-10-18T11:00:00.000Z",
    directory: "E:\\Programs\\workbuddy",
    executableRelativePath: "WorkBuddy.exe",
    executablePresent: true,
    ...overrides,
  };
}

function baseInput(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  const scan = scanReport();
  return {
    generatedAt: "2026-10-18T12:00:01.000Z",
    exportStartedAt: "2026-10-18T12:00:00.000Z",
    appVersion: "0.6.3",
    buildId: "20261019223000",
    buildTime: "2026-10-19T14:30:00.000Z",
    packaged: true,
    platform: "win32",
    portable: false,
    deployment: { install: true, update: true, uninstall: true, builtInUpdateControl: false },
    scan,
    scanStatus: {
      status: "ok",
      startedAt: "2026-10-18T12:00:00.000Z",
      scannedAt: scan.scannedAt,
      durationMs: 1200,
      failure: null,
    },
    managedInstances: [managed()],
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
    errorLogDirectory: "C:\\Users\\zhangsan\\AppData\\Roaming\\workbuddy\\state\\errors",
    settings: {
      managementRoot: "C:\\Users\\zhangsan\\AppData\\Local\\WorkBuddyDualEdition",
      userScanRoots: [],
    },
    ...overrides,
    instanceRegistry: overrides.instanceRegistry ?? { source: "file", readable: true, count: 1 },
  };
}

describe("maskPath", () => {
  it("只保留盘符、层级、末级目录与短哈希", () => {
    expect(maskPath("E:\\Programs\\workbuddy")).toEqual({
      drive: "E:\\",
      depth: 3,
      leaf: "workbuddy",
      hash: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });

  it("同一路径大小写不同得到同一哈希", () => {
    expect(maskPath("E:\\Programs\\workbuddy")?.hash).toBe(maskPath("e:\\programs\\WORKBUDDY")?.hash);
  });

  it("空路径返回 null", () => {
    expect(maskPath(null)).toBeNull();
  });

  it("脱敏后的盘符不会被二次清洗", () => {
    const text = serializeDiagnostics(baseInput());
    expect(text).toContain('"drive": "C:\\\\"');
    expect(text).not.toContain('"drive": "<path>"');
  });
});

describe("sanitizeText", () => {
  it("替换绝对路径与凭据", () => {
    const text = sanitizeText("C:\\Users\\zhangsan\\a.txt token=abcdef123456");
    expect(text).not.toContain("zhangsan");
    expect(text).not.toContain("abcdef123456");
    expect(text).toContain("<path>");
  });
});

describe("诊断 schema v4", () => {
  it("输出 schemaVersion/diagnosticsBuildId/deploymentCapabilities，不再有 availability/assisted/readOnly", () => {
    const payload = buildDiagnostics(baseInput());
    expect(payload["schemaVersion"]).toBe(4);
    expect(payload["diagnosticsSchemaVersion"]).toBe(4);
    expect(payload["diagnosticsBuildId"]).toBe("20261019223000");
    expect(payload["availability"]).toBeUndefined();
    expect(payload["assisted"]).toBeUndefined();
    expect(payload["deployment"]).toBeUndefined();

    const deployment = payload["deploymentCapabilities"] as Record<string, unknown>;
    expect(deployment).toMatchObject({ install: true, update: true, uninstall: true, signatureGate: false });
    expect(deployment["source"]).toBe("current-code");

    const scan = payload["scan"] as Record<string, unknown>;
    expect(scan["readOnly"]).toBeUndefined();
    expect(scan["mode"]).toBe("read-only-scan");
    expect(scan["status"]).toBe("ok");
    expect(scan["scannedAt"]).toBe("2026-10-18T12:00:00.000Z");
    expect(payload["exportStartedAt"]).toBe("2026-10-18T12:00:00.000Z");
  });

  it("扫描失败时如实标记，不沿用旧结果", () => {
    const payload = buildDiagnostics(
      baseInput({
        scan: null,
        scanStatus: {
          status: "failed",
          startedAt: "2026-10-18T12:00:00.000Z",
          scannedAt: null,
          durationMs: 5,
          failure: { code: "E_PERMISSION", message: "无法读取 C:\\Users\\zhangsan\\secret" },
        },
      }),
    );
    const scan = payload["scan"] as Record<string, unknown>;
    expect(scan["status"]).toBe("failed");
    expect(scan["scannedAt"]).toBeNull();
    expect(scan["records"]).toEqual([]);
    const failure = scan["failure"] as Record<string, string>;
    expect(failure["code"]).toBe("E_PERMISSION");
    expect(failure["message"]).not.toContain("zhangsan");
  });

  it("登记实例与扫描结果分别输出，并给出关联状态", () => {
    const instances = [
      managed(),
      managed({ instanceId: "cn-missing", directory: "D:\\Apps\\WorkBuddy-CN", version: "5.8.2" }),
    ];
    const payload = buildDiagnostics(baseInput({ managedInstances: instances }));
    const managedList = payload["managedInstances"] as Record<string, unknown>[];
    expect(managedList).toHaveLength(2);
    expect(managedList[0]?.["path"]).toMatchObject({ drive: "E:\\", leaf: "workbuddy" });
    expect(JSON.stringify(managedList)).not.toContain("Programs\\\\workbuddy");

    const correlation = correlateScanAndManaged(scanReport(), instances);
    const matched = correlation.find((item) => item.instanceId === "workbuddy-cn@5.8.3@aaa");
    const missing = correlation.find((item) => item.instanceId === "cn-missing");
    expect(matched?.status).toBe("matched");
    expect(missing?.status).toBe("managed-not-found-on-disk");
  });

  it("扫描发现但未登记的目录标记为 discovered-not-managed", () => {
    const correlation = correlateScanAndManaged(scanReport(), []);
    expect(correlation.some((item) => item.status === "discovered-not-managed")).toBe(true);
    expect(correlation.every((item) => item.instanceId === null)).toBe(true);
  });

  it("同一路径产品不一致时标记 identity-conflict", () => {
    const correlation = correlateScanAndManaged(scanReport(), [
      managed({ instanceId: "ai-on-cn-path", product: "workbuddy-ai" }),
    ]);
    expect(correlation[0]?.status).toBe("identity-conflict");
  });

  it("脱敏：不含用户名、完整路径、卸载命令或令牌", () => {
    const text = serializeDiagnostics(baseInput());
    expect(text).not.toContain("zhangsan");
    expect(text).not.toContain("E:\\\\Programs\\\\workbuddy");
    expect(text).not.toContain("F:\\\\code\\\\win-unpacked");
    expect(text).not.toContain("Uninstall WorkBuddy.exe");
    expect(text).not.toContain("abcdef123456");
    expect(text).not.toContain("--token");
  });

  it("保留排障所需的来源类型、聚合数量与产品状态", () => {
    const payload = buildDiagnostics(baseInput());
    const scan = payload["scan"] as Record<string, unknown>;
    expect(scan["sources"]).toEqual([
      { kind: "registry", count: 2 },
      { kind: "shortcut", count: 2 },
    ]);
    const products = scan["products"] as { product: string; state: string; copyCount: number }[];
    expect(products[0]).toMatchObject({ product: "workbuddy-cn", state: "found", copyCount: 1 });
    expect(products[1]).toMatchObject({ product: "workbuddy-ai", state: "not-found", copyCount: 0 });
    const totals = scan["totals"] as Record<string, number>;
    expect(totals["identified"]).toBe(1);
    expect(totals["conflicts"]).toBe(1);
    expect(totals["needsReview"]).toBe(1);
    const records = scan["records"] as Record<string, unknown>[];
    expect(records[0]?.["hasRemovalCommand"]).toBe(true);
    expect(JSON.stringify(records[0])).not.toContain("Uninstall");
  });

  it("跳过项按类别聚合并清洗路径", () => {
    const payload = buildDiagnostics(baseInput());
    const scan = payload["scan"] as Record<string, unknown>;
    const skipped = scan["skipped"] as { category: string; count: number; sample: string }[];
    const denied = skipped.find((item) => item.category === "access-denied");
    expect(denied?.count).toBe(2);
    expect(denied?.sample).not.toContain("zhangsan");
    const conflicts = scan["conflicts"] as { category: string; count: number; sample: string }[];
    expect(conflicts.reduce((sum, item) => sum + item.count, 0)).toBe(2);
  });

  it("补充扫描目录为空时不是错误，只记录数量 0", () => {
    const payload = buildDiagnostics(baseInput());
    expect((payload["settings"] as Record<string, unknown>)["userScanRootCount"]).toBe(0);
    expect((payload["historyStatus"] as Record<string, unknown>)["state"]).toBe("no-history");
  });
});

describe("最近操作与错误合并", () => {
  function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
    return {
      operationId: "install-cn-1",
      kind: "install",
      product: "workbuddy-cn",
      version: "5.8.3",
      state: "failed",
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:05:00.000Z",
      planPath: "plan.json",
      steps: [],
      notes: [],
      failure: { code: "E_SPACE", message: "磁盘剩余空间不足：C:\\Users\\zhangsan" },
      ...overrides,
    };
  }

  const errorRecord = {
    at: "2026-10-18T11:00:00.000Z",
    operation: "install",
    product: "workbuddy-cn" as const,
    instanceId: null,
    stage: "verify-signature",
    code: "E_SIGNATURE_INVALID",
    message: "安装包未通过校验：C:\\Users\\zhangsan\\a.exe",
    rolledBack: true,
  };

  it("journal 为空但存在错误日志时，lastOperation 指向该错误", () => {
    const { lastOperation } = mergeLastOperation([], [errorRecord]);
    expect(lastOperation).toMatchObject({
      source: "error-log",
      kind: "install",
      stage: "verify-signature",
      failureCode: "E_SIGNATURE_INVALID",
      rolledBack: true,
      timestamp: "2026-10-18T11:00:00.000Z",
    });
    expect(lastOperation?.failureMessage).not.toContain("zhangsan");
  });

  it("错误时间晚于 journal 时取错误，反之取 journal", () => {
    const later = mergeLastOperation([operation()], [errorRecord]).lastOperation;
    expect(later?.source).toBe("error-log");

    const earlierError = { ...errorRecord, at: "2026-10-18T09:00:00.000Z" };
    const older = mergeLastOperation([operation()], [earlierError]).lastOperation;
    expect(older?.source).toBe("journal");
    expect(older?.failureCode).toBe("E_SPACE");
  });

  it("时间无法解析时排序稳定并给出提示", () => {
    const broken = { ...errorRecord, at: "not-a-time" };
    const result = mergeLastOperation([operation()], [broken]);
    expect(result.lastOperation?.source).toBe("journal");
    expect(result.sortWarning).toContain("无法解析");
  });

  it("报告同时输出 recentOperations 与 recentErrors", () => {
    const payload = buildDiagnostics(
      baseInput({ recentOperations: [operation()], recentErrors: [errorRecord] }),
    );
    expect((payload["recentOperations"] as unknown[]).length).toBe(1);
    expect((payload["recentErrors"] as unknown[]).length).toBe(1);
    expect((payload["lastOperation"] as Record<string, unknown>)["source"]).toBe("error-log");
  });

  it("历史读取失败时 historyStatus 如实标记", () => {
    const payload = buildDiagnostics(
      baseInput({
        history: {
          state: "error-log-unreadable",
          journalReadable: true,
          journalTotal: 0,
          errorLogReadable: false,
          errorLogTotal: 0,
          errorLogCorrupted: 0,
          notes: ["错误日志目录不可读，最近失败可能不完整"],
        },
      }),
    );
    const status = payload["historyStatus"] as Record<string, unknown>;
    expect(status["state"]).toBe("error-log-unreadable");
    expect((payload["errorLog"] as Record<string, unknown>)["readable"]).toBe(false);
    expect(payload["lastOperation"]).toBeNull();
  });
});

describe("盘符根异常线索", () => {
  function reportWithDriveRoot(): ScanReport {
    const report = scanReport();
    report.records = [
      ...report.records,
      record({
        id: "path:d:\\",
        displayName: "D:",
        installLocation: "D:\\",
        locationSource: "process",
        primarySource: "process",
        clues: [{ kind: "process", source: "WorkBuddy.exe", detail: "D:\\" }],
        identity: "unverified",
        needsReview: true,
        conflicts: [],
      }),
    ];
    report.skippedSources = [
      ...report.skippedSources,
      { source: "processes:invalid-path", reason: "进程路径是盘符根目录，不是安装实例（WorkBuddy.exe）" },
    ];
    return report;
  }

  it("盘符根记录不出现在 scan.records，也不产生 scanToManaged 关联", () => {
    const payload = buildDiagnostics(baseInput({ scan: reportWithDriveRoot() }));
    const scan = payload["scan"] as Record<string, unknown>;
    const records = scan["records"] as Record<string, unknown>[];
    expect(records.every((item) => (item["path"] as Record<string, unknown>)["leaf"] !== "D:")).toBe(true);

    const correlation = correlateScanAndManaged(reportWithDriveRoot(), [managed()]);
    expect(correlation.every((item) => item.path?.leaf !== "D:")).toBe(true);
    expect(correlation.some((item) => item.status === "managed-not-found-on-disk")).toBe(false);
  });

  it("被忽略的线索单独计数并说明原因", () => {
    const payload = buildDiagnostics(baseInput({ scan: reportWithDriveRoot() }));
    const scan = payload["scan"] as Record<string, unknown>;
    const ignored = scan["ignoredClues"] as { count: number; reasons: { category: string; count: number; sample: string }[] };
    expect(ignored.count).toBe(1);
    expect(ignored.reasons[0]?.sample).toContain("盘符根");
  });

  it("实例登记不可读时不会同时报“没有历史记录”", () => {
    const payload = buildDiagnostics(
      baseInput({
        instanceRegistry: { source: "memory", readable: false, count: 0 },
        history: {
          state: "registry-unreadable",
          journalReadable: true,
          journalTotal: 0,
          errorLogReadable: true,
          errorLogTotal: 0,
          errorLogCorrupted: 0,
          notes: ["实例登记文件不可读，已回退到内存中的实例列表"],
        },
      }),
    );
    const status = payload["historyStatus"] as Record<string, unknown>;
    expect(status["state"]).toBe("registry-unreadable");
    expect(status["state"]).not.toBe("no-history");
    expect(payload["instanceRegistry"]).toMatchObject({ source: "memory", readable: false });
  });
});
