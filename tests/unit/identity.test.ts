import { describe, expect, it } from "vitest";
import { hintFromName, verifyProductIdentity, type FileProbe } from "../../src/core/identity";
import type { ProductProfile } from "../../src/core/contracts";

function probeWith(files: Record<string, string>): FileProbe {
  return {
    readText: async (file) => files[file] ?? null,
    isFile: async (file) => file in files,
  };
}

const verifiedCn: ProductProfile = {
  product: "workbuddy-cn",
  displayName: "国内版 WorkBuddy",
  productNames: ["WorkBuddy"],
  dataFolderNames: [".workbuddy"],
  trustedSignerSubjects: ["CN=Tencent Technology"],
  installerArguments: ["/S", "/D="],
  executableRelativePath: "WorkBuddy.exe",
  trust: "verified",
  evidence: { ref: "docs/evidence/vm-01.json", capturedAt: "2026-10-01T00:00:00.000Z", environment: "vm01" },
  verifiedVersions: ["5.8.3"],
};

const verifiedAi: ProductProfile = {
  ...verifiedCn,
  product: "workbuddy-ai",
  displayName: "国际版 WorkBuddy AI",
  productNames: ["WorkBuddy AI"],
  dataFolderNames: [".workbuddy-ai"],
  verifiedVersions: ["5.8.4"],
};

/** 没有证据包时的空基线：产品名为空、版本清单为空、trust=unverified */
const emptyCn: ProductProfile = {
  ...verifiedCn,
  productNames: [],
  dataFolderNames: [],
  verifiedVersions: [],
  trust: "unverified",
};
const emptyAi: ProductProfile = {
  ...verifiedAi,
  productNames: [],
  dataFolderNames: [],
  verifiedVersions: [],
  trust: "unverified",
};

describe("verifyProductIdentity：无证据包也能识别（observed）", () => {
  it("空基线 + 元数据符合产品特征 → match / observed", async () => {
    const root = "C:\\apps\\cn";
    const check = await verifyProductIdentity({
      root,
      expected: "workbuddy-cn",
      profile: emptyCn,
      counterpart: "workbuddy-ai",
      probe: probeWith({
        [`${root}\\resources\\app\\product.json`]: JSON.stringify({ productName: "WorkBuddy", version: "5.8.3" }),
      }),
    });
    expect(check.verdict).toBe("match");
    expect(check.confidence).toBe("observed");
    expect(check.observedProductName).toBe("WorkBuddy");
    expect(check.reasons.join()).toContain("不授权写操作");
  });

  it("空基线也能识别国际版，不会把两版混为一谈", async () => {
    const root = "C:\\apps\\ai";
    const check = await verifyProductIdentity({
      root,
      expected: "workbuddy-ai",
      profile: emptyAi,
      counterpart: "workbuddy-cn",
      probe: probeWith({
        [`${root}\\package.json`]: JSON.stringify({ productName: "WorkBuddy AI", version: "5.8.4" }),
      }),
    });
    expect(check.verdict).toBe("match");
    expect(check.confidence).toBe("observed");
  });

  it("元数据缺失时返回 unknown / none", async () => {
    const check = await verifyProductIdentity({
      root: "C:\\apps\\empty",
      expected: "workbuddy-cn",
      profile: emptyCn,
      counterpart: "workbuddy-ai",
      probe: probeWith({}),
    });
    expect(check.verdict).toBe("unknown");
    expect(check.confidence).toBe("none");
    expect(check.reasons[0]).toContain("未找到");
  });

  it("JSON 损坏时返回 unknown 并说明原因", async () => {
    const root = "C:\\apps\\broken";
    const check = await verifyProductIdentity({
      root,
      expected: "workbuddy-cn",
      profile: emptyCn,
      counterpart: "workbuddy-ai",
      probe: probeWith({ [`${root}\\product.json`]: "{not json" }),
    });
    expect(check.verdict).toBe("unknown");
    expect(check.reasons[0]).toContain("解析失败");
  });

  it("装成另一产品时判定 mismatch", async () => {
    const root = "C:\\apps\\cn";
    const check = await verifyProductIdentity({
      root,
      expected: "workbuddy-cn",
      profile: emptyCn,
      counterpart: "workbuddy-ai",
      probe: probeWith({
        [`${root}\\product.json`]: JSON.stringify({ productName: "WorkBuddy AI", version: "5.8.4" }),
      }),
    });
    expect(check.verdict).toBe("mismatch");
    expect(check.reasons.join()).toContain("另一产品");
  });

  it("完全无关的产品名判定 mismatch（需人工确认）", async () => {
    const root = "C:\\apps\\other";
    const check = await verifyProductIdentity({
      root,
      expected: "workbuddy-cn",
      profile: emptyCn,
      counterpart: "workbuddy-ai",
      probe: probeWith({
        [`${root}\\product.json`]: JSON.stringify({ productName: "SomeOtherApp", version: "1.0.0" }),
      }),
    });
    expect(check.verdict).toBe("mismatch");
    expect(check.reasons.join()).toContain("SomeOtherApp");
  });
});

