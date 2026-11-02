import { describe, expect, it } from "vitest";
import { buildPlan, renderPlanText } from "../../src/core/plan";
import { deriveCapabilities, parseEvidenceBundle, profilesFromEvidence, EMPTY_EVIDENCE } from "../../src/core/evidence";
import type { CapabilityState, InstallSelection, PackageCheck } from "../../src/core/contracts";
import path from "node:path";

const managementRoot = path.resolve("C:/mgr");

const blockedCapability: CapabilityState = {
  installAutomation: false,
  uninstallAutomation: false,
  updateAutomation: false,
  builtInUpdateControl: false,
  blockers: ["官方安装器未验证"],
  mode: "read-only",
  evidence: [],
};

const openCapability: CapabilityState = { ...blockedCapability, installAutomation: true, mode: "assisted", blockers: [] };

const profile = {
  product: "workbuddy-cn" as const,
  displayName: "国内版 WorkBuddy",
  productNames: ["WorkBuddy"],
  dataFolderNames: [".workbuddy"],
  trustedSignerSubjects: ["CN=Tencent"],
  installerArguments: ["/S"],
  executableRelativePath: "WorkBuddy.exe",
  trust: "verified" as const,
  evidence: null,
  verifiedVersions: ["5.8.3"],
};

const selection: InstallSelection = {
  product: "workbuddy-cn",
  selected: true,
  source: { kind: "local-file", path: "C:\\pkg\\setup.exe" },
  version: "5.8.3",
  targetDirectory: path.join(managementRoot, "WorkBuddy-CN", "versions", "5.8.3"),
};

const validPackage: PackageCheck = {
  file: "C:\\pkg\\setup.exe",
  sizeBytes: 100 * 1024 * 1024,
  sha256: "a".repeat(64),
  authenticode: { status: "Valid", signerSubject: "CN=Tencent", signerThumbprint: "ABC", notAfter: null, chainOk: true },
  productName: "WorkBuddy",
  productVersion: "5.8.3",
  verdict: "valid",
  reasons: [],
};

function planFor(capability: CapabilityState, pkg: PackageCheck | null = validPackage) {
  return buildPlan({
    operationId: "op-1",
    kind: "install",
    selection,
    profile,
    capability,
    managementRoot,
    packageCheck: pkg,
    scan: null,
    stagingDirectory: path.join(managementRoot, ".staging", "op-1"),
    now: "2026-10-01T00:00:00.000Z",
  });
}

