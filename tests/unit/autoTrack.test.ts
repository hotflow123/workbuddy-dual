import { describe, expect, it } from "vitest";
import {
  evaluateAutoTrack,
  instanceIdFor,
  mergeAutoTrackedInstances,
  type AutoTrackDecision,
  type AutoTrackProbe,
} from "../../src/core/autoTrack";
import type { InstallRecord, ManagedInstance, ProductId, ScanReport } from "../../src/core/contracts";

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
    uninstallString: null,
    primarySource: "registry",
    clues: [],
    discovery: "path-found",
    identity: "identified",
    identityCheck: null,
    duplicateRegistrations: 1,
    needsReview: false,
    isManagerSelf: false,
    conflicts: [],
    managedByTool: false,
    ...overrides,
  };
}

function probe(overrides: Partial<AutoTrackProbe> = {}): AutoTrackProbe {
  return {
    directoryExists: async () => true,
    isReparsePoint: async () => false,
    findExecutable: async () => "WorkBuddy.exe",
    signatureStatus: async () => ({
      status: "Valid",
      subject: "CN=Tencent Technology (Shenzhen) Company Limited",
      thumbprint: "E1B5824EE85186B91E65DB3E75867F59E35CF4AB",
    }),
    ...overrides,
  };
}

function report(installs: InstallRecord[]): ScanReport {
  return {
    scannedAt: "2026-10-19T00:00:00.000Z",
    readOnly: true,
    records: installs,
    skippedSources: [],
    conflicts: [],
    products: [
      { product: "workbuddy-cn", installs, pendingPath: [], state: "found", copyCount: installs.length },
      { product: "workbuddy-ai", installs: [], pendingPath: [], state: "not-found", copyCount: 0 },
    ],
    sources: [],
  };
}

function instance(partial: Partial<ManagedInstance> & { product: ProductId; directory: string }): ManagedInstance {
  const version = partial.version ?? "5.8.3";
  const base: ManagedInstance = {
    instanceId: instanceIdFor(partial.product, version, partial.directory),
    product: partial.product,
    version,
    directory: partial.directory,
    origin: "external",
    active: false,
    source: "local-file",
    packageFile: "",
    packageSha256: "",
    packageFormat: "directory",
    signerSubject: null,
    signerThumbprint: null,
    installedAt: "2026-10-19T00:00:00.000Z",
    operationId: "op",
    verified: true,
    executableRelativePath: "WorkBuddy.exe",
  };
  return { ...base, ...partial };
}

/* ------------------------------------------------------------------ 判定 */

