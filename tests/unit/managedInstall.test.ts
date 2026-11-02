import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  classifyPackage,
  findAppRoot,
  findInnerArchive,
} from "../../src/core/packageFormat";
import { parseSevenZipListing, type ArchivePort } from "../../src/main/adapters/sevenZip";
import { deployPackage, extractApplicationTree, removeManagedDirectory } from "../../src/core/managedInstall";
import { PathGuard } from "../../src/core/pathGuard";
import { NodeFsPort } from "../../src/main/adapters/fsPort";
import { AppService } from "../../src/main/services/appService";
import type { JournalStore } from "../../src/core/journal";
import type { PackageCheck, ScanReport } from "../../src/core/contracts";
import { installManagedSchema, uninstallManagedSchema } from "../../src/shared/ipc";

/* ------------------------------------------------------------------ 夹具 */

const OUTER_ENTRIES = ["Setup.exe", "app-64.7z", "$PLUGINSDIR/System.dll"];
const INNER_ENTRIES = [
  "resources/app/package.json",
  "resources/app.asar",
  "WorkBuddy.exe",
  "ffmpeg.dll",
  "libEGL.dll",
  "resources/app-update.yml",
];

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

function fakeArchive(version = "5.8.3", productName = "WorkBuddy"): ArchivePort {
  return {
    async list(archive) {
      if (archive.endsWith(".exe")) return OUTER_ENTRIES;
      if (archive.endsWith("app-64.7z")) return INNER_ENTRIES;
      return [];
    },
    async extract(archive, destination) {
      const files = archive.endsWith(".exe")
        ? { "Setup.exe": "stub", "app-64.7z": "stub" }
        : {
            "resources/app/package.json": JSON.stringify({ productName, version }, null, 2),
            "resources/app.asar": "stub-asar",
            "WorkBuddy.exe": "stub-executable",
            "ffmpeg.dll": "stub-dll",
            "libEGL.dll": "stub-dll",
            "resources/app-update.yml": "stub",
          };
      for (const [relative, content] of Object.entries(files)) {
        const target = path.join(destination, relative);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, content, "utf8");
      }
    },
  };
}

function packageCheck(version: string, productName = "WorkBuddy"): PackageCheck {
  return {
    file: "E:\\pkgs\\WorkBuddy.exe",
    sizeBytes: 1024,
    sha256: "b".repeat(64),
    authenticode: {
      status: "Valid",
      signerSubject: "CN=Tencent Technology (Shenzhen) Company Limited",
      signerThumbprint: "ABC",
      notAfter: null,
      chainOk: true,
    },
    productName,
    productVersion: version,
    verdict: "unknown",
    reasons: [],
  };
}

