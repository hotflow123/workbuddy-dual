import { app, BrowserWindow, dialog, Menu, session, shell } from "electron";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { AppService } from "./services/appService";
import { registerIpcHandlers, type IpcContext } from "./ipc";
import { NodeFsPort } from "./adapters/fsPort";
import { FileJournalStore } from "./adapters/journalFile";
import { WindowsRegistryReader, inspectWindowsFile } from "./adapters/windows";
import { CompositeRegistryReader, PowerShellRegistryReader } from "./adapters/registryPs";
import { WindowsShortcutWriter } from "./adapters/shortcutWriter";
import { FileErrorLog } from "./errorLog";
import { redactForDiagnostics } from "../core/redact";
import { validateInstallTarget } from "../core/pathGuard";
import { IPC } from "../shared/ipc";

declare const __BUILD_ID__: string;
declare const __BUILD_TIME__: string;

/** 构建标识：由 scripts/build.mjs 注入；未注入（如直接运行旧 dist）时为 dev */
const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
const BUILD_TIME = typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "dev";

const isE2E = process.argv.includes("--e2e");
/** 只读扫描报告模式：输出脱敏 JSON 后退出，不创建窗口 */
const isScanReport = process.argv.includes("--scan-report");
const RENDERER_FILE = path.join(__dirname, "..", "renderer", "index.html");

/**
 * 携带版（electron-builder portable 目标）会在启动时注入 PORTABLE_EXECUTABLE_DIR。
 * 此时把 Electron 自身缓存、设置、操作日志与受管目录全部放在 exe 同级的
 * `WorkBuddyDualEdition-Data` 下，做到“整个文件夹拷走即用”，不写 %APPDATA%。
 */
const portableBase = (() => {
  const raw = process.env["PORTABLE_EXECUTABLE_DIR"];
  if (!raw || raw.trim() === "") return null;
  return path.join(path.resolve(raw), "WorkBuddyDualEdition-Data");
})();

if (portableBase) {
  try {
    app.setPath("userData", path.join(portableBase, "app"));
    app.setPath("sessionData", path.join(portableBase, "app"));
    app.setPath("cache", path.join(portableBase, "cache"));
    app.setPath("logs", path.join(portableBase, "logs"));
  } catch {
    // 目录不可写时退回默认路径，界面上会显示实际使用的管理根目录
  }
}

// 冒烟测试（CI/无 GPU 环境）需要关闭硬件加速；正常运行时保持默认。
if (isE2E || isScanReport) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer");
}

let mainWindow: BrowserWindow | null = null;
let service: AppService | null = null;

/** 本工具自身的运行/打包目录：用于把自身目录排除在 WorkBuddy 安装统计之外 */
function selfDirectories(): string[] {
  const list: string[] = [];
  try {
    list.push(app.getAppPath());
  } catch {
    // 忽略：某些模式下不可用
  }
  try {
    list.push(path.dirname(app.getPath("exe")));
  } catch {
    // 忽略
  }
  if (process.resourcesPath) list.push(process.resourcesPath);
  return [...new Set(list.filter((item) => typeof item === "string" && item.length > 0))];
}

function configDirectory(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "config")
    : path.join(app.getAppPath(), "config");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: "#f6f7f9",
    title: "WorkBuddy 双版本共存管理器",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  Menu.setApplicationMenu(null);
  window.once("ready-to-show", () => window.show());

  // 禁止导航到任何远程页面；所有外链交给系统浏览器且不自动打开
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  void window.loadFile(RENDERER_FILE);
  return window;
}