describe("evaluateAutoTrack", () => {
  it("身份、路径、主程序、签名都通过时可自动登记", async () => {
    const decision = await evaluateAutoTrack(record(), probe());
    expect(decision.eligible).toBe(true);
    expect(decision.directory).toBe("E:\\Programs\\workbuddy");
    expect(decision.executableRelativePath).toBe("WorkBuddy.exe");
    expect(decision.signerThumbprint).toBe("E1B5824EE85186B91E65DB3E75867F59E35CF4AB");
  });

  it("目录不存在、重解析点、无主程序、签名无效都拒绝", async () => {
    const cases: [string, Partial<AutoTrackProbe>][] = [
      ["安装目录不存在", { directoryExists: async () => false }],
      ["重解析点", { isReparsePoint: async () => true }],
      ["主可执行文件", { findExecutable: async () => null }],
      [
        "签名",
        { signatureStatus: async () => ({ status: "Invalid", subject: null, thumbprint: null }) },
      ],
      [
        "签名",
        { signatureStatus: async () => ({ status: "Unknown", subject: null, thumbprint: null }) },
      ],
    ];
    for (const [expected, override] of cases) {
      const decision = await evaluateAutoTrack(record(), probe(override));
      expect(decision.eligible, expected).toBe(false);
      expect(decision.blockers.join("；"), expected).toContain(expected);
    }
  });

  it("身份未确认、需人工确认、管理器自身目录都拒绝", async () => {
    for (const overrides of [
      { identity: "unverified" as const },
      { needsReview: true },
      { isManagerSelf: true },
      { installLocation: null },
    ]) {
      const decision = await evaluateAutoTrack(record(overrides), probe());
      expect(decision.eligible).toBe(false);
      expect(decision.blockers.length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ 合并 */

describe("mergeAutoTrackedInstances", () => {
  const now = () => "2026-10-19T00:00:00.000Z";

  function decision(directory: string, product: ProductId, version = "5.8.3"): AutoTrackDecision {
    return {
      recordId: `path:${directory.toLowerCase()}`,
      product,
      directory,
      version,
      executableRelativePath: "WorkBuddy.exe",
      signerSubject: "CN=Tencent",
      signerThumbprint: "ABC",
      eligible: true,
      blockers: [],
    };
  }

  it("首次扫描自动登记，并把唯一实例设为默认", () => {
    const merged = mergeAutoTrackedInstances({
      decisions: [decision("E:\\Programs\\workbuddy", "workbuddy-cn")],
      previous: [],
      report: report([record()]),
      now,
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.origin).toBe("external");
    expect(merged[0]!.active).toBe(true);
  });

  it("重复扫描幂等：同目录复用 instanceId", () => {
    const first = mergeAutoTrackedInstances({
      decisions: [decision("E:\\Programs\\workbuddy", "workbuddy-cn")],
      previous: [],
      report: report([record()]),
      now,
    });
    const second = mergeAutoTrackedInstances({
      decisions: [decision("E:\\Programs\\workbuddy", "workbuddy-cn")],
      previous: first,
      report: report([record()]),
      now,
    });
    expect(second).toHaveLength(1);
    expect(second[0]!.instanceId).toBe(first[0]!.instanceId);
  });

  it("国内版两份副本全部登记，国际版独立登记", () => {
    const merged = mergeAutoTrackedInstances({
      decisions: [
        decision("E:\\Programs\\workbuddy", "workbuddy-cn"),
        decision("E:\\WorkBuddy-CN", "workbuddy-cn"),
        decision("F:\\WorkBuddy-AI", "workbuddy-ai", "5.8.4"),
      ],
      previous: [],
      report: report([record()]),
      now,
    });
    expect(merged.filter((item) => item.product === "workbuddy-cn")).toHaveLength(2);
    expect(merged.filter((item) => item.product === "workbuddy-ai")).toHaveLength(1);
    expect(merged.filter((item) => item.active)).toHaveLength(2);
  });

  it("本工具部署的实例不会被扫描改写，且保持默认标记", () => {
    const deployed = instance({
      product: "workbuddy-cn",
      directory: "E:\\Managed\\WorkBuddy-CN\\versions\\5.8.3",
      origin: "deployed",
      active: true,
    });
    const merged = mergeAutoTrackedInstances({
      decisions: [decision("E:\\Programs\\workbuddy", "workbuddy-cn")],
      previous: [deployed],
      report: report([record()]),
      now,
    });
    expect(merged.find((item) => item.instanceId === deployed.instanceId)).toBeDefined();
    const external = merged.find((item) => item.origin === "external");
    expect(external?.active).toBe(false);
  });

  it("本轮未出现且目录仍可能存在的既有实例保留登记但标记未核验", () => {
    const existing = instance({ product: "workbuddy-ai", directory: "F:\\WorkBuddy-AI", active: true });
    const merged = mergeAutoTrackedInstances({
      decisions: [],
      previous: [existing],
      report: report([]),
      now,
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.verified).toBe(false);
  });

  it("扫描明确确认安装目录不存在时清除过期外部登记", () => {
    const existing = instance({ product: "workbuddy-ai", directory: "F:\\WorkBuddy-AI", active: true });
    const missing: AutoTrackDecision = {
      ...decision("F:\\WorkBuddy-AI", "workbuddy-ai"),
      eligible: false,
      executableRelativePath: null,
      blockers: ["安装目录不存在"],
    };
    const merged = mergeAutoTrackedInstances({
      decisions: [missing],
      previous: [existing],
      report: report([]),
      now,
    });
    expect(merged).toHaveLength(0);
  });

  it("同产品多个 active 会被收敛为一个", () => {
    const merged = mergeAutoTrackedInstances({
      decisions: [decision("E:\\Programs\\workbuddy", "workbuddy-cn"), decision("E:\\WorkBuddy-CN", "workbuddy-cn")],
      previous: [
        instance({ product: "workbuddy-cn", directory: "E:\\Programs\\workbuddy", active: true }),
        instance({ product: "workbuddy-cn", directory: "E:\\WorkBuddy-CN", active: true }),
      ],
      report: report([record()]),
      now,
    });
    expect(merged.filter((item) => item.active)).toHaveLength(1);
  });
});