describe("verifyProductIdentity：有证据时升级为 verified", () => {
  it("产品名、数据目录、版本都与证据一致 → verified", async () => {
    const root = "C:\\apps\\cn";
    const check = await verifyProductIdentity({
      root,
      expected: "workbuddy-cn",
      profile: verifiedCn,
      counterpart: "workbuddy-ai",
      probe: probeWith({
        [`${root}\\resources\\app\\product.json`]: JSON.stringify({
          productName: "WorkBuddy",
          version: "5.8.3",
          dataFolderName: ".workbuddy",
        }),
      }),
    });
    expect(check.verdict).toBe("match");
    expect(check.confidence).toBe("verified");
  });

  it("版本不在已验证清单 → match 但 confidence 降为 observed", async () => {
    const root = "C:\\apps\\cn";
    const check = await verifyProductIdentity({
      root,
      expected: "workbuddy-cn",
      profile: verifiedCn,
      counterpart: "workbuddy-ai",
      probe: probeWith({
        [`${root}\\product.json`]: JSON.stringify({ productName: "WorkBuddy", version: "9.9.9" }),
      }),
    });
    expect(check.verdict).toBe("match");
    expect(check.confidence).toBe("observed");
    expect(check.reasons.join()).toContain("不在已验证版本清单");
  });

  it("数据目录名不符 → mismatch", async () => {
    const root = "C:\\apps\\cn";
    const check = await verifyProductIdentity({
      root,
      expected: "workbuddy-cn",
      profile: verifiedCn,
      counterpart: "workbuddy-ai",
      probe: probeWith({
        [`${root}\\product.json`]: JSON.stringify({
          productName: "WorkBuddy",
          version: "5.8.3",
          dataFolderName: ".workbuddy-ai",
        }),
      }),
    });
    expect(check.verdict).toBe("mismatch");
    expect(check.reasons.join()).toContain("数据目录名");
  });
});

describe("asar 元数据与 productName", () => {
  function asarProbe(pkg: Record<string, unknown>): FileProbe {
    return {
      readText: async () => null,
      isFile: async () => false,
      readAsarText: async (_asar, entry) => (entry === "package.json" ? JSON.stringify(pkg) : null),
    };
  }

  it("普通文件缺失时从 app.asar 读取 package.json", async () => {
    const root = "C:\\apps\\ai";
    const check = await verifyProductIdentity({
      root,
      expected: "workbuddy-ai",
      profile: emptyAi,
      counterpart: "workbuddy-cn",
      probe: asarProbe({ name: "@genie/workbuddy-desktop", productName: "WorkBuddy AI", version: "5.8.4" }),
    });
    expect(check.verdict).toBe("match");
    expect(check.observedProductName).toBe("WorkBuddy AI");
    expect(check.metadataSource).toContain("app.asar");
  });

  it("productName 优先于两版相同的 name", async () => {
    const root = "C:\\apps\\cn";
    const check = await verifyProductIdentity({
      root,
      expected: "workbuddy-cn",
      profile: emptyCn,
      counterpart: "workbuddy-ai",
      probe: asarProbe({ name: "@genie/workbuddy-desktop", productName: "WorkBuddy", version: "5.8.3" }),
    });
    expect(check.verdict).toBe("match");
    expect(check.observedProductName).toBe("WorkBuddy");
    expect(check.fields[0]?.field).toBe("productName");
  });

  it("asar 内 package.json 损坏时返回 unknown 并说明来源", async () => {
    const probe: FileProbe = {
      readText: async () => null,
      isFile: async () => false,
      readAsarText: async () => "{oops",
    };
    const check = await verifyProductIdentity({
      root: "C:\\apps\\broken",
      expected: "workbuddy-cn",
      profile: emptyCn,
      counterpart: "workbuddy-ai",
      probe,
    });
    expect(check.verdict).toBe("unknown");
    expect(check.reasons[0]).toContain("解析失败");
  });
});

describe("hintFromName", () => {
  it("只把名称当作线索，不构成归类", () => {
    expect(hintFromName("WorkBuddy")).toBe("workbuddy-cn");
    expect(hintFromName("WorkBuddy AI")).toBe("workbuddy-ai");
    expect(hintFromName("WorkBuddy 国际版")).toBe("workbuddy-ai");
    expect(hintFromName("SomeOtherApp")).toBeNull();
  });
});
