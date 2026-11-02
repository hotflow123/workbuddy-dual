import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  deriveLocationCandidates,
  scanInstallations,
  type RegistryEntry,
  type ScanDeps,
} from "../../src/core/scanner";
import type { FileProbe } from "../../src/core/identity";
import type { ProductProfile } from "../../src/core/contracts";

/**
 * 测试数据全部使用合成的 C:\wb-test 目录，不含任何真实机器路径。
 */

const BASE = "C:\\wb-test";
const CN = path.join(BASE, "cn");
const AI = path.join(BASE, "ai");

const cnProfile: ProductProfile = {
  product: "workbuddy-cn",
  displayName: "国内版 WorkBuddy",
  productNames: ["WorkBuddy"],
  dataFolderNames: [".workbuddy"],
  trustedSignerSubjects: ["CN=Tencent"],
  installerArguments: [],
  executableRelativePath: null,
  trust: "verified",
  evidence: null,
  verifiedVersions: ["5.8.3"],
};

const aiProfile: ProductProfile = {
  ...cnProfile,
  product: "workbuddy-ai",
  displayName: "国际版 WorkBuddy AI",
  productNames: ["WorkBuddy AI"],
  dataFolderNames: [".workbuddy-ai"],
  verifiedVersions: ["5.8.4"],
};

/** 无证据包时的空基线 */
const emptyProfiles: ProductProfile[] = [
  { ...cnProfile, productNames: [], dataFolderNames: [], verifiedVersions: [], trust: "unverified" },
  { ...aiProfile, productNames: [], dataFolderNames: [], verifiedVersions: [], trust: "unverified" },
];

interface FakeOptions {
  entries?: RegistryEntry[];
  files?: Record<string, string>;
  dirs?: string[];
  reparse?: string[];
  shortcuts?: { file: string; target: string | null }[];
  processes?: { path: string; name: string }[];
  commonLocations?: { path: string; source: string }[];
  roots?: Record<string, string[]>;
  skipped?: { source: string; reason: string }[];
}

function metadata(productName: string, version: string, dataFolderName?: string): string {
  return JSON.stringify({ productName, version, ...(dataFolderName ? { dataFolderName } : {}) });
}

function makeDeps(options: FakeOptions): ScanDeps {
  const files = options.files ?? {};
  const dirs = new Set((options.dirs ?? []).map((d) => path.normalize(d)));
  const probe: FileProbe = {
    readText: async (file) => files[path.normalize(file)] ?? null,
    isFile: async (file) => path.normalize(file) in files,
  };
  return {
    registry: {
      readUninstallEntries: async () => ({ entries: options.entries ?? [], skipped: options.skipped ?? [] }),
    },
    probe,
    existsPath: async (target) => dirs.has(path.normalize(target)) || path.normalize(target) in files,
    listDirectory: async (dir) => {
      const found = options.roots?.[path.normalize(dir)];
      if (!found) throw new Error("EACCES: 拒绝访问");
      return found;
    },
    isReparsePoint: async (target) => (options.reparse ?? []).includes(path.normalize(target)),
    shortcuts: options.shortcuts ? { list: async () => options.shortcuts ?? [] } : undefined,
    processes: options.processes ? { list: async () => options.processes ?? [] } : undefined,
    commonLocations: options.commonLocations ? { list: async () => options.commonLocations ?? [] } : undefined,
  };
}

function entry(values: Record<string, string>, view: RegistryEntry["view"] = "HKLM64"): RegistryEntry {
  return { view, key: `HKCU\\...\\Uninstall\\{${Math.random().toString(16).slice(2, 8)}}`, values };
}

async function scan(options: FakeOptions, extra: Partial<Parameters<typeof scanInstallations>[0]> = {}) {
  return scanInstallations({
    deps: makeDeps(options),
    profiles: [cnProfile, aiProfile],
    userRoots: [],
    managed: [],
    ...extra,
  });
}