describe("buildPlan", () => {
  it("能力门关闭时计划包含阻断项", () => {
    const result = planFor(blockedCapability);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blockers.join()).toContain("官方安装器");
      expect(result.value.deletionTargets).toHaveLength(0);
    }
  });

  it("能力门开启时计划列出精确路径、签名与哈希", () => {
    const result = planFor(openCapability);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.value;
    expect(plan.blockers).toHaveLength(0);
    expect(plan.sha256).toBe(validPackage.sha256);
    expect(plan.signerSubject).toBe("CN=Tencent");
    expect(plan.steps.some((s) => s.action === "create" && s.target.endsWith("5.8.3"))).toBe(true);
    expect(plan.steps.some((s) => s.action === "backup")).toBe(true);
    expect(plan.requiredFreeSpaceBytes).toBeGreaterThan(validPackage.sizeBytes);
  });

  it("包未通过校验时阻断", () => {
    const result = planFor(openCapability, { ...validPackage, verdict: "invalid" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.blockers.join()).toContain("校验");
  });

  it("版本不在已验证清单时阻断", () => {
    const result = buildPlan({
      operationId: "op-2",
      kind: "install",
      selection: { ...selection, version: "9.9.9" },
      profile,
      capability: openCapability,
      managementRoot,
      packageCheck: validPackage,
      scan: null,
      stagingDirectory: path.join(managementRoot, ".staging", "op-2"),
      now: "2026-10-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.blockers.join()).toContain("不在该产品的已验证版本清单");
  });

  it("目标路径在管理根之外时阻断", () => {
    const result = buildPlan({
      operationId: "op-3",
      kind: "install",
      selection: { ...selection, targetDirectory: "C:\\Windows\\System32" },
      profile,
      capability: openCapability,
      managementRoot,
      packageCheck: validPackage,
      scan: null,
      stagingDirectory: path.join(managementRoot, ".staging", "op-3"),
      now: "2026-10-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.blockers.join()).toContain("安装路径被拒绝");
  });

  it("卸载计划只允许删除本工具受管目录", () => {
    const result = buildPlan({
      operationId: "op-4",
      kind: "uninstall",
      selection: { ...selection, targetDirectory: "" },
      profile,
      capability: { ...openCapability, uninstallAutomation: true },
      managementRoot,
      packageCheck: null,
      scan: {
        scannedAt: "2026-10-01T00:00:00.000Z",
        readOnly: true,
        records: [
          {
            id: "managed:1",
            product: "workbuddy-cn",
            productHint: "workbuddy-cn",
            displayName: "受管安装",
            displayVersion: "5.8.3",
            publisher: null,
            installLocation: path.join(managementRoot, "WorkBuddy-CN", "versions", "5.8.3"),
            locationSource: "managed",
            uninstallString: null,
            primarySource: "managed",
            clues: [{ kind: "managed", source: "本工具受管目录", detail: null }],
            discovery: "path-found",
            identity: "identified",
            identityCheck: null,
            duplicateRegistrations: 1,
            needsReview: false,
            isManagerSelf: false,
            conflicts: [],
            managedByTool: true,
          },
        ],
        skippedSources: [],
        conflicts: [],
        products: [],
        sources: [],
      },
      stagingDirectory: path.join(managementRoot, ".staging", "op-4"),
      now: "2026-10-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deletionTargets).toHaveLength(1);
      expect(result.value.deletionTargets[0]?.toLowerCase()).toContain("workbuddy-cn");
    }
  });

  it("非受管安装不提供一键卸载", () => {
    const result = buildPlan({
      operationId: "op-5",
      kind: "uninstall",
      selection: { ...selection, targetDirectory: "" },
      profile,
      capability: { ...openCapability, uninstallAutomation: true },
      managementRoot,
      packageCheck: null,
      scan: null,
      stagingDirectory: path.join(managementRoot, ".staging", "op-5"),
      now: "2026-10-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blockers.join()).toContain("不是由本工具管理");
      expect(result.value.deletionTargets).toHaveLength(0);
    }
  });

  it("预演文本包含路径与回滚步骤", () => {
    const result = planFor(openCapability);
    if (!result.ok) throw new Error("plan failed");
    const text = renderPlanText(result.value);
    expect(text).toContain("将执行的步骤");
    expect(text).toContain("失败时的回滚步骤");
    expect(text).toContain("删除清单：无");
  });
});

describe("证据与能力门", () => {
  it("0.6.1：没有证据包也能安装/更新/卸载（部署能力不依赖证据）", () => {
    const capability = deriveCapabilities(EMPTY_EVIDENCE);
    expect(capability.mode).toBe("full");
    expect(capability.installAutomation).toBe(true);
    expect(capability.updateAutomation).toBe(true);
    expect(capability.uninstallAutomation).toBe(true);
    expect(capability.builtInUpdateControl).toBe(false);
    expect(capability.blockers.join()).not.toContain("尚未导入");
  });

  it("非法证据包被拒绝而不是部分采纳", () => {
    const loaded = parseEvidenceBundle("{ bad json", { ref: "x", capturedAt: "t", environment: "e" });
    expect(loaded.bundle).toBeNull();
    expect(loaded.problem).toContain("JSON");
  });

  it("字段缺失的证据包被拒绝", () => {
    const loaded = parseEvidenceBundle(JSON.stringify({ schemaVersion: 1 }), { ref: "x", capturedAt: "t", environment: "e" });
    expect(loaded.bundle).toBeNull();
    expect(loaded.problem).toContain("字段不合法");
  });

  it("完整证据可打开安装能力并给出已验证 profile", () => {
    const bundle = {
      schemaVersion: 1,
      capturedAt: "2026-10-01T00:00:00.000Z",
      capturedBy: "vm-test",
      environment: {
        osVersion: "Windows 11 23H2",
        locale: "zh-CN",
        accountPrivilege: "standard",
        diskFreeGb: 60,
        snapshotId: "snap-01",
        vmTool: "hyper-v",
      },
      products: {
        "workbuddy-cn": {
          officialSource: { pageUrl: "https://example.com/cn", apiEndpoint: null, downloadHost: "example.com", observedAt: "2026-10-01" },
          packages: [
            {
              version: "5.8.3",
              url: "https://example.com/cn/setup.exe",
              sha256: "a".repeat(64),
              authenticode: { status: "Valid", subject: "CN=Tencent", thumbprint: "ABC", notAfter: null },
              productName: "WorkBuddy",
              dataFolderName: ".workbuddy",
            },
          ],
          installer: { scope: "user", supportsCustomPath: true, customPathArgument: "/D=", unattended: true, note: "vm" },
          postInstall: {
            installLocation: "C:\\apps\\cn",
            dataDirectory: "%USERPROFILE%\\.workbuddy",
            uninstallKey: "HKCU\\...\\WorkBuddy",
            shortcuts: [],
            runningExecutable: "WorkBuddy.exe",
            productName: "WorkBuddy",
          },
          update: { builtInUpdater: "present", controllable: true, note: "vm" },
          uninstall: { command: "uninstall.exe /S", removesUserData: "no", preservesOtherProduct: true },
        },
      },
    };
    const loaded = parseEvidenceBundle(JSON.stringify(bundle), { ref: "docs/evidence/vm-01.json", capturedAt: "2026-10-01", environment: "vm01" });
    expect(loaded.bundle).not.toBeNull();
    const profiles = profilesFromEvidence(loaded);
    const cn = profiles.find((p) => p.product === "workbuddy-cn");
    expect(cn?.trust).toBe("verified");
    expect(cn?.productNames).toContain("WorkBuddy");
    expect(cn?.verifiedVersions).toContain("5.8.3");
    const capability = deriveCapabilities(loaded);
    // 证据只用于产品特征展示，不再决定安装能力
    expect(capability.installAutomation).toBe(true);
    expect(capability.blockers).toHaveLength(0);
  });
});
