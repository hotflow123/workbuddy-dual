import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AppService } from "../../src/main/services/appService";
import { NodeFsPort } from "../../src/main/adapters/fsPort";
import { PathGuard } from "../../src/core/pathGuard";
import { replaceInstanceInPlace } from "../../src/core/managedInstall";
import { parseUninstallInvocation } from "../../src/core/assisted";
import { OFFICIAL_SITES } from "../../src/core/knownProducts";
import type { JournalStore } from "../../src/core/journal";
import type { InstallRecord, ProductDiscovery, ScanReport } from "../../src/core/contracts";
import type { ArchivePort } from "../../src/main/adapters/sevenZip";

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

const OUTER = ["Setup.exe", "app-64.7z", "$PLUGINSDIR/System.dll"];
const INNER = [
  "resources/app/package.json",
  "resources/app.asar",
  "WorkBuddy.exe",
  "ffmpeg.dll",
  "libEGL.dll",
];

function fakeArchive(version: () => string, productName = "WorkBuddy"): ArchivePort {
  return {
    async list(archive) {
      if (archive.endsWith(".exe")) return OUTER;
      if (archive.endsWith("app-64.7z")) return INNER;
      return [];
    },
    async extract(archive, destination) {
      const files = archive.endsWith(".exe")
        ? { "Setup.exe": "stub", "app-64.7z": "stub" }
        : {
            "resources/app/package.json": JSON.stringify({ productName, version: version() }, null, 2),
            "resources/app.asar": `asar-${version()}`,
            "WorkBuddy.exe": `exe-${version()}`,
            "ffmpeg.dll": "dll",
            "libEGL.dll": "dll",
          };
      for (const [relative, content] of Object.entries(files)) {
        const target = path.join(destination, relative);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, content, "utf8");
      }
    },
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

function record(installLocation: string): InstallRecord {
  return {
    id: `path:${installLocation.toLowerCase()}`,
    product: "workbuddy-cn",
    productHint: "workbuddy-cn",
    displayName: "WorkBuddy",
    displayVersion: "5.8.2",
    publisher: "Tencent",
    installLocation,
    locationSource: "registry",
    uninstallString: `"${path.join(installLocation, "Uninstall WorkBuddy.exe")}" /currentuser`,
    primarySource: "registry",
    clues: [{ kind: "registry", source: "WorkBuddy", detail: installLocation }],
    discovery: "path-found",
    identity: "identified",
    identityCheck: {
      root: installLocation,
      expected: "workbuddy-cn",
      verdict: "match",
      confidence: "observed",
      observedProductName: "WorkBuddy",
      observedVersion: "5.8.2",
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
  };
}

/* ------------------------------------------------------------------ 官网入口 */

describe("官网入口映射", () => {
  it("两个产品各绑定固定 HTTPS 官网，不含下载直链", () => {
    expect(OFFICIAL_SITES["workbuddy-cn"].url).toBe("https://www.workbuddy.cn/");
    expect(OFFICIAL_SITES["workbuddy-ai"].url).toBe("https://www.workbuddy.ai/");
    for (const site of Object.values(OFFICIAL_SITES)) {
      expect(site.url.startsWith("https://")).toBe(true);
      expect(site.url).not.toMatch(/\.(exe|msi|7z|zip)$/i);
      expect(site.url).not.toContain("?");
    }
  });

  it("openOfficialSite 只传产品 id，URL 由主进程查表生成", async () => {
    const opened: string[] = [];
    const service = new AppService({
      appVersion: "test",
      stateDir: await fsp.mkdtemp(path.join(os.tmpdir(), "wb-official-")),
      managementRoot: await fsp.mkdtemp(path.join(os.tmpdir(), "wb-official-m-")),
      isWindows: true,
      portable: false,
      selfDirectories: [],
      fs: new NodeFsPort(),
      registry: { readUninstallEntries: async () => ({ entries: [], skipped: [] }) },
      journal: memoryJournal(),
      now: () => "2026-10-19T00:00:00.000Z",
      bundledEvidenceFile: path.join(os.tmpdir(), "missing.json"),
      configDirectory: os.tmpdir(),
      openExternal: async (url) => {
        opened.push(url);
      },
      env: {},
      scanImplementation: async () => emptyReport(),
    });
    await service.init();

    const cn = await service.openOfficialSite("workbuddy-cn");
    const ai = await service.openOfficialSite("workbuddy-ai");
    expect(cn.ok).toBe(true);
    expect(ai.ok).toBe(true);
    expect(opened).toEqual(["https://www.workbuddy.cn/", "https://www.workbuddy.ai/"]);
  });

  it("没有 openExternal 时如实报错，不静默失败", async () => {
    const service = new AppService({
      appVersion: "test",
      stateDir: await fsp.mkdtemp(path.join(os.tmpdir(), "wb-official2-")),
      managementRoot: await fsp.mkdtemp(path.join(os.tmpdir(), "wb-official2-m-")),
      isWindows: true,
      portable: false,
      selfDirectories: [],
      fs: new NodeFsPort(),
      registry: { readUninstallEntries: async () => ({ entries: [], skipped: [] }) },
      journal: memoryJournal(),
      now: () => "2026-10-19T00:00:00.000Z",
      bundledEvidenceFile: path.join(os.tmpdir(), "missing.json"),
      configDirectory: os.tmpdir(),
      env: {},
      scanImplementation: async () => emptyReport(),
    });
    await service.init();
    const result = await service.openOfficialSite("workbuddy-cn");
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ 卸载命令解析 */

describe("parseUninstallInvocation", () => {
  it("解析带引号路径与 /currentuser", () => {
    const parsed = parseUninstallInvocation('"E:\\Programs\\workbuddy\\Uninstall WorkBuddy.exe" /currentuser');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.executable).toBe("E:\\Programs\\workbuddy\\Uninstall WorkBuddy.exe");
      expect(parsed.value.args).toEqual(["/currentuser"]);
    }
  });

  it("解析无引号命令", () => {
    const parsed = parseUninstallInvocation("C:\\Apps\\uninst.exe");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.args).toEqual([]);
  });

  it("拒绝静默与其他未获允许的参数", () => {
    for (const bad of ['"C:\\a\\uninst.exe" /S', '"C:\\a\\uninst.exe" /D=C:\\other']) {
      const parsed = parseUninstallInvocation(bad);
      expect(parsed.ok, bad).toBe(false);
    }
  });

  it("拒绝空命令", () => {
    expect(parseUninstallInvocation(null).ok).toBe(false);
    expect(parseUninstallInvocation("   ").ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ 原位替换 */

describe("replaceInstanceInPlace", () => {
  async function setup() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-inplace-"));
    const managementRoot = path.join(root, "managed");
    const target = path.join(root, "installed", "WorkBuddy");
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, "WorkBuddy.exe"), "old-exe", "utf8");
    await fsp.mkdir(path.join(target, "resources", "app"), { recursive: true });
    await fsp.writeFile(
      path.join(target, "resources", "app", "package.json"),
      JSON.stringify({ productName: "WorkBuddy", version: "5.8.2" }),
      "utf8",
    );
    await fsp.writeFile(path.join(target, "resources", "app.asar"), "old-asar", "utf8");
    await fsp.writeFile(path.join(target, "ffmpeg.dll"), "dll", "utf8");
    // 官方安装目录里的卸载器不在内层 app-64.7z 里，更新时必须被保留
    await fsp.writeFile(path.join(target, "Uninstall WorkBuddy.exe"), "old-uninstaller", "utf8");
    await fsp.writeFile(path.join(target, "version"), "1", "utf8");
    await fsp.mkdir(managementRoot, { recursive: true });
    const packageFile = path.join(root, "pkg.exe");
    await fsp.writeFile(packageFile, "stub", "utf8");
    return { root, managementRoot, target, packageFile };
  }

  it("成功时替换目标目录内容并保留旧目录", async () => {
    const { root, managementRoot, target, packageFile } = await setup();
    const fsPort = new NodeFsPort();
    const result = await replaceInstanceInPlace(
      {
        operationId: "op-inplace-1",
        product: "workbuddy-cn",
        version: "5.8.3",
        packagePath: packageFile,
        packageCheck: {
          file: packageFile,
          sizeBytes: 1,
          sha256: "a".repeat(64),
          authenticode: null,
          productName: "WorkBuddy",
          productVersion: "5.8.3",
          verdict: "unknown",
          reasons: [],
        },
        targetDirectory: target,
        stagingDirectory: path.join(managementRoot, ".staging", "op-inplace-1"),
        backupDirectory: path.join(managementRoot, "backups"),
      },
      {
        fs: fsPort,
        tree: fsPort,
        guard: new PathGuard({ managementRoot, externalRoots: [target] }),
        archive: fakeArchive(() => "5.8.3"),
        journal: memoryJournal(),
        now: () => "2026-10-19T00:00:00.000Z",
        verifyInstalled: async () => ({ ok: true }),
      },
    );
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    expect(await fsp.readFile(path.join(target, "WorkBuddy.exe"), "utf8")).toBe("exe-5.8.3");
    // 卸载器与版本标记必须仍在，否则更新后无法卸载
    expect(await fsp.readFile(path.join(target, "Uninstall WorkBuddy.exe"), "utf8")).toBe("old-uninstaller");
    expect(await fsp.readFile(path.join(target, "version"), "utf8")).toBe("1");
    if (result.ok) {
      expect(result.value.preservedFiles).toContain("Uninstall WorkBuddy.exe");
      expect(await fsp.stat(result.value.retiredDirectory).then(() => true).catch(() => false)).toBe(true);
      expect(await fsp.stat(result.value.backupDirectory).then(() => true).catch(() => false)).toBe(true);
    }
    expect(root).toBeTruthy();
  });

  it("校验失败时回滚到旧版本", async () => {
    const { managementRoot, target, packageFile } = await setup();
    const fsPort = new NodeFsPort();
    const result = await replaceInstanceInPlace(
      {
        operationId: "op-inplace-2",
        product: "workbuddy-cn",
        version: "5.8.3",
        packagePath: packageFile,
        packageCheck: {
          file: packageFile,
          sizeBytes: 1,
          sha256: "b".repeat(64),
          authenticode: null,
          productName: "WorkBuddy",
          productVersion: "5.8.3",
          verdict: "unknown",
          reasons: [],
        },
        targetDirectory: target,
        stagingDirectory: path.join(managementRoot, ".staging", "op-inplace-2"),
        backupDirectory: path.join(managementRoot, "backups"),
      },
      {
        fs: fsPort,
        tree: fsPort,
        guard: new PathGuard({ managementRoot, externalRoots: [target] }),
        archive: fakeArchive(() => "5.8.3"),
        journal: memoryJournal(),
        now: () => "2026-10-19T00:00:00.000Z",
        verifyInstalled: async () => ({ ok: false, reason: "身份不符" }),
      },
    );
    expect(result.ok).toBe(false);
    // 旧版本必须回来
    expect(await fsp.readFile(path.join(target, "WorkBuddy.exe"), "utf8")).toBe("old-exe");
  });

  it("目标目录不在管理根内且未登记为外部根时拒绝", async () => {
    const { managementRoot, target, packageFile } = await setup();
    const fsPort = new NodeFsPort();
    const result = await replaceInstanceInPlace(
      {
        operationId: "op-inplace-3",
        product: "workbuddy-cn",
        version: "5.8.3",
        packagePath: packageFile,
        packageCheck: {
          file: packageFile,
          sizeBytes: 1,
          sha256: "c".repeat(64),
          authenticode: null,
          productName: "WorkBuddy",
          productVersion: "5.8.3",
          verdict: "unknown",
          reasons: [],
        },
        targetDirectory: target,
        stagingDirectory: path.join(managementRoot, ".staging", "op-inplace-3"),
        backupDirectory: path.join(managementRoot, "backups"),
      },
      {
        fs: fsPort,
        tree: fsPort,
        guard: new PathGuard({ managementRoot }),
        archive: fakeArchive(() => "5.8.3"),
        journal: memoryJournal(),
        now: () => "2026-10-19T00:00:00.000Z",
        verifyInstalled: async () => ({ ok: true }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_PATH_REJECTED");
  });
});

/* ------------------------------------------------------------------ 接管实例的官方卸载 */

describe("接管实例卸载（官方卸载器）", () => {
  async function makeAdoptedService(options: {
    command: (installDir: string) => string | null;
    signatureStatus?: string;
    productName?: string;
    removeOnRun?: boolean;
    removeClientExecutableOnly?: boolean;
    includeLocalUninstaller?: boolean;
  }) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-adopt-un-"));
    const installDir = path.join(root, "WorkBuddy");
    await fsp.mkdir(path.join(installDir, "resources", "app"), { recursive: true });
    await fsp.writeFile(
      path.join(installDir, "resources", "app", "package.json"),
      JSON.stringify({ productName: "WorkBuddy", version: "5.8.2" }),
      "utf8",
    );
    await fsp.writeFile(path.join(installDir, "resources", "app.asar"), "stub", "utf8");
    await fsp.writeFile(path.join(installDir, "WorkBuddy.exe"), "stub", "utf8");
    await fsp.writeFile(path.join(installDir, "ffmpeg.dll"), "stub", "utf8");
    if (options.includeLocalUninstaller !== false) {
      await fsp.writeFile(path.join(installDir, "Uninstall WorkBuddy.exe"), "stub", "utf8");
    }

    const uninstallCommand = options.command(installDir);
    const scanRecord = record(installDir);
    const report: ScanReport = {
      ...emptyReport(),
      records: [scanRecord],
      products: [
        { product: "workbuddy-cn", installs: [scanRecord], pendingPath: [], state: "found", copyCount: 1 } as ProductDiscovery,
        { product: "workbuddy-ai", installs: [], pendingPath: [], state: "not-found", copyCount: 0 } as ProductDiscovery,
      ],
    };
    let activeReport = report;

    const runner = vi.fn(async (_file: string, _args: string[]) => {
      if (options.removeClientExecutableOnly) {
        await fsp.rm(path.join(installDir, "WorkBuddy.exe"), { force: true });
      } else if (options.removeOnRun !== false) {
        await fsp.rm(installDir, { recursive: true, force: true });
      }
      return { exitCode: 0, timedOut: false };
    });

    const service = new AppService({
      appVersion: "test",
      stateDir: path.join(root, "state"),
      managementRoot: path.join(root, "managed"),
      isWindows: true,
      portable: false,
      selfDirectories: [],
      fs: new NodeFsPort(),
      registry: {
        readUninstallEntries: async () => ({
          entries: uninstallCommand
            ? [
                {
                  view: "HKCU" as const,
                  key: "HKEY_CURRENT_USER\\...\\test",
                  values: { UninstallString: uninstallCommand, DisplayName: "WorkBuddy" },
                },
              ]
            : [],
          skipped: [],
        }),
      },
      journal: memoryJournal(),
      now: () => "2026-10-19T00:00:00.000Z",
      bundledEvidenceFile: path.join(root, "missing.json"),
      configDirectory: root,
      inspectFile: async () => ({
        authenticode:
          options.signatureStatus === "Invalid"
            ? { status: "Invalid", signerSubject: null, signerThumbprint: null, notAfter: null, chainOk: false }
            : {
                status: "Valid",
                signerSubject: "CN=Tencent Technology (Shenzhen) Company Limited",
                signerThumbprint: "E1B5824EE85186B91E65DB3E75867F59E35CF4AB",
                notAfter: null,
                chainOk: true,
              },
        versionInfo: {
          productName: options.productName ?? "WorkBuddy",
          fileDescription: options.productName ?? "WorkBuddy",
          fileVersion: "5.8.2",
        },
      }),
      execRunner: runner,
      uninstallPollMs: 500,
      env: {},
      scanImplementation: async () => activeReport,
    });
    await service.init();
    await service.scan();
    // 接管流程已移除：扫描会自动登记通过检查的既有安装，这里直接取自动登记结果
    const registered = (await service.listInstances()).filter((item) => item.origin === "external");
    const adopted = registered[0]
      ? { ok: true as const, value: { instance: registered[0], notes: [] as string[] } }
      : { ok: false as const, error: { code: "E_NOT_FOUND", message: "自动登记未接受该安装" } };
    return { service, installDir, runner, adopted, setScanReport: (next: ScanReport) => { activeReport = next; } };
  }

  it("调用匹配的官方卸载器并确认目录消失", async () => {
    const { service, runner, adopted } = await makeAdoptedService({
      command: (dir) => `"${path.join(dir, "Uninstall WorkBuddy.exe")}" /currentuser`,
    });
    expect(adopted.ok, adopted.ok ? "" : adopted.error.message).toBe(true);
    if (!adopted.ok) return;

    const result = await service.uninstallInstance({
      product: "workbuddy-cn",
      instanceId: adopted.value.instance.instanceId,
    });
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![1]).toEqual(["/currentuser"]);
    expect(await service.listInstances()).toHaveLength(0);
  });

  it("注册表登记指向其他副本时改用目录内产品匹配的官方卸载器", async () => {
    const { service, adopted, runner } = await makeAdoptedService({ command: () => '"C:////Other////Uninstall.exe"' });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    const result = await service.uninstallInstance({
      product: "workbuddy-cn",
      instanceId: adopted.value.instance.instanceId,
    });
    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledWith(path.join(adopted.value.instance.directory, "Uninstall WorkBuddy.exe"), [], 300_000);
  });

  it("没有卸载登记时使用目录内产品匹配的官方卸载器", async () => {
    const { service, adopted, runner } = await makeAdoptedService({ command: () => null });
    expect(adopted.ok, adopted.ok ? "" : adopted.error.message).toBe(true);
    if (!adopted.ok) return;
    const result = await service.uninstallInstance({
      product: "workbuddy-cn",
      instanceId: adopted.value.instance.instanceId,
    });
    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledWith(path.join(adopted.value.instance.directory, "Uninstall WorkBuddy.exe"), [], 300_000);
    expect(await service.listInstances()).toHaveLength(0);
  });

  it("目录内卸载器产品元数据不匹配时拒绝启动", async () => {
    const { service, adopted, runner } = await makeAdoptedService({
      command: () => null,
      includeLocalUninstaller: false,
    });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    await fsp.writeFile(path.join(adopted.value.instance.directory, "Uninstall WorkBuddy AI.exe"), "stub", "utf8");
    const result = await service.uninstallInstance({
      product: "workbuddy-cn",
      instanceId: adopted.value.instance.instanceId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_NOT_FOUND");
    expect(runner).not.toHaveBeenCalled();
  });

  it("官方卸载器移除主程序但留下维护残余时清除主界面实例", async () => {
    const { service, installDir, adopted } = await makeAdoptedService({
      command: (dir) => `\"${path.join(dir, "Uninstall WorkBuddy.exe")}\"`,
      removeClientExecutableOnly: true,
    });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    const result = await service.uninstallInstance({
      product: "workbuddy-cn",
      instanceId: adopted.value.instance.instanceId,
    });
    expect(result.ok).toBe(true);
    expect(await fsp.stat(installDir).then(() => true).catch(() => false)).toBe(true);
    expect(await fsp.stat(path.join(installDir, "Uninstall WorkBuddy.exe")).then(() => true).catch(() => false)).toBe(true);
    expect(await service.listInstances()).toHaveLength(0);
    if (result.ok) expect(result.value.notes.join(" ")).toContain("安装目录仍有残留文件");
  });

  it("扫描时清除主程序已卸载但目录里仍有维护残余的旧外部登记", async () => {
    const { service, installDir, adopted, setScanReport } = await makeAdoptedService({ command: (dir) => `\"${path.join(dir, "Uninstall WorkBuddy.exe")}\"` });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    await fsp.rm(path.join(installDir, "WorkBuddy.exe"), { force: true });
    setScanReport(emptyReport());
    await service.scan();
    expect(await fsp.stat(path.join(installDir, "Uninstall WorkBuddy.exe")).then(() => true).catch(() => false)).toBe(true);
    expect(await service.listInstances()).toHaveLength(0);
  });

  it("卸载器签名无效时拒绝执行", async () => {
    const { service, installDir, adopted, runner } = await makeAdoptedService({
      command: (dir) => `"${path.join(dir, "Uninstall WorkBuddy.exe")}" /currentuser`,
      signatureStatus: "Invalid",
    });
    // 接管时就需要有效签名，所以这里改用已接管后签名变坏的场景不成立；
    // 直接验证：接管本身被拒绝，且卸载器从未被调用
    expect(adopted.ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    expect(await fsp.stat(path.join(installDir, "WorkBuddy.exe")).then(() => true).catch(() => false)).toBe(true);
    expect(await service.listInstances()).toHaveLength(0);
  });

  it("卸载器退出但目录仍在时报告失败", async () => {
    const { service, adopted, runner } = await makeAdoptedService({
      command: (dir) => `"${path.join(dir, "Uninstall WorkBuddy.exe")}"`,
      removeOnRun: false,
    });
    expect(adopted.ok, adopted.ok ? "" : adopted.error.message).toBe(true);
    if (!adopted.ok) return;
    const result = await service.uninstallInstance({
      product: "workbuddy-cn",
      instanceId: adopted.value.instance.instanceId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_BUSY");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(await service.listInstances()).toHaveLength(1);
  });
});