describe("scanInstallations：登记与路径解析", () => {
  it("有 InstallLocation 时按登记路径识别两版", async () => {
    const report = await scan({
      entries: [
        entry({ DisplayName: "WorkBuddy", DisplayVersion: "5.8.3", InstallLocation: CN }),
        entry({ DisplayName: "WorkBuddy AI", DisplayVersion: "5.8.4", InstallLocation: AI }, "HKCU"),
      ],
      files: {
        [path.join(CN, "resources", "app", "product.json")]: metadata("WorkBuddy", "5.8.3"),
        [path.join(AI, "resources", "app", "product.json")]: metadata("WorkBuddy AI", "5.8.4"),
      },
      dirs: [CN, AI],
    });

    expect(report.readOnly).toBe(true);
    expect(report.records).toHaveLength(2);
    const cn = report.records.find((r) => r.product === "workbuddy-cn");
    const ai = report.records.find((r) => r.product === "workbuddy-ai");
    expect(cn?.discovery).toBe("path-found");
    expect(cn?.identity).toBe("identified");
    expect(cn?.locationSource).toBe("registry");
    expect(ai?.identity).toBe("identified");
    expect(report.products.map((p) => p.state)).toEqual(["found", "found"]);
  });

  it("InstallLocation 为空但 DisplayIcon 指向有效目录时推导路径", async () => {
    const report = await scan({
      entries: [entry({ DisplayName: "WorkBuddy", DisplayVersion: "5.8.3", DisplayIcon: `${CN}\\WorkBuddy.exe,0` })],
      files: { [path.join(CN, "product.json")]: metadata("WorkBuddy", "5.8.3") },
      dirs: [CN],
    });
    const record = report.records[0];
    expect(record?.installLocation).toBe(CN);
    expect(record?.locationSource).toBe("derived-display-icon");
    expect(record?.discovery).toBe("path-found");
    expect(record?.product).toBe("workbuddy-cn");
  });

  it("InstallLocation 为空但 UninstallString 可用时推导路径（只解析不执行）", async () => {
    const report = await scan({
      entries: [
        entry({
          DisplayName: "WorkBuddy AI",
          DisplayVersion: "5.8.4",
          UninstallString: `"${AI}\\Uninstall WorkBuddy AI.exe" /S`,
        }),
      ],
      files: { [path.join(AI, "package.json")]: metadata("WorkBuddy AI", "5.8.4") },
      dirs: [AI],
    });
    const record = report.records[0];
    expect(record?.installLocation).toBe(AI);
    expect(record?.locationSource).toBe("derived-uninstall-string");
    expect(record?.product).toBe("workbuddy-ai");
    // 扫描器没有任何执行能力：UninstallString 只被当作字符串解析
    expect(record?.uninstallString).toContain("Uninstall WorkBuddy AI.exe");
  });

  it("InstallSource 指向有效目录时也能推导", async () => {
    const report = await scan({
      entries: [entry({ DisplayName: "WorkBuddy", InstallSource: `${CN}\\` })],
      files: { [path.join(CN, "product.json")]: metadata("WorkBuddy", "5.8.3") },
      dirs: [CN],
    });
    expect(report.records[0]?.locationSource).toBe("derived-install-source");
  });

  it("完全无法解析路径时保留为“登记已发现，路径待解析”", async () => {
    const report = await scan({
      entries: [entry({ DisplayName: "WorkBuddy AI", DisplayVersion: "5.8.4" })],
      dirs: [],
    });
    const record = report.records[0];
    expect(record?.discovery).toBe("registry-only");
    expect(record?.installLocation).toBeNull();
    expect(record?.productHint).toBe("workbuddy-ai");
    expect(report.products[1]?.state).toBe("pending-path");
    expect(report.conflicts.join()).toContain("登记已发现");
  });

  it("登记路径不存在时不会假装找到了安装", async () => {
    const report = await scan({
      entries: [entry({ DisplayName: "WorkBuddy", InstallLocation: "C:\\wb-test\\gone" })],
      dirs: [],
    });
    expect(report.records[0]?.discovery).toBe("registry-only");
    expect(report.records[0]?.conflicts).toContain("path-missing");
  });

  it("同一路径的重复登记合并为一份安装并标注", async () => {
    const report = await scan({
      entries: [
        entry({ DisplayName: "WorkBuddy AI", DisplayVersion: "5.8.4", InstallLocation: AI }),
        entry({ DisplayName: "WorkBuddy AI", DisplayVersion: "5.8.4", InstallLocation: AI }, "HKCU"),
      ],
      files: { [path.join(AI, "product.json")]: metadata("WorkBuddy AI", "5.8.4") },
      dirs: [AI],
    });
    expect(report.records).toHaveLength(1);
    expect(report.records[0]?.duplicateRegistrations).toBe(2);
    expect(report.records[0]?.conflicts).toContain("duplicate-registration");
    expect(report.products[1]?.copyCount).toBe(1);
  });

  it("同一产品的多份安装按路径分别列出", async () => {
    const second = path.join(BASE, "cn-copy");
    const report = await scan({
      entries: [
        entry({ DisplayName: "WorkBuddy", DisplayVersion: "5.8.3", InstallLocation: CN }),
        entry({ DisplayName: "WorkBuddy", DisplayVersion: "5.8.3", InstallLocation: second }, "HKLM32"),
      ],
      files: {
        [path.join(CN, "product.json")]: metadata("WorkBuddy", "5.8.3"),
        [path.join(second, "product.json")]: metadata("WorkBuddy", "5.8.3"),
      },
      dirs: [CN, second],
    });
    const cn = report.products[0];
    expect(cn?.copyCount).toBe(2);
    expect(cn?.installs).toHaveLength(2);
    expect(report.conflicts.join()).toContain("发现 2 份安装");
  });

  it("同一路径登记版本不一致时标记需人工确认", async () => {
    const report = await scan({
      entries: [
        entry({ DisplayName: "WorkBuddy", DisplayVersion: "5.8.3", InstallLocation: CN }),
        entry({ DisplayName: "WorkBuddy", DisplayVersion: "5.8.1", InstallLocation: CN }, "HKLM32"),
      ],
      files: { [path.join(CN, "product.json")]: metadata("WorkBuddy", "5.8.3") },
      dirs: [CN],
    });
    expect(report.records[0]?.needsReview).toBe(true);
    expect(report.records[0]?.conflicts).toContain("version-conflict");
  });
});

