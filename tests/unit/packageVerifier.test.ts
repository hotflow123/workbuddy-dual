import { describe, expect, it } from "vitest";
import { verifyPackage } from "../../src/core/packageVerifier";
import type { PackageDeps, PackageVerifyInput } from "../../src/core/packageVerifier";
import type { ProductProfile } from "../../src/core/contracts";

const cnProfile: ProductProfile = {
  product: "workbuddy-cn",
  displayName: "国内版",
  productNames: ["WorkBuddy"],
  dataFolderNames: [".workbuddy"],
  trustedSignerSubjects: ["CN=Tencent Technology (Shenzhen) Company Limited"],
  installerArguments: [],
  executableRelativePath: null,
  trust: "verified",
  evidence: null,
  verifiedVersions: ["5.8.3"],
};

const aiProfile: ProductProfile = {
  ...cnProfile,
  product: "workbuddy-ai",
  displayName: "国际版",
  productNames: ["WorkBuddy AI"],
  dataFolderNames: [".workbuddy-ai"],
};

function input(overrides: Partial<PackageVerifyInput> = {}): PackageVerifyInput {
  return { file: "C:\\pkg.exe", expected: "workbuddy-cn", profile: cnProfile, counterpart: aiProfile, ...overrides };
}

function deps(
  overrides: {
    status?: string;
    subject?: string | null;
    productName?: string | null;
    sha256?: string;
    thumbprint?: string;
  } = {},
): PackageDeps {
  return {
    sha256: async () => overrides.sha256 ?? "a".repeat(64),
    size: async () => 1024,
    authenticode: async () => ({
      status: overrides.status ?? "Valid",
      signerSubject:
        overrides.subject === undefined ? "CN=Tencent Technology (Shenzhen) Company Limited" : overrides.subject,
      signerThumbprint: overrides.thumbprint ?? "ABC",
      notAfter: null,
      chainOk: overrides.status === undefined || overrides.status === "Valid",
    }),
    versionInfo: async () => ({
      productName: overrides.productName === undefined ? "WorkBuddy" : overrides.productName,
      fileDescription: null,
      fileVersion: "5.8.3",
    }),
  };
}

describe("verifyPackage（0.6.1：签名只作诊断）", () => {
  it("签名有效、产品一致 → valid", async () => {
    const check = await verifyPackage(input(), deps());
    expect(check.verdict).toBe("valid");
  });

  it("NotSigned 不再判 invalid", async () => {
    const check = await verifyPackage(input(), deps({ status: "NotSigned", subject: null }));
    expect(check.verdict).toBe("valid");
    expect(check.reasons.join("；")).toContain("仅诊断");
  });

  it("Unknown 签名状态不阻断", async () => {
    const check = await verifyPackage(input(), deps({ status: "Unknown", subject: "CN=X" }));
    expect(check.verdict).toBe("valid");
  });

  it("证书换签（发布者与指纹都变了）不阻断", async () => {
    const check = await verifyPackage(input(), deps({ subject: "CN=Rotated Signer", thumbprint: "BB" }));
    expect(check.verdict).toBe("valid");
  });

  it("读不到签名信息也不阻断", async () => {
    const check = await verifyPackage(input(), { ...deps(), authenticode: async () => null });
    expect(check.verdict).toBe("valid");
  });

  it("把国际版包当国内版用 → invalid（产品不匹配）", async () => {
    const check = await verifyPackage(input(), deps({ productName: "WorkBuddy AI" }));
    expect(check.verdict).toBe("invalid");
    expect(check.reasons.join()).toContain("另一产品");
  });

  it("读不到产品名 → unknown（不默认通过）", async () => {
    const check = await verifyPackage(input(), deps({ productName: null }));
    expect(check.verdict).toBe("unknown");
  });

  it("哈希与官方元数据不一致 → invalid", async () => {
    const check = await verifyPackage(input({ expectedSha256: "b".repeat(64) }), deps());
    expect(check.verdict).toBe("invalid");
    expect(check.reasons.join()).toContain("SHA-256");
  });

  it("未验证 profile 不再降级为 unknown", async () => {
    const check = await verifyPackage(
      input({ profile: { ...cnProfile, trust: "unverified", trustedSignerSubjects: [] } }),
      deps(),
    );
    expect(check.verdict).toBe("valid");
  });
});