async function bootstrap(): Promise<void> {
  const fsPort = new NodeFsPort();
  const stateDir = portableBase
    ? path.join(portableBase, "state")
    : path.join(app.getPath("userData"), "state");
  const managementRoot = portableBase
    ? path.join(portableBase, "Managed")
    : path.join(process.env["LOCALAPPDATA"] ?? app.getPath("appData"), "WorkBuddyDualEdition");

  service = new AppService({
    appVersion: app.getVersion(),
    buildId: BUILD_ID,
    buildTime: BUILD_TIME,
    packaged: app.isPackaged,
    stateDir,
    managementRoot,
    isWindows: process.platform === "win32",
    portable: portableBase !== null,
    selfDirectories: selfDirectories(),
    fs: fsPort,
    // 优先 .NET 注册表适配器：本环境 reg.exe 被安全策略拦截，但卸载命令必须能读到
    registry: new CompositeRegistryReader(new PowerShellRegistryReader(), new WindowsRegistryReader()),
    journal: new FileJournalStore(path.join(stateDir, "operations")),
    shortcuts: new WindowsShortcutWriter(),
    errorLog: new FileErrorLog(path.join(stateDir, "errors"), () => new Date().toISOString()),
    now: () => new Date().toISOString(),
    bundledEvidenceFile: path.join(configDirectory(), "evidence.json"),
    configDirectory: configDirectory(),
    appPath: app.getAppPath(),
    openExternal: async (url) => {
      // 只允许打开固定官网（URL 在主进程查表生成，渲染进程无法注入）
      // E2E 模式把实际打开的地址写入日志文件，避免自动化真的弹出浏览器
      const openLog = process.env["WB_E2E_OPEN_LOG"] ?? "";
      if (openLog) {
        await fsp.appendFile(openLog, `${url}\n`, "utf8").catch(() => undefined);
        return;
      }
      await shell.openExternal(url);
    },
    resourcesPath: process.resourcesPath ?? null,
    emit: (event) => {
      mainWindow?.webContents.send(IPC.progress, event);
    },
  });
  await service.init();
  await service.getState();

  if (isScanReport) {
    // 无论成功失败都必须输出一行 JSON：脚本据此判断，不依赖退出码
    try {
      const report = await service.scan();
      const payload = report.ok ? report.value : { error: report.error };
      const text = redactForDiagnostics(JSON.stringify(payload, null, 2), {
        homeDirectory: process.env["USERPROFILE"] ?? "",
        userName: process.env["USERNAME"] ?? "",
      });
      process.stdout.write(`${text}\n`);
      app.exit(report.ok ? 0 : 1);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ error: { code: "E_INTERNAL", message: error instanceof Error ? error.message : String(error) } })}\n`,
      );
      app.exit(1);
    }
    return;
  }

  mainWindow = createWindow();

  const allowed = new Set<number>();
  allowed.add(mainWindow.webContents.id);

  const context: IpcContext = {
    service,
    allowed,
    pickDirectory: async () => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: "选择安装目录",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    pickPackage: async () => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: "选择本地安装包（仅接受官方 .exe）",
        properties: ["openFile"],
        filters: [{ name: "Windows 安装包", extensions: ["exe"] }],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    exportDirectory: async () => {
      // E2E：用固定目录替代原生对话框，才能自动点击“导出诊断”并读取真实报告
      const override = process.env["WB_E2E_EXPORT_DIR"];
      if (override) {
        await fsp.mkdir(override, { recursive: true });
        return override;
      }
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: "选择脱敏诊断导出目录",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  };

  registerIpcHandlers(context);

  // 默认拒绝一切权限请求（摄像头、通知、剪贴板读取等）
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  if (isE2E) {
    await runE2E(mainWindow);
  }
}

async function runE2E(window: BrowserWindow): Promise<void> {
  try {
    await new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));

    // 等待首次扫描完成（注册表 / 进程 / 快捷方式 / asar 读取都需要时间）
    const deadline = Date.now() + 40000;
    for (;;) {
      const ready = await window.webContents.executeJavaScript(
        `document.querySelectorAll('[data-testid="product-card"]').length > 0`,
        true,
      );
      if (ready) break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const output = app.isPackaged
      ? path.join(app.getPath("temp"), "workbuddy-e2e")
      : path.join(app.getAppPath(), "artifacts");
    await fsp.mkdir(output, { recursive: true });

    const shots: string[] = [];
    const capture = async (name: string) => {
      const image = await window.webContents.capturePage();
      const file = path.join(output, `e2e-${name}-${Date.now()}.png`);
      await fsp.writeFile(file, image.toPNG());
      shots.push(file);
    };
    await capture("main");
    await window.webContents.executeJavaScript("window.scrollTo(0, document.body.scrollHeight); true", true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await capture("sources");

    // 窄窗口布局：品牌区与右侧元信息必须换行，不得互相遮挡或横向溢出
    window.setSize(900, 700);
    await new Promise((resolve) => setTimeout(resolve, 300));
    window.webContents.enableDeviceEmulation({
      screenPosition: "desktop",
      screenSize: { width: 520, height: 800 },
      viewPosition: { x: 0, y: 0 },
      viewSize: { width: 520, height: 800 },
      deviceScaleFactor: 0,
      scale: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const narrowLayout = await window.webContents.executeJavaScript(
      `(() => {
        const box = (selector) => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const r = node.getBoundingClientRect();
          return {
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            left: Math.round(r.left),
            right: Math.round(r.right),
          };
        };
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          scrollWidth: document.documentElement.scrollWidth,
          brand: box('.brand'),
          meta: box('.meta'),
          sponsor: box('#sponsor-link'),
          version: box('#app-version'),
        };
      })()`,
      true,
    );
    await capture("narrow");
    window.webContents.disableDeviceEmulation();
    window.setSize(1180, 820);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const state = service ? await service.getState() : null;
    const title = await window.webContents.executeJavaScript("document.title", true);
    const productCards = await window.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="product-card"]').length`,
      true,
    );
    const installItems = await window.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="install-item"]').length`,
      true,
    );
    const statuses = await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[data-testid="product-card"] .product-head .badge')).map((n) => n.textContent.trim())`,
      true,
    );
    const topbarText = await window.webContents.executeJavaScript(
      `document.querySelector('.topbar')?.textContent.trim() ?? ''`,
      true,
    );
    const bodyText = await window.webContents.executeJavaScript(
      `document.body.innerText`,
      true,
    );
    const diagnosticsVisible = await window.webContents.executeJavaScript(
      `!document.querySelector('#diag').hidden`,
      true,
    );
    const versionSelects = await window.webContents.executeJavaScript(`document.querySelectorAll('select').length`, true);
    const installPathUi = await window.webContents.executeJavaScript(
      `document.body.dataset.installPathUi ?? ""`,
      true,
    );
    const sourcesHeading = await window.webContents.executeJavaScript(
      `document.querySelector('#diag-title')?.textContent.trim() ?? ''`,
      true,
    );
    const sourcesNote = await window.webContents.executeJavaScript(
      `document.querySelector('#diag .muted')?.textContent.trim() ?? ''`,
      true,
    );
    const parts = await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[data-testid="product-card"]')).map((card) => ({
        product: card.dataset.product,
        status: card.dataset.status,
        summary: card.querySelector('[data-testid="product-summary"]')?.textContent.trim() ?? '',
        installButtons: card.querySelectorAll('button[data-action="install"]').length,
        officialButtons: card.querySelectorAll('button[data-action="official"]').length,
        instanceRows: card.querySelectorAll('[data-testid="instance-row"]').length,
        discoveredRows: card.querySelectorAll('[data-testid="discovered-row"]').length,
        adoptButtons: card.querySelectorAll('button[data-action="adopt"]').length,
        actions: Array.from(card.querySelectorAll('button[data-action]')).map((b) => ({
          action: b.dataset.action,
          enabled: !b.disabled,
        })),
      }))`,
      true,
    );
    const hasConfirmDialog = await window.webContents.executeJavaScript(
      `Boolean(document.querySelector('#modal')) && Boolean(document.querySelector('#modal-confirm'))`,
      true,
    );
    const hasProgressBar = await window.webContents.executeJavaScript(
      `Boolean(document.querySelector('#progress-fill'))`,
      true,
    );
    const assistedTables = await window.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="op-row"]').length`,
      true,
    );
    const ipcProbePath = process.env["WB_E2E_INSPECT"] ?? "";
    const ipcInspect = ipcProbePath
      ? await window.webContents.executeJavaScript(
          `window.workbuddy.inspectPackage(${JSON.stringify(ipcProbePath)}, "workbuddy-cn").then((r) =>
             r.ok
               ? { ok: true, product: r.value.productName, version: r.value.productVersion, signature: r.value.authenticode?.status ?? null, sha: r.value.sha256.slice(0, 12) }
               : { ok: false, code: r.error.code, message: r.error.message })`,
          true,
        )
      : null;
    const treeProbeDir = process.env["WB_E2E_TREE"] ?? "";
    const probeFs = new NodeFsPort();
    const treeProbe = treeProbeDir
      ? {
          root: treeProbeDir,
          hasAsar: await probeFs.isFile(path.join(treeProbeDir, "resources", "app.asar")),
          stat: await probeFs.stat(path.join(treeProbeDir, "resources", "app.asar")),
          top: (await probeFs.listDirectory(treeProbeDir).catch(() => [] as string[])).slice(0, 5),
        }
      : null;
    const installProbePath = process.env["WB_E2E_INSTALL"] ?? "";
    const installProbeTarget = process.env["WB_E2E_INSTALL_TARGET"] ?? path.join(app.getPath("temp"), "wb-e2e-install");
    const ipcInstall = installProbePath
      ? await window.webContents.executeJavaScript(
          `window.workbuddy.installManaged({ product: "workbuddy-cn", packagePath: ${JSON.stringify(installProbePath)}, targetDirectory: ${JSON.stringify(installProbeTarget)} }).then((r) =>
             r.ok
               ? { ok: true, directory: r.value.instance.directory, version: r.value.instance.version, notes: r.value.notes }
               : { ok: false, code: r.error.code, message: r.error.message })`,
          true,
        )
      : null;
    // 占用判定回归：盘符根记录不得拦住同盘并列目录（真实文件系统，唯一临时目录）
    let occupancyProbe: Record<string, unknown> | null = null;
    if (process.env["WB_E2E_OCCUPANCY_PROBE"] === "1") {
      const probeBase = path.join(app.getPath("temp"), `wb-occ-${Date.now().toString(36)}`);
      const probeFs = new NodeFsPort();
      const deps = {
        exists: (target: string) => probeFs.exists(target),
        isDirectory: async (target: string) => (await probeFs.stat(target))?.isDirectory === true,
        listDirectory: (directory: string) => probeFs.listDirectory(directory),
        realpath: (target: string) => probeFs.realpath(target),
        isWritable: (target: string) => probeFs.isWritable(target),
      };
      const driveRoot = path.parse(probeBase).root;
      const target = path.join(probeBase, "workbuddyCN");
      let created = false;
      try {
        await fsp.mkdir(probeBase, { recursive: true });
        created = true;
        const result = await validateInstallTarget(
          {
            target,
            // 模拟用户机器上的异常线索：盘符根 + 空值 + 相对路径
            occupiedDirectories: [driveRoot, "D:\\", "", "relative\\dir"],
            forbiddenRoots: [],
            selfDirectories: [],
          },
          deps,
        );
        const rootRejected = await validateInstallTarget(
          { target: driveRoot, occupiedDirectories: [driveRoot], forbiddenRoots: [], selfDirectories: [] },
          deps,
        );
        const dDrive = await fsp.stat("D:\\").then(() => true).catch(() => false);
        let dDriveProbe: Record<string, unknown> | null = null;
        if (dDrive) {
          const dResult = await validateInstallTarget(
            { target: "D:\\workbuddyCN", occupiedDirectories: ["D:\\"], forbiddenRoots: [], selfDirectories: [] },
            deps,
          );
          dDriveProbe = { ok: dResult.ok, code: dResult.ok ? null : dResult.error.code };
        }
        occupancyProbe = {
          ok: result.ok,
          code: result.ok ? null : result.error.code,
          message: result.ok ? null : result.error.message,
          driveRoot,
          rootStillRejected: !rootRejected.ok,
          dDriveAvailable: dDrive,
          dDriveProbe,
        };
      } catch (error) {
        occupancyProbe = { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        // 只删除本次创建且路径已核对过的目录
        if (created && path.basename(probeBase).startsWith("wb-occ-")) {
          await fsp.rm(probeBase, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
    // 便携版会脱离父进程，stdout 拿不到 E2E_RESULT：支持把探针结果写到文件
    const occupancyOut = process.env["WB_E2E_OCCUPANCY_OUT"] ?? "";
    if (occupancyOut && occupancyProbe) {
      await fsp.writeFile(occupancyOut, JSON.stringify(occupancyProbe, null, 2), "utf8").catch(() => undefined);
    }
    const exportDir = process.env["WB_E2E_EXPORT_DIR"] ?? "";
    let diagnosticsExport: Record<string, unknown> | null = null;
    if (exportDir) {
      await fsp.mkdir(exportDir, { recursive: true });
      await window.webContents.executeJavaScript(
        `document.querySelector('#btn-export').click(); true`,
        true,
      );
      let files: string[] = [];
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        files = (await fsp.readdir(exportDir).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
        if (files.length > 0) break;
      }
      if (files.length > 0) {
        const raw = await fsp.readFile(path.join(exportDir, files[0]!), "utf8");
        const report = JSON.parse(raw) as Record<string, unknown>;
        const scan = report["scan"] as Record<string, unknown> | undefined;
        const deployment = report["deploymentCapabilities"] as Record<string, unknown> | undefined;
        const last = report["lastOperation"] as Record<string, unknown> | null;
        const history = report["historyStatus"] as Record<string, unknown> | undefined;
        diagnosticsExport = {
          file: files[0],
          schemaVersion: report["schemaVersion"] ?? null,
          diagnosticsSchemaVersion: report["diagnosticsSchemaVersion"] ?? null,
          diagnosticsBuildId: report["diagnosticsBuildId"] ?? null,
          generatedAt: report["generatedAt"] ?? null,
          exportStartedAt: report["exportStartedAt"] ?? null,
          scanStatus: scan?.["status"] ?? null,
          scannedAt: scan?.["scannedAt"] ?? null,
          scanMode: scan?.["mode"] ?? null,
          hasReadOnlyField: scan ? Object.prototype.hasOwnProperty.call(scan, "readOnly") : null,
          hasAvailability: Object.prototype.hasOwnProperty.call(report, "availability"),
          hasAssisted: Object.prototype.hasOwnProperty.call(report, "assisted"),
          deployment,
          managedCount: Array.isArray(report["managedInstances"]) ? (report["managedInstances"] as unknown[]).length : null,
          correlation: Array.isArray(report["scanToManaged"])
            ? (report["scanToManaged"] as Record<string, unknown>[]).map((item) => item["status"])
            : null,
          lastOperationSource: last ? last["source"] : null,
          lastOperationCode: last ? last["failureCode"] : null,
          historyState: history?.["state"] ?? null,
          rawLength: raw.length,
        };
      } else {
        const toastText = await window.webContents.executeJavaScript(
          `document.querySelector('#toast')?.textContent?.trim() ?? ''`,
          true,
        );
        diagnosticsExport = { error: "导出超时：未在目标目录发现 JSON", toast: toastText };
      }
    }
    // 赞助商入口：文案/可聚焦性 + 点击后主进程实际打开的地址（E2E 只记录，不真开浏览器）
    const sponsor = await window.webContents.executeJavaScript(
      `(() => {
        const node = document.querySelector('#sponsor-link');
        if (!node) return null;
        return {
          text: (node.textContent ?? '').trim(),
          tag: node.tagName,
          href: node.getAttribute('href'),
          target: node.getAttribute('target'),
          ariaLabel: node.getAttribute('aria-label') ?? '',
          focusable: node.tabIndex >= 0 && !node.disabled,
          inTopbar: Boolean(node.closest('.topbar')),
        };
      })()`,
      true,
    );
    const sponsorApi = await window.webContents.executeJavaScript(
      `({ hasOpenSponsor: typeof (window.workbuddy && window.workbuddy.openSponsor) === 'function' })`,
      true,
    );
    const sponsorOpenLog = process.env["WB_E2E_OPEN_LOG"] ?? "";
    let sponsorOpened: string[] = [];
    let sponsorInjected: Record<string, unknown> | null = null;
    if (sponsorOpenLog) {
      const readLog = async () =>
        (await fsp.readFile(sponsorOpenLog, "utf8").catch(() => ""))
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      const waitForLines = async (count: number) => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if ((await readLog()).length >= count) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      await window.webContents.executeJavaScript(`document.querySelector('#sponsor-link').click(); true`, true);
      await waitForLines(1);
      // 负向探针：渲染进程试图注入任意 URL，主进程必须仍然只打开固定地址
      sponsorInjected = (await window.webContents.executeJavaScript(
        `window.workbuddy.openSponsor('https://evil.example/').then((r) =>
           r.ok ? { ok: true, url: r.value.url } : { ok: false, code: r.error.code })`,
        true,
      )) as Record<string, unknown>;
      await waitForLines(2);
      sponsorOpened = await readLog();
    }
    const probeFile = process.env["WB_E2E_PROBE_FILE"] ?? "";
    const probe = probeFile ? await inspectWindowsFile(probeFile) : null;
    console.log(
      `E2E_RESULT ${JSON.stringify({
        ok: true,
        title,
        appVersion: state?.appVersion ?? null,
        buildId: state?.buildId ?? null,
        packaged: state?.packaged ?? null,
        productCards,
        installItems,
        statuses,
        topbarText,
        bodyText,
        diagnosticsVisible,
        versionSelects,
        installPathUi,
        occupancyProbe,
        diagnosticsExport,
        sponsor,
        sponsorApi,
        sponsorOpened,
        sponsorInjected,
        narrowLayout,
        sourcesHeading,
        sourcesNote,
        parts,
        hasConfirmDialog,
        hasProgressBar,
        assistedTables,
        probe,
        ipcInspect,
        ipcInstall,
        treeProbe,
        screenshots: shots,
      })}`,
    );
  } catch (error) {
    console.log(`E2E_RESULT ${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}`);
  } finally {
    app.exit(0);
  }
}

// 脚本模式（--e2e / --scan-report）是独立诊断进程，不参与单实例锁；
// 否则用户开着管理器时这些命令会静默退出，表现为“无结果、退出码 0”。
const singleInstance = isE2E || isScanReport ? true : app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // 脚本模式必须把错误写进 stdout，不能只弹窗或只写 stderr
    if (isScanReport) {
      process.stdout.write(`${JSON.stringify({ error: { code: "E_INTERNAL", message } })}\n`);
      app.exit(1);
      return;
    }
    if (isE2E) {
      console.log(`E2E_RESULT ${JSON.stringify({ ok: false, error: message })}`);
      app.exit(1);
      return;
    }
    console.error("启动失败", error);
    dialog.showErrorBox("启动失败", message);
    app.exit(1);
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });

  // 明确不使用 shell.openExternal 打开任意 URL，避免远程内容进入应用上下文
  void shell;
}