describe("scanInstallations：其他线索来源", () => {
  it("从运行进程的可执行路径发现", async () => {
    const report = await scan({
      processes: [{ path: `${CN}\\WorkBuddy.exe`, name: "WorkBuddy.exe" }],
      files: { [path.join(CN, "product.json")]: metadata("WorkBuddy", "5.8.3") },
      dirs: [CN],
    });
    const record = report.records[0];
    expect(record?.installLocation).toBe(CN);
    expect(record?.clues[0]?.kind).toBe("process");
    expect(record?.product).toBe("workbuddy-cn");
  });

  it("忽略系统临时目录中的 WorkBuddy 解包副本，不列为安装候选", async () => {
    const tempRoot = "C:\\Users\\test\\AppData\\Local\\Temp";
    const temporaryInstall = path.join(tempRoot, "wb-update-abc123", "apps", "WorkBuddy-CN");
    const report = await scan(
      {
        processes: [{ path: path.join(temporaryInstall, "WorkBuddy.exe"), name: "WorkBuddy.exe" }],
        files: {
          [path.join(temporaryInstall, "product.json")]: metadata("WorkBuddy", "5.8.3"),
        },
        dirs: [temporaryInstall],
      },
      { temporaryDirectory: tempRoot },
    );

    expect(report.records).toEqual([]);
    expect(report.products.map((product) => product.state)).toEqual(["not-found", "not-found"]);
    expect(report.sources).toEqual([]);
  });

  it("从有界常见安装位置发现", async () => {
    const report = await scan({
      commonLocations: [{ path: AI, source: "%ProgramFiles%" }],
      files: { [path.join(AI, "product.json")]: metadata("WorkBuddy AI", "5.8.4") },
      dirs: [AI],
    });
    expect(report.records[0]?.clues[0]?.kind).toBe("common-location");
    expect(report.records[0]?.product).toBe("workbuddy-ai");
  });

  it("从用户指定目录补扫发现，并跳过不存在的子目录", async () => {
    const report = await scan(
      {
        roots: { [BASE]: ["WorkBuddy", "WorkBuddy-old", "Other"] },
        files: { [path.join(BASE, "WorkBuddy", "product.json")]: metadata("WorkBuddy", "5.8.3") },
        dirs: [path.join(BASE, "WorkBuddy")],
      },
      { userRoots: [BASE] },
    );
    const record = report.records.find((r) => r.clues.some((c) => c.kind === "user-root"));
    expect(record?.installLocation).toBe(path.join(BASE, "WorkBuddy"));
    expect(report.skippedSources.map((s) => s.reason).join()).toContain("不存在或不可读");
  });

  it("快捷方式目标与登记指向同一路径时只保留一份，并合并线索", async () => {
    const report = await scan({
      entries: [entry({ DisplayName: "WorkBuddy", InstallLocation: CN })],
      shortcuts: [{ file: "C:\\sm\\WorkBuddy.lnk", target: `${CN}\\WorkBuddy.exe` }],
      files: { [path.join(CN, "product.json")]: metadata("WorkBuddy", "5.8.3") },
      dirs: [CN],
    });
    expect(report.records).toHaveLength(1);
    expect(report.records[0]?.clues.map((c) => c.kind).sort()).toEqual(["registry", "shortcut"]);
  });

  it("无关的坏快捷方式不计入 WorkBuddy 跳过项，只做弱化汇总", async () => {
    const report = await scan({
      shortcuts: [
        { file: "C:\\sm\\Excel.lnk", target: null },
        { file: "C:\\sm\\Chrome.lnk", target: null },
        { file: "C:\\sm\\Other.lnk", target: "C:\\wb-test\\other\\x.exe" },
      ],
      dirs: [],
    });
    expect(report.records).toHaveLength(0);
    const affecting = report.skippedSources.filter((s) => s.source !== "shortcuts:unrelated");
    expect(affecting).toHaveLength(0);
    const ignored = report.skippedSources.find((s) => s.source === "shortcuts:unrelated");
    expect(ignored?.reason).toContain("已忽略");
  });

  it("名称相关的坏快捷方式形成汇总提示，且数量按条统计", async () => {
    const report = await scan({
      shortcuts: [
        { file: "C:\\sm\\WorkBuddy.lnk", target: null },
        { file: "C:\\sm\\WorkBuddy AI.lnk", target: null },
        { file: "C:\\sm\\Excel.lnk", target: null },
      ],
      dirs: [],
    });
    const related = report.skippedSources.find((s) => s.source === "shortcuts");
    expect(related?.reason).toContain("2 个与 WorkBuddy 相关");
    const ignored = report.skippedSources.find((s) => s.source === "shortcuts:unrelated");
    expect(ignored?.reason).toContain("1 个");
  });

  it("同一目录的多条线索只算一份安装，线索计数按去重后的线索数", async () => {
    const report = await scan({
      entries: [
        entry({ DisplayName: "WorkBuddy", InstallLocation: CN }),
        entry({ DisplayName: "WorkBuddy", InstallLocation: CN }, "HKCU"),
      ],
      shortcuts: [
        { file: "C:\\sm\\WorkBuddy.lnk", target: `${CN}\\WorkBuddy.exe` },
        { file: "C:\\sm\\WorkBuddy 快捷方式.lnk", target: `${CN}\\WorkBuddy.exe` },
      ],
      processes: [
        { path: `${CN}\\WorkBuddy.exe`, name: "WorkBuddy.exe" },
        { path: `${CN}\\WorkBuddy.exe`, name: "WorkBuddy.exe" },
        { path: `${CN}\\WorkBuddy.exe`, name: "WorkBuddy.exe" },
      ],
      files: { [path.join(CN, "product.json")]: metadata("WorkBuddy", "5.8.3") },
      dirs: [CN],
    });

    expect(report.records).toHaveLength(1);
    expect(report.products[0]?.copyCount).toBe(1);
    // 两个注册表视图 + 两个快捷方式 + 一个进程路径，都是线索；安装仍然只有 1 份
    expect(report.products[0]?.installs[0]?.clues.map((c) => c.kind).sort()).toEqual([
      "process",
      "registry",
      "registry",
      "shortcut",
      "shortcut",
    ]);
    const counts = Object.fromEntries(report.sources.map((s) => [s.kind, s.count]));
    expect(counts["process"]).toBe(1);
    expect(counts["registry"]).toBe(2);
    expect(counts["shortcut"]).toBe(2);
  });

  it("用户目录不可读时记录跳过原因而不抛错", async () => {
    const report = await scan({ roots: {} }, { userRoots: ["D:\\no-access"] });
    expect(report.skippedSources[0]?.source).toContain("D:\\no-access");
  });

  it("汇总线索来源计数", async () => {
    const report = await scan({
      entries: [entry({ DisplayName: "WorkBuddy", InstallLocation: CN })],
      shortcuts: [{ file: "C:\\sm\\WorkBuddy AI.lnk", target: `${AI}\\WorkBuddyAI.exe` }],
      files: {
        [path.join(CN, "product.json")]: metadata("WorkBuddy", "5.8.3"),
        [path.join(AI, "product.json")]: metadata("WorkBuddy AI", "5.8.4"),
      },
      dirs: [CN, AI],
    });
    const kinds = report.sources.map((s) => s.kind);
    expect(kinds).toContain("registry");
    expect(kinds).toContain("shortcut");
  });
});