function emptyReport(): ScanReport {
  return {
    scannedAt: "2026-10-18T00:00:00.000Z",
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

let currentTarget = "";
async function install(
  service: AppService,
  opts: { product: "workbuddy-cn" | "workbuddy-ai"; packagePath: string; targetDirectory?: string | null; source?: "local-file" | "official"; operationPrefix?: string },
) {
  return service.installFromPackage({ ...opts, targetDirectory: opts.targetDirectory ?? currentTarget });
}

async function makeService(options?: {
  version?: string;
  productName?: string;
  shortcuts?: import("../../src/main/adapters/shortcutWriter").ShortcutPort;
  errorLog?: import("../../src/main/errorLog").ErrorLogPort;
  signatureStatus?: string;
  fs?: NodeFsPort;
  /** 让 state/instances.json 变成目录，模拟登记写入失败 */
  blockInstancesFile?: boolean;
  /** 自定义扫描结果（用于注入异常记录） */
  scanImplementation?: () => Promise<import("../../src/core/contracts").ScanReport>;
}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-managed-"));
  const stateDir = path.join(root, "state");
  await fsp.mkdir(stateDir, { recursive: true });
  if (options?.blockInstancesFile) {
    // 同名目录 → writeFile 必然 EISDIR/EPERM，用于验证“登记失败必须回滚”
    await fsp.mkdir(path.join(stateDir, "instances.json"), { recursive: true });
  }
  const managementRoot = path.join(root, "managed");
  const packageFile = path.join(root, "pkgs", "WorkBuddySetup.exe");
  await fsp.mkdir(path.dirname(packageFile), { recursive: true });
  await fsp.writeFile(packageFile, "stub-package", "utf8");

  const signatureStatus = options?.signatureStatus ?? "Valid";
  const inspectFile = vi.fn(async () => ({
    authenticode: {
      status: signatureStatus,
      signerSubject: signatureStatus === "Valid" ? "CN=Tencent Technology (Shenzhen) Company Limited" : null,
      signerThumbprint: "ABC",
      notAfter: null,
      chainOk: true,
    },
    versionInfo: {
      productName: options?.productName ?? "WorkBuddy",
      fileDescription: options?.productName ?? "WorkBuddy",
      fileVersion: options?.version ?? "5.8.3",
    },
  }));

  const service = new AppService({
    appVersion: "0.2.0-test",
    stateDir,
    managementRoot,
    isWindows: true,
    portable: false,
    selfDirectories: [],
    fs: options?.fs ?? new NodeFsPort(),
    registry: { readUninstallEntries: async () => ({ entries: [], skipped: [] }) },
    journal: memoryJournal(),
    now: () => "2026-10-18T00:00:00.000Z",
    bundledEvidenceFile: path.join(stateDir, "missing.json"),
    configDirectory: path.join(root, "config"),
    archive: fakeArchive(options?.version ?? "5.8.3", options?.productName ?? "WorkBuddy"),
    inspectFile,
    env: {},
    scanImplementation: options?.scanImplementation ?? (async () => emptyReport()),
    shortcuts: options?.shortcuts,
    errorLog: options?.errorLog,
  });
  await fsp.mkdir(path.join(root, "targets"), { recursive: true });
  currentTarget = path.join(root, "targets", "install");
  await service.init();
  await service.scan();
  return { service, root, managementRoot, packageFile, stateDir, inspectFile, target: currentTarget };
}

/* ------------------------------------------------- 快捷方式与失败日志 */

interface FakeShortcutCalls {
  created: { name: string; target: string; workingDirectory: string }[];
  removed: string[];
}

function fakeShortcuts(mode: "ok" | "fail" = "ok"): {
  port: import("../../src/main/adapters/shortcutWriter").ShortcutPort;
  calls: FakeShortcutCalls;
} {
  const calls: FakeShortcutCalls = { created: [], removed: [] };
  return {
    calls,
    port: {
      desktopDirectory: async () => "C:\\Users\\tester\\Desktop",
      create: async (spec) => {
        calls.created.push({ name: spec.name, target: spec.target, workingDirectory: spec.workingDirectory });
        if (mode === "fail") return { ok: false, reason: "模拟：桌面不可写" };
        return { ok: true, path: `C:\\Users\\tester\\Desktop\\${spec.name}` };
      },
      remove: async (file) => {
        calls.removed.push(file);
        return { ok: true };
      },
    },
  };
}

function fakeErrorLog(): {
  port: import("../../src/main/errorLog").ErrorLogPort;
  entries: import("../../src/main/errorLog").ErrorEntry[];
} {
  const entries: import("../../src/main/errorLog").ErrorEntry[] = [];
  return {
    entries,
    port: {
      directory: "C:\\state\\errors",
      write: async (entry) => {
        entries.push(entry);
        return "C:\\state\\errors\\x.json";
      },
      list: async () => [],
      readRecent: async (limit = 20) => ({
        entries: entries.slice(-limit).reverse().map((entry) => ({
          at: "2026-10-18T00:00:00.000Z",
          operation: entry.operation,
          product: entry.product,
          instanceId: entry.instanceId,
          stage: entry.stage,
          code: entry.code,
          message: entry.message,
          stagingDirectory: null,
          rolledBack: entry.rolledBack,
          detail: null,
        })),
        total: entries.length,
        corrupted: 0,
        readable: true,
      }),
    },
  };
}

describe("安装生命周期：桌面快捷方式与失败日志", () => {
  it("安装成功后创建对应产品的桌面快捷方式，并记录到实例", async () => {
    const shortcuts = fakeShortcuts();
    const { service, packageFile } = await makeService({ shortcuts: shortcuts.port });
    const result = await install(service, { product: "workbuddy-cn", packagePath: packageFile });
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(shortcuts.calls.created).toHaveLength(1);
    expect(shortcuts.calls.created[0]?.name).toBe("WorkBuddy（国内版）.lnk");
    expect(shortcuts.calls.created[0]?.target.toLowerCase()).toContain("workbuddy.exe");
    expect(result.value.instance.shortcutPath).toContain("WorkBuddy（国内版）.lnk");
    expect(result.value.notes.join()).toContain("已创建桌面快捷方式");
  });

  it("快捷方式创建失败不影响安装结果，并如实说明原因", async () => {
    const shortcuts = fakeShortcuts("fail");
    const { service, packageFile } = await makeService({ shortcuts: shortcuts.port });
    const result = await install(service, { product: "workbuddy-cn", packagePath: packageFile });
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.notes.join()).toContain("快捷方式创建失败");
    expect(result.value.instance.shortcutPath ?? null).toBeNull();
  });

  it("卸载时删除本工具创建的快捷方式", async () => {
    const shortcuts = fakeShortcuts();
    const { service, packageFile } = await makeService({ shortcuts: shortcuts.port });
    const installed = await install(service, { product: "workbuddy-cn", packagePath: packageFile });
    expect(installed.ok, installed.ok ? "" : installed.error.message).toBe(true);
    if (!installed.ok) return;

    const removed = await service.uninstallInstance({
      product: "workbuddy-cn",
      instanceId: installed.value.instance.instanceId,
    });
    expect(removed.ok, removed.ok ? "" : removed.error.message).toBe(true);
    expect(shortcuts.calls.removed).toHaveLength(1);
    expect(shortcuts.calls.removed[0]).toContain("WorkBuddy（国内版）.lnk");
  });

  it("NotSigned 的包仍可安装、登记并创建快捷方式（签名只作诊断）", async () => {
    const shortcuts = fakeShortcuts();
    const { service, packageFile } = await makeService({ signatureStatus: "NotSigned", shortcuts: shortcuts.port });
    const result = await install(service, { product: "workbuddy-cn", packagePath: packageFile });
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.instance.version).toBe("5.8.3");
    expect(result.value.notes.join()).toContain("签名：NotSigned");
    expect(shortcuts.calls.created).toHaveLength(1);
    expect(await service.listInstances()).toHaveLength(1);
  });

  it("Unknown 签名状态同样不阻断安装", async () => {
    const { service, packageFile } = await makeService({ signatureStatus: "Unknown" });
    const result = await install(service, { product: "workbuddy-cn", packagePath: packageFile });
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
  });

  it("安装到用户选择的目录（管理根之外），实例与快捷方式都指向该目录", async () => {
    const shortcuts = fakeShortcuts();
    const { service, root, packageFile } = await makeService({ shortcuts: shortcuts.port });
    const target = path.join(root, "custom", "WorkBuddy-CN");
    await fsp.mkdir(path.dirname(target), { recursive: true });

    const result = await install(service, { product: "workbuddy-cn", packagePath: packageFile, targetDirectory: target });
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.instance.directory).toBe(path.resolve(target));
    expect(await fsp.stat(path.join(target, "WorkBuddy.exe")).then(() => true)).toBe(true);
    const instances = await service.listInstances();
    expect(instances[0]?.directory).toBe(path.resolve(target));
    expect(shortcuts.calls.created[0]?.target.toLowerCase()).toBe(path.join(target, "WorkBuddy.exe").toLowerCase());
  });

  it("目标为已存在的空目录时允许安装", async () => {
    const { service, root, packageFile } = await makeService();
    const target = path.join(root, "empty-target");
    await fsp.mkdir(target, { recursive: true });
    const result = await install(service, { product: "workbuddy-cn", packagePath: packageFile, targetDirectory: target });
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
  });

  it("目标非空时拒绝且不写入任何文件", async () => {
    const { service, root, packageFile } = await makeService();
    const target = path.join(root, "busy-target");
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, "keep.txt"), "user data", "utf8");

    const result = await install(service, { product: "workbuddy-cn", packagePath: packageFile, targetDirectory: target });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_TARGET_EXISTS");
    expect(await fsp.readFile(path.join(target, "keep.txt"), "utf8")).toBe("user data");
    expect(await fsp.stat(path.join(target, "WorkBuddy.exe")).then(() => true).catch(() => false)).toBe(false);
  });

  it("目标等于已有实例目录时拒绝覆盖", async () => {
    const { service, packageFile, target } = await makeService();
    const first = await install(service, { product: "workbuddy-cn", packagePath: packageFile });
    expect(first.ok, first.ok ? "" : first.error.message).toBe(true);

    const second = await install(service, { product: "workbuddy-cn", packagePath: packageFile, targetDirectory: target });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(["E_CONFLICT", "E_TARGET_EXISTS"]).toContain(second.error.code);
  });

  it("实例登记写入失败时回滚已部署目录", async () => {
    const shortcuts = fakeShortcuts();
    const { service, root, packageFile } = await makeService({
      shortcuts: shortcuts.port,
      blockInstancesFile: true,
    });
    const target = path.join(root, "rollback-target");
    await fsp.mkdir(path.dirname(target), { recursive: true });

    const result = await install(service, { product: "workbuddy-cn", packagePath: packageFile, targetDirectory: target });
    expect(result.ok, result.ok ? "应失败但成功了" : "").toBe(false);
    if (!result.ok) expect(result.error.message).toContain("回滚");
    expect(await fsp.stat(target).then(() => true).catch(() => false)).toBe(false);
    expect(await service.listInstances()).toHaveLength(0);
  });

  it("包内产品名称不匹配时仍按用户选择安装并记录包信息", async () => {
    const errorLog = fakeErrorLog();
    const { service, packageFile } = await makeService({ productName: "WorkBuddy AI", version: "5.8.4", errorLog: errorLog.port });

    const result = await install(service, { product: "workbuddy-cn", packagePath: packageFile });
    expect(result.ok).toBe(true);
    expect(errorLog.entries).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ 格式识别 */

describe("包格式识别", () => {
  it("解析 7za -slt 的条目列表", () => {
    const output = [
      "Listing archive: test.7z",
      "--",
      "Path = test.7z",
      "Type = 7z",
      "----------",
      "Path = resources",
      "Size = 0",
      "Path = resources/app/package.json",
      "Size = 20",
    ].join("\n");
    expect(parseSevenZipListing(output)).toEqual(["resources", "resources/app/package.json"]);
  });

  it("识别 NSIS 内层归档与 zip/7z", () => {
    expect(classifyPackage("setup.exe", ["$PLUGINSDIR/a.dll", "app-64.7z"])).toBe("nsis");
    expect(classifyPackage("setup.zip", ["resources/app/package.json"])).toBe("zip");
    expect(classifyPackage("setup.7z", ["resources/app.asar"])).toBe("7z");
    expect(classifyPackage("setup.bin", ["readme.txt"])).toBe("unknown");
  });

  it("优先选择 app-64.7z 作为内层归档", () => {
    expect(findInnerArchive(["data.zip", "app-64.7z", "app-32.7z"])).toBe("app-64.7z");
    expect(findInnerArchive(["docs/example.7z", "top.7z"])).toBe("top.7z");
    expect(
      findInnerArchive([
        "WorkBuddy.exe",
        "resources/app.asar",
        "resources/vendor/node.zip",
        "resources/app.asar.unpacked/main/index.js",
      ]),
    ).toBeNull();
    expect(findInnerArchive(["WorkBuddy.exe", "resources/app.asar", "resources/vendor/node.zip"])).toBeNull();
    expect(findInnerArchive(["Setup.exe"])).toBeNull();
  });

  it("定位应用根目录（含 resources/app）", () => {
    expect(findAppRoot(["resources/app/package.json", "WorkBuddy.exe"])).toBe("");
    expect(findAppRoot(["WorkBuddy/resources/app/package.json", "WorkBuddy/WorkBuddy.exe"])).toBe("WorkBuddy");
    expect(findAppRoot(["readme.txt"])).toBeNull();
  });
});

/* ------------------------------------------------------------------ 解包与部署 */

describe("extractApplicationTree", () => {
  it("递归解开 NSIS 外层与内层归档", async () => {
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-extract-"));
    const result = await extractApplicationTree(
      { packagePath: "C:\\pkgs\\WorkBuddy.exe", packageFormat: "unknown", workDirectory: work },
      fakeArchive(),
      new NodeFsPort(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.format).toBe("nsis");
      const text = await fsp.readFile(path.join(result.value.root, "resources", "app", "package.json"), "utf8");
      expect(JSON.parse(text).version).toBe("5.8.3");
    }
  });

  it("解包后没有固定 app.asar 布局时仍部署文件树", async () => {
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-extract-bad-"));
    const bad: ArchivePort = {
      list: async () => ["WorkBuddy.exe", "ffmpeg.dll", "resources.pak"],
      extract: async (_archive, destination) => {
        await fsp.mkdir(destination, { recursive: true });
        await fsp.writeFile(path.join(destination, "WorkBuddy.exe"), "exe", "utf8");
        await fsp.writeFile(path.join(destination, "ffmpeg.dll"), "dll", "utf8");
        await fsp.writeFile(path.join(destination, "resources.pak"), "pak", "utf8");
      },
    };
    const result = await extractApplicationTree(
      { packagePath: "C:\\pkgs\\bad.7z", packageFormat: "7z", workDirectory: work },
      bad,
      new NodeFsPort(),
    );
    expect(result.ok).toBe(true);
  });
});

describe("deployPackage", () => {
  async function setup() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-deploy-"));
    const managementRoot = path.join(root, "managed");
    await fsp.mkdir(managementRoot, { recursive: true });
    const packageFile = path.join(root, "WorkBuddySetup.exe");
    await fsp.writeFile(packageFile, "stub", "utf8");
    const fsPort = new NodeFsPort();
    const deps = {
      fs: fsPort,
      tree: fsPort,
      guard: new PathGuard({ managementRoot }),
      archive: fakeArchive(),
      journal: memoryJournal(),
      now: () => "2026-10-18T00:00:00.000Z",
      verifyInstalled: async () => ({ ok: true }),
    };
    return { root, managementRoot, packageFile, deps };
  }

  it("把解包内容部署到目标目录", async () => {
    const { managementRoot, packageFile, deps } = await setup();
    const target = path.join(managementRoot, "WorkBuddy-CN", "versions", "5.8.3");
    const staging = path.join(managementRoot, ".staging", "op-deploy-1");
    const result = await deployPackage(
      {
        product: "workbuddy-cn",
        version: "5.8.3",
        packagePath: packageFile,
        packageCheck: packageCheck("5.8.3"),
        operationId: "op-deploy-1",
        stagingDirectory: staging,
        targetDirectory: target,
        backupDirectory: path.join(managementRoot, "WorkBuddy-CN", "backups"),
      },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(await deps.fs.isFile(path.join(target, "WorkBuddy.exe"))).toBe(true);
    expect(await deps.fs.isFile(path.join(target, "resources", "app", "package.json"))).toBe(true);
    expect(await deps.fs.exists(staging)).toBe(false);
  });

  it("目标目录已存在时拒绝覆盖", async () => {
    const { managementRoot, packageFile, deps } = await setup();
    const target = path.join(managementRoot, "WorkBuddy-CN", "versions", "5.8.3");
    await fsp.mkdir(target, { recursive: true });
    const result = await deployPackage(
      {
        product: "workbuddy-cn",
        version: "5.8.3",
        packagePath: packageFile,
        packageCheck: packageCheck("5.8.3"),
        operationId: "op-deploy-2",
        stagingDirectory: path.join(managementRoot, ".staging", "op-deploy-2"),
        targetDirectory: target,
        backupDirectory: path.join(managementRoot, "WorkBuddy-CN", "backups"),
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_TARGET_EXISTS");
  });

  it("目标目录在管理根之外时拒绝", async () => {
    const { root, packageFile, deps } = await setup();
    const result = await deployPackage(
      {
        product: "workbuddy-cn",
        version: "5.8.3",
        packagePath: packageFile,
        packageCheck: packageCheck("5.8.3"),
        operationId: "op-deploy-3",
        stagingDirectory: path.join(root, "staging"),
        targetDirectory: path.join(root, "outside-target"),
        backupDirectory: path.join(root, "backups"),
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_PATH_REJECTED");
  });

  it("部署后核验失败时回滚，目标目录不残留", async () => {
    const { managementRoot, packageFile, deps } = await setup();
    const target = path.join(managementRoot, "WorkBuddy-CN", "versions", "5.8.3");
    const staging = path.join(managementRoot, ".staging", "op-deploy-4");
    const result = await deployPackage(
      {
        product: "workbuddy-cn",
        version: "5.8.3",
        packagePath: packageFile,
        packageCheck: packageCheck("5.8.3"),
        operationId: "op-deploy-4",
        stagingDirectory: staging,
        targetDirectory: target,
        backupDirectory: path.join(managementRoot, "WorkBuddy-CN", "backups"),
      },
      { ...deps, verifyInstalled: async () => ({ ok: false, reason: "身份不符" }) },
    );
    expect(result.ok).toBe(false);
    expect(await deps.fs.exists(target)).toBe(false);
    expect(await deps.fs.exists(staging)).toBe(false);
  });
});

/* ------------------------------------------------------------------ 卸载 */

describe("removeManagedDirectory", () => {
  it("删除前备份，目录不存在时拒绝", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-uninstall-"));
    const managementRoot = path.join(root, "managed");
    const target = path.join(managementRoot, "WorkBuddy-CN", "versions", "5.8.3");
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, "WorkBuddy.exe"), "stub", "utf8");
    const fsPort = new NodeFsPort();
    const deps = {
      fs: fsPort,
      tree: fsPort,
      guard: new PathGuard({ managementRoot }),
      journal: memoryJournal(),
      now: () => "2026-10-18T00:00:00.000Z",
      verifyInstalled: async () => ({ ok: true }),
    };
    const result = await removeManagedDirectory(
      { product: "workbuddy-cn", directory: target, backupDirectory: path.join(managementRoot, "WorkBuddy-CN", "backups"), operationId: "op-un-1" },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(await deps.fs.exists(target)).toBe(false);

    const again = await removeManagedDirectory(
      { product: "workbuddy-cn", directory: target, backupDirectory: path.join(managementRoot, "WorkBuddy-CN", "backups"), operationId: "op-un-2" },
      deps,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("E_NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ 服务层：安装 / 更新 / 卸载 */

describe("AppService 受管实例管线", () => {
  it("从本地包安装后登记实例，并成为默认实例", async () => {
    const { service, managementRoot, packageFile, target } = await makeService();
    const result = await install(service, {
      product: "workbuddy-cn",
      packagePath: packageFile,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.instance.version).toBe("5.8.3");
      expect(result.value.instance.active).toBe(true);
      expect(result.value.instance.verified).toBe(true);
      expect(result.value.instance.directory).toBe(target);
    }
    const instances = await service.listInstances();
    expect(instances).toHaveLength(1);

    // 0.6.1：安装不再依赖 signer-trust.json
    const trustExists = await fsp
      .stat(path.join(managementRoot, "..", "state", "signer-trust.json"))
      .then(() => true)
      .catch(() => false);
    expect(trustExists).toBe(false);
  });

  it("同一产品第二次安装不抢默认实例", async () => {
    const { service, packageFile } = await makeService();
    const first = await install(service, { product: "workbuddy-cn", packagePath: packageFile });
    expect(first.ok).toBe(true);
    const second = await install(service, { product: "workbuddy-cn", packagePath: packageFile });
    // 同版本同目录，第二次应被目录占用拦下
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("E_CONFLICT");
  });

  it("更新在原实例目录完成替换，旧版本目录保留", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-update-"));
    const stateDir = path.join(root, "state");
    const managementRoot = path.join(root, "managed");
    const pkg1 = path.join(root, "WorkBuddy-5.8.2.exe");
    const pkg2 = path.join(root, "WorkBuddy-5.8.3.exe");
    await fsp.writeFile(pkg1, "stub-1", "utf8");
    await fsp.writeFile(pkg2, "stub-2", "utf8");
    const updateTarget = path.join(root, "apps", "WorkBuddy-CN");
    await fsp.mkdir(path.dirname(updateTarget), { recursive: true });

    let currentVersion = "5.8.2";
    const service = new AppService({
      appVersion: "0.2.0-test",
      stateDir,
      managementRoot,
      isWindows: true,
      portable: false,
      selfDirectories: [],
      fs: new NodeFsPort(),
      registry: { readUninstallEntries: async () => ({ entries: [], skipped: [] }) },
      journal: memoryJournal(),
      now: () => "2026-10-18T00:00:00.000Z",
      bundledEvidenceFile: path.join(stateDir, "missing.json"),
      configDirectory: path.join(root, "config"),
      archive: fakeArchive(),
      inspectFile: async () => ({
        authenticode: {
          status: "Valid",
          signerSubject: "CN=Tencent Technology (Shenzhen) Company Limited",
          signerThumbprint: "ABC",
          notAfter: null,
          chainOk: true,
        },
        versionInfo: { productName: "WorkBuddy", fileDescription: "WorkBuddy", fileVersion: currentVersion },
      }),
      env: {},
      scanImplementation: async () => emptyReport(),
    });
    await service.init();
    await service.scan();

    const installed = await install(service, {
      product: "workbuddy-cn",
      packagePath: pkg1,
      targetDirectory: updateTarget,
    });
    expect(installed.ok, installed.ok ? "" : installed.error.message).toBe(true);
    if (!installed.ok) return;

    currentVersion = "5.8.3";
    const updated = await service.updateInstance({
      product: "workbuddy-cn",
      instanceId: installed.value.instance.instanceId,
      packagePath: pkg2,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.instance.version).toBe("5.8.3");
      expect(updated.value.instance.active).toBe(true);
    }

    const instances = await service.listInstances();
    // 原位更新：仍然只有一个实例，但版本变成新版本、目录不变
    expect(instances).toHaveLength(1);
    expect(instances[0]!.version).toBe("5.8.3");
    expect(instances[0]!.directory).toBe(installed.value.instance.directory);
    const retired = `${installed.value.instance.directory}.old-${updated.ok ? updated.value.operationId : ""}`;
    expect(await fsp.stat(retired).then(() => true).catch(() => false)).toBe(true);
  });

  it("卸载受管实例只删程序目录，用户数据保留", async () => {
    const { service, root, packageFile } = await makeService({ productName: "WorkBuddy AI" });
    const installed = await install(service, { product: "workbuddy-ai", packagePath: packageFile });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    // 模拟用户数据目录（本工具从不触碰）
    const userData = path.join(root, "AppData", "WorkBuddyAI", "chat.db");
    await fsp.mkdir(path.dirname(userData), { recursive: true });
    await fsp.writeFile(userData, "user-data", "utf8");

    const removed = await service.uninstallInstance({
      product: "workbuddy-ai",
      instanceId: installed.value.instance.instanceId,
    });
    expect(removed.ok).toBe(true);
    expect(await fsp.stat(installed.value.instance.directory).then(() => true).catch(() => false)).toBe(false);
    expect(await fsp.readFile(userData, "utf8")).toBe("user-data");
    expect(await service.listInstances()).toHaveLength(0);
  });

  it("未登记的实例不能被更新或卸载", async () => {
    const { service, packageFile } = await makeService();
    const update = await service.updateInstance({
      product: "workbuddy-cn",
      instanceId: "workbuddy-cn@5.8.3@deadbeef",
      packagePath: packageFile,
    });
    expect(update.ok).toBe(false);
    if (!update.ok) expect(update.error.code).toBe("E_TARGET_NOT_MANAGED");

    const removal = await service.uninstallInstance({
      product: "workbuddy-cn",
      instanceId: "workbuddy-cn@5.8.3@deadbeef",
    });
    expect(removal.ok).toBe(false);
    if (!removal.ok) expect(removal.error.code).toBe("E_TARGET_NOT_MANAGED");
  });
});

/* ------------------------------------------------------------------ IPC 入参 */

describe("受管实例 IPC 入参校验", () => {
  it("拒绝未知字段；安装目标必填", () => {
    // 0.6.2：targetDirectory 必填，缺失直接拒绝
    expect(
      installManagedSchema.safeParse({ product: "workbuddy-cn", packagePath: "E:\\a.exe" }).success,
    ).toBe(false);
    expect(
      installManagedSchema.safeParse({
        product: "workbuddy-cn",
        packagePath: "E:\\a.exe",
        targetDirectory: "C:\\Apps\\WorkBuddy-CN",
      }).success,
    ).toBe(true);
    expect(
      installManagedSchema.safeParse({
        product: "workbuddy-cn",
        packagePath: "E:\\a.exe",
        targetDirectory: "C:\\Apps\\WorkBuddy-CN",
        args: ["/S"],
      }).success,
    ).toBe(false);
  });

  it("卸载必须带 confirmed 布尔值", () => {
    expect(
      uninstallManagedSchema.safeParse({ product: "workbuddy-cn", instanceId: "abc12345", confirmed: true }).success,
    ).toBe(true);
    expect(
      uninstallManagedSchema.safeParse({ product: "workbuddy-cn", instanceId: "abc12345" }).success,
    ).toBe(false);
  });
});

describe("盘符根异常记录不阻塞安装", () => {
  function badRecord(location: string, product: "workbuddy-cn" | "workbuddy-ai" = "workbuddy-cn") {
    return {
      id: "path:" + location.toLowerCase(),
      product,
      productHint: product,
      displayName: "WorkBuddy",
      displayVersion: "5.8.3",
      publisher: "Tencent",
      installLocation: location,
      locationSource: "process" as const,
      uninstallString: null,
      primarySource: "process" as const,
      clues: [{ kind: "process" as const, source: "WorkBuddy.exe", detail: location }],
      discovery: "path-found" as const,
      identity: "unverified" as const,
      identityCheck: null,
      duplicateRegistrations: 0,
      needsReview: true,
      isManagerSelf: false,
      conflicts: [],
      managedByTool: false,
    };
  }

  it("扫描含 D:\\ 记录时，D:\\workbuddyCN 仍可部署", async () => {
    const report = emptyReport();
    report.records = [badRecord("D:\\")];
    const { service, root, packageFile } = await makeService({
      scanImplementation: async () => report,
    });
    const target = path.join(root, "targets", "install");

    const result = await install(service, {
      product: "workbuddy-cn",
      packagePath: packageFile,
      targetDirectory: target,
    });
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (result.ok) expect(result.value.instance.directory).toBe(path.resolve(target));
  });

  it("扫描含同路径有效客户端时仍拒绝覆盖", async () => {
    const report = emptyReport();
    report.records = [badRecord("D:\\Apps\\WorkBuddy")];
    const { service, packageFile } = await makeService({
      scanImplementation: async () => report,
    });

    const result = await install(service, {
      product: "workbuddy-cn",
      packagePath: packageFile,
      targetDirectory: "D:\\Apps\\WorkBuddy",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_CONFLICT");
  });
});