describe("scanInstallations：身份与安全状态分离", () => {
  it("没有证据包时仍能识别产品（observed），但不会给出写操作授权", async () => {
    const report = await scan(
      {
        entries: [entry({ DisplayName: "WorkBuddy", DisplayVersion: "5.8.3", InstallLocation: CN })],
        files: { [path.join(CN, "product.json")]: metadata("WorkBuddy", "5.8.3") },
        dirs: [CN],
      },
      { profiles: emptyProfiles },
    );
    const record = report.records[0];
    expect(record?.identity).toBe("identified");
    expect(record?.product).toBe("workbuddy-cn");
    expect(record?.identityCheck?.confidence).toBe("observed");
    expect(record?.conflicts).toContain("unverified-profile");
    expect(report.products[0]?.state).toBe("found");
  });

  it("读不到元数据时标记身份待确认，而不是判成未发现", async () => {
    const report = await scan({
      entries: [entry({ DisplayName: "WorkBuddy", InstallLocation: CN })],
      dirs: [CN],
    });
    const record = report.records[0];
    expect(record?.discovery).toBe("path-found");
    expect(record?.identity).toBe("unverified");
    expect(record?.product).toBeNull();
    expect(report.products[0]?.state).toBe("not-found");
    expect(report.products[0]?.pendingPath).toHaveLength(0);
  });

  it("产品名与两个已知产品都不匹配时标记身份冲突并需人工确认", async () => {
    const other = path.join(BASE, "other");
    const report = await scan({
      entries: [entry({ DisplayName: "WorkBuddy", InstallLocation: other })],
      files: { [path.join(other, "product.json")]: metadata("SomeOtherApp", "1.0.0") },
      dirs: [other],
    });
    const record = report.records[0];
    expect(record?.identity).toBe("conflict");
    expect(record?.needsReview).toBe(true);
    expect(record?.conflicts).toContain("identity-mismatch");
  });

  it("重解析点目录标记需人工确认", async () => {
    const report = await scan({
      entries: [entry({ DisplayName: "WorkBuddy", InstallLocation: CN })],
      files: { [path.join(CN, "product.json")]: metadata("WorkBuddy", "5.8.3") },
      dirs: [CN],
      reparse: [CN],
    });
    expect(report.records[0]?.needsReview).toBe(true);
    expect(report.records[0]?.conflicts).toContain("reparse-point");
  });

  it("管理器自身目录保留为诊断，但不计入任何产品、也不标成需人工确认", async () => {
    const selfDir = path.join(BASE, "manager");
    const report = await scan(
      {
        entries: [entry({ DisplayName: "WorkBuddy Dual Edition Manager", InstallLocation: selfDir })],
        files: {
          [path.join(selfDir, "package.json")]: JSON.stringify({ name: "workbuddy-dual-edition-manager", version: "0.1.0" }),
        },
        dirs: [selfDir],
      },
      { selfDirectories: [selfDir] },
    );
    const record = report.records[0];
    expect(record?.isManagerSelf).toBe(true);
    expect(record?.product).toBeNull();
    expect(record?.needsReview).toBe(false);
    expect(record?.conflicts).toContain("manager-self");
    expect(report.products.every((p) => p.installs.every((i) => !i.isManagerSelf))).toBe(true);
    expect(report.products.map((p) => p.state)).toEqual(["not-found", "not-found"]);
  });

  it("元数据与已知产品不匹配的候选：保留冲突诊断，但不计入任一产品", async () => {
    const other = path.join(BASE, "third-party");
    const report = await scan({
      entries: [entry({ DisplayName: "WorkBuddy Helper", InstallLocation: other })],
      files: { [path.join(other, "product.json")]: metadata("ThirdPartyApp", "1.2.3") },
      dirs: [other],
    });
    const record = report.records[0];
    expect(record?.identity).toBe("conflict");
    expect(record?.needsReview).toBe(true);
    expect(record?.product).toBeNull();
    expect(report.products.every((p) => p.installs.length === 0)).toBe(true);
    expect(report.conflicts.join()).toContain("需人工确认");
  });

  it("元数据损坏标记 corrupt-metadata 并需人工确认", async () => {
    const report = await scan({
      entries: [entry({ DisplayName: "WorkBuddy", InstallLocation: CN })],
      files: { [path.join(CN, "product.json")]: "{broken" },
      dirs: [CN],
    });
    expect(report.records[0]?.conflicts).toContain("corrupt-metadata");
    expect(report.records[0]?.needsReview).toBe(true);
  });
});

describe("deriveLocationCandidates", () => {
  it("按 DisplayIcon → UninstallString → InstallSource 排序", () => {
    const candidates = deriveLocationCandidates({
      DisplayIcon: "C:\\a\\app.exe,0",
      UninstallString: '"C:\\b\\uninst.exe" /S',
      InstallSource: "C:\\c\\",
    });
    expect(candidates.map((c) => c.source)).toEqual([
      "derived-display-icon",
      "derived-uninstall-string",
      "derived-install-source",
    ]);
  });

  it("msiexec 等系统卸载器不被当作安装目录", () => {
    expect(deriveLocationCandidates({ UninstallString: "MsiExec.exe /X{1234-5678}" })).toHaveLength(0);
  });

  it("相对路径被拒绝", () => {
    expect(deriveLocationCandidates({ UninstallString: "uninst.exe" })).toHaveLength(0);
  });

  it("空登记返回空列表", () => {
    expect(deriveLocationCandidates({})).toHaveLength(0);
  });
});

describe("进程线索：盘符根与非法路径不产生安装记录", () => {
  it("D:\\ 进程线索被忽略，不产生记录也不计 process 来源", async () => {
    const report = await scan({
      processes: [{ path: "D:\\", name: "WorkBuddy.exe" }],
      dirs: ["D:\\"],
    });
    expect(report.records).toHaveLength(0);
    expect(report.sources.find((source) => source.kind === "process")).toBeUndefined();
    expect(report.products.every((product) => product.copyCount === 0)).toBe(true);
    expect(report.skippedSources.some((item) => item.source === "processes:invalid-path")).toBe(true);
  });

  it("卸载器、修复器、目录路径、临时目录都不成为安装记录", async () => {
    const tempDir = path.join(os.tmpdir(), "wb-pack-1");
    const report = await scan({
      processes: [
        { path: "D:\\Apps\\WorkBuddy\\Uninstall WorkBuddy.exe", name: "WorkBuddy.exe" },
        { path: "D:\\Apps\\WorkBuddy\\RepairApp.exe", name: "WorkBuddy.exe" },
        { path: "D:\\Apps\\WorkBuddy", name: "WorkBuddy.exe" },
        { path: path.join(tempDir, "WorkBuddy.exe"), name: "WorkBuddy.exe" },
      ],
      dirs: ["D:\\Apps\\WorkBuddy", tempDir],
    });
    expect(report.records).toHaveLength(0);
    const reasons = report.skippedSources.filter((item) => item.source === "processes:invalid-path");
    expect(reasons.length).toBeGreaterThanOrEqual(4);
  });

  it("真实客户端进程路径仍能发现安装，且目录不是盘符根", async () => {
    const report = await scan({
      processes: [{ path: path.join(CN, "WorkBuddy.exe"), name: "WorkBuddy.exe" }],
      files: { [path.join(CN, "product.json")]: metadata("WorkBuddy", "5.8.3") },
      dirs: [CN],
    });
    expect(report.records).toHaveLength(1);
    expect(report.records[0]?.installLocation).toBe(CN);
    expect(report.records[0]?.product).toBe("workbuddy-cn");
    expect(report.sources.find((source) => source.kind === "process")?.count).toBe(1);
  });
});
