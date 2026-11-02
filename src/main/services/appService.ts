import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  fail,
  ok,
  PRODUCT_IDS,
  PRODUCT_LABELS,
  type AppState,
  type AssistedKind,
  type AssistedOutcome,
  type AssistedResult,
  type CapabilityState,
  type DeployOutcome,
  type InstallRecord,
  type InstallSelection,
  type ManagedInstance,
  type OperationAvailability,
  type OperationKind,
  type OperationPlan,
  type OperationRecord,
  type OperationResult,
  type PackageCheck,
  type PackageFormat,
  type ProductId,
  type ProductProfile,
  type Result,
  type ScanReport,
  type SnapshotSummary,
  type UninstallOutcome,
  type UpdateStatus,
} from "../../core/contracts";
import {
  compareAfterLaunch,
  deriveOperationAvailability,
  evaluateAssistedPackage,
  parseUninstallCommand,
  snapshotOf,
  type SignerBaseline,
} from "../../core/assisted";
import { DEFAULT_RELEASE_CONFIG, HttpReleaseSource, releaseConfigSchema, type ReleaseConfig } from "../../core/releaseSource";
import { deriveCapabilities, parseEvidenceBundle, profilesFromEvidence, EMPTY_EVIDENCE, type LoadedEvidence } from "../../core/evidence";
import { buildPlan, renderPlanText } from "../../core/plan";
import { deployPackage, removeManagedDirectory, replaceInstanceInPlace } from "../../core/managedInstall";
import { classifyPackage } from "../../core/packageFormat";
import { FileTransaction } from "../../core/transaction";
import { isTemporaryOperationPath, scanInstallations, type ManagedInstallation, type RegistryReader } from "../../core/scanner";
import { verifyProductIdentity } from "../../core/identity";
import { verifyPackage } from "../../core/packageVerifier";
import {
  correlateScanAndManaged,
  serializeDiagnostics,
  type DiagnosticErrorRecord,
  type HistoryStatus,
  type ManagedInstanceDiagnostic,
  type ScanStatus,
} from "../../core/diagnostics";
import {
  PathGuard,
  backupsDirectory,
  isDriveRoot,
  productFolderName,
  toCompareKey,
  validateInstallTarget,
  versionDirectory,
} from "../../core/pathGuard";
import { OFFICIAL_SITES, SPONSOR_SITE } from "../../core/knownProducts";
import {
  evaluateAutoTrack,
  mergeAutoTrackedInstances,
  type AutoTrackDecision,
  type AutoTrackProbe,
} from "../../core/autoTrack";
import type { JournalStore } from "../../core/journal";
import { parseUninstallInvocation } from "../../core/assisted";
import { SevenZipAdapter, type ArchivePort } from "../adapters/sevenZip";
import type { NodeFsPort } from "../adapters/fsPort";
import { inspectWindowsFile } from "../adapters/windows";
import { WindowsShortcutReader } from "../adapters/shortcuts";
import { WindowsProcessReader } from "../adapters/processes";
import { WindowsCommonLocationReader } from "../adapters/commonLocations";
import { WindowsShortcutWriter, type ShortcutPort } from "../adapters/shortcutWriter";
import { buildShortcutSpec } from "../../core/shortcutSpec";
import type { ErrorLogPort } from "../errorLog";

/**
 * 应用服务：所有用例的唯一入口。界面只能通过 IPC 白名单调用这里的方法。
 * 约束：能力门未通过时，install/update/uninstall 一律返回 E_CAPABILITY_BLOCKED，
 * 即使内部实现存在也不会执行。
 */

/** 官方安装包的轻量判定：签名有效 + 发布者为腾讯。不依赖任何证据包。 */
export function isOfficialPackageSignature(
  authenticode: { status: string; signerSubject: string | null } | null | undefined,
): boolean {
  if (!authenticode) return false;
  if (authenticode.status !== "Valid") return false;
  return /tencent/i.test(authenticode.signerSubject ?? "");
}

export interface Settings {
  managementRoot: string;
  userScanRoots: string[];
  autoCheckUpdates: boolean;
  autoDownload: boolean;
  autoInstall: boolean;
}

/** 官方界面启动器：测试注入假实现，保证任何自动化都不启动真实客户端。 */
export interface AssistedLaunchOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
}

export type AssistedLauncher = (file: string, timeoutMs: number) => Promise<AssistedLaunchOutcome>;

function defaultLauncher(file: string, timeoutMs: number): Promise<AssistedLaunchOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: AssistedLaunchOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // 只启动原厂交互式界面：不附加静默参数、不隐藏窗口、不提升权限
      child = spawn(file, [], { stdio: "ignore", windowsHide: false, detached: false });
    } catch (error) {
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略：进程可能已退出
      }
      finish({ exitCode: null, signal: "timeout", timedOut: true, error: null });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ exitCode: null, signal: null, timedOut: false, error: error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      finish({ exitCode: code, signal: signal ?? null, timedOut: false, error: null });
    });
  });
}

export interface AppServiceDeps {
  appVersion: string;
  /** 构建标识（打包时由构建脚本注入；未注入时为 dev） */
  buildId?: string;
  buildTime?: string;
  packaged?: boolean;
  stateDir: string;
  managementRoot: string;
  isWindows: boolean;
  /** 携带版：数据与受管目录位于 exe 同级目录 */
  portable: boolean;
  /** 本工具自身的运行/打包目录，用于把自身目录排除在安装统计之外 */
  selfDirectories: string[];
  fs: NodeFsPort;
  registry: RegistryReader;
  journal: JournalStore;
  now: () => string;
  bundledEvidenceFile: string;
  configDirectory: string;
  /** 启动官方界面的实现（默认 spawn；测试注入假实现） */
  launcher?: AssistedLauncher;
  /** 读取文件签名/版本信息（测试注入假实现） */
  inspectFile?: (file: string) => Promise<{
    authenticode: { status: string; signerSubject: string | null; signerThumbprint: string | null; notAfter: string | null; chainOk: boolean } | null;
    versionInfo: { productName: string | null; fileDescription: string | null; fileVersion: string | null } | null;
  }>;
  /** 环境变量（解析 %VAR% 形式的卸载命令） */
  env?: Record<string, string | undefined>;
    /** 归档读取端点（默认使用内置 7-Zip；测试注入假实现） */
  archive?: ArchivePort;
    /** 应用根目录（用于定位开发态内置 7-Zip） */
  appPath?: string;
    /** 打包后的 resources 目录（内置 7-Zip 由 extraResources 放在这里） */
  resourcesPath?: string | null;
  /** 进程列表（用于更新前检测目标是否在运行；测试可注入） */
  processes?: { list(): Promise<{ path: string; name: string }[]> };
  /** 桌面快捷方式（测试注入假实现，避免在测试机上真的创建快捷方式） */
  shortcuts?: ShortcutPort;
  /** 失败日志（默认写入 state/errors） */
  errorLog?: ErrorLogPort;
  /** 打开外部浏览器（主进程注入 shell.openExternal） */
  openExternal?: (url: string) => Promise<void>;
  /** 卸载后轮询等待目录消失的最长时间（测试可调小） */
  uninstallPollMs?: number;
  /** 执行外部程序并等待退出（卸载器；测试可注入） */
  execRunner?: (file: string, args: string[], timeoutMs: number) => Promise<{ exitCode: number | null; timedOut: boolean }>;
  /**
   * 扫描实现覆盖点：仅用于自动化测试注入假扫描结果，
   * 保证测试不会读取或启动真实客户端。
   */
  scanImplementation?: (context: {
    profiles: ProductProfile[];
    userRoots: string[];
    managed: ManagedInstallation[];
    selfDirectories: string[];
    temporaryDirectory: string;
  }) => Promise<ScanReport>;
  /** 进度回调，由主进程转发给界面（只含阶段文字与百分比，不含路径细节） */
  emit?: (event: { operationId: string; product: ProductId; phase: string; percent: number }) => void;
}

interface PreviewBundle {
  plan: OperationPlan;
  text: string;
}

export class AppService {
  private settings: Settings;
  private evidence: LoadedEvidence = EMPTY_EVIDENCE;
  private profiles: ProductProfile[] = profilesFromEvidence(EMPTY_EVIDENCE);
  private capability: CapabilityState = deriveCapabilities(EMPTY_EVIDENCE);
  private scanResult: ScanReport | null = null;
  private packageCache = new Map<ProductId, PackageCheck>();
  private updates: UpdateStatus[] = PRODUCT_IDS.map((product) => ({
    product,
    checkedAt: null,
    currentVersion: null,
    latestVersion: null,
    state: "unknown",
    reason: "尚未检查",
  }));
  private lastDiagnostics: string | null = null;
  private releaseConfig: ReleaseConfig = DEFAULT_RELEASE_CONFIG;
  private aborts = new Map<string, AbortController>();
  private lastAssisted: AssistedResult | null = null;
  private signerBaselines = new Map<ProductId, SignerBaseline>();
  private instances: ManagedInstance[] = [];
  private autoTrackDecisions: AutoTrackDecision[] = [];
  private archiveCache: ArchivePort | null = null;

  constructor(private readonly deps: AppServiceDeps) {
    this.settings = {
      managementRoot: deps.managementRoot,
      userScanRoots: [],
      autoCheckUpdates: false,
      autoDownload: false,
      autoInstall: false,
    };
  }

  private get settingsFile(): string {
    return path.join(this.deps.stateDir, "settings.json");
  }

  private get installationsFile(): string {
    return path.join(this.deps.stateDir, "installations.json");
  }

  private get userEvidenceFile(): string {
    return path.join(this.deps.stateDir, "evidence.json");
  }

  async init(): Promise<void> {
    const settingsText = await this.deps.fs.readText(this.settingsFile);
    if (settingsText) {
      try {
        const parsed = JSON.parse(settingsText) as Partial<Settings>;
        this.settings = {
          managementRoot: typeof parsed.managementRoot === "string" ? parsed.managementRoot : this.deps.managementRoot,
          userScanRoots: Array.isArray(parsed.userScanRoots) ? parsed.userScanRoots.filter((x) => typeof x === "string") : [],
          autoCheckUpdates: parsed.autoCheckUpdates === true,
          autoDownload: parsed.autoDownload === true,
          autoInstall: parsed.autoInstall === true,
        };
      } catch {
        // 设置损坏时使用默认值，不删除原文件
      }
    }

    const configText = await this.deps.fs.readText(path.join(this.deps.configDirectory, "releases.json"));
    if (configText) {
      try {
        const parsed = releaseConfigSchema.safeParse(JSON.parse(configText));
        if (parsed.success) this.releaseConfig = parsed.data;
      } catch {
        // 配置损坏 → 保持“无已验证来源”的默认值（fail-closed）
      }
    }

    const userEvidenceText = await this.deps.fs.readText(this.userEvidenceFile);
    const bundledText = await this.deps.fs.readText(this.deps.bundledEvidenceFile);
    const raw = userEvidenceText ?? bundledText;
    if (raw) {
      this.evidence = parseEvidenceBundle(raw, {
        ref: userEvidenceText ? "state/evidence.json" : "config/evidence.json",
        capturedAt: this.deps.now(),
        environment: "local",
      });
    }
    await this.loadInstances();
    this.recomputeProfiles();
  }

  private recomputeProfiles(): void {
    this.profiles = profilesFromEvidence(this.evidence);
    this.capability = deriveCapabilities(this.evidence);
  }

  async getState(): Promise<AppState> {
    const configured = PRODUCT_IDS.every((product) => {
      const entry = this.releaseConfig.products[product];
      return Boolean(entry && entry.endpoint && entry.schema !== "unverified" && entry.hosts.length > 0);
    });
    return {
      appVersion: this.deps.appVersion,
      buildId: this.deps.buildId ?? "dev",
      buildTime: this.deps.buildTime ?? "dev",
      packaged: this.deps.packaged === true,
      platform: process.platform,
      isWindows: this.deps.isWindows,
      portable: this.deps.portable,
      managementRoot: this.settings.managementRoot,
      onlineSource: {
        configured,
        note: configured
          ? "已配置官方在线来源"
          : "官方在线来源尚未配置：不显示在线版本，也不会发起任何网络请求",
      },
      capability: this.capability,
      operations: await this.operationAvailability(),
      profiles: this.profiles,
      scan: this.scanResult,
      updates: this.updates,
      instances: this.instances,
      autoTrack: this.autoTrackDecisions,
      lastDiagnosticsExport: this.lastDiagnostics,
    };
  }

  /* ------------------------------------------------------- 辅助操作能力（按产品×按操作） */

  private discoveryOf(product: ProductId) {
    return this.scanResult?.products.find((item) => item.product === product) ?? null;
  }

  private onlineVerified(product: ProductId): boolean {
    const entry = this.releaseConfig.products[product];
    return Boolean(entry && entry.endpoint && entry.schema !== "unverified" && entry.hosts.length > 0);
  }

  /**
   * 每产品 × 每操作的能力状态。与“检测状态”独立：
   * 扫描到安装不等于开放写操作，反之亦然。
   */
  async operationAvailability(): Promise<OperationAvailability[]> {
    const existing = new Set<string>();
    const candidates: string[] = [];
    for (const product of PRODUCT_IDS) {
      const discovery = this.discoveryOf(product);
      for (const record of [...(discovery?.installs ?? []), ...(discovery?.pendingPath ?? [])]) {
        const parsed = parseUninstallCommand(record.uninstallString, this.deps.env ?? process.env);
        if (parsed.executable) candidates.push(parsed.executable);
      }
    }
    await Promise.all(
      candidates.map(async (target) => {
        if (await this.deps.fs.isFile(target)) existing.add(target.toLowerCase());
      }),
    );

    const list: OperationAvailability[] = [];
    for (const product of PRODUCT_IDS) {
      list.push(
        ...deriveOperationAvailability({
          product,
          discovery: this.discoveryOf(product),
          onlineVerified: this.onlineVerified(product),
          exists: (target) => existing.has(target.toLowerCase()),
          env: this.deps.env ?? process.env,
        }),
      );
    }
    return list;
  }

  /** 禁止安装到系统目录（不做提权） */
  private forbiddenInstallRoots(): string[] {
    const env = this.deps.env ?? process.env;
    return [
      env["SystemRoot"] ?? "C:\\Windows",
      env["ProgramFiles"] ?? "C:\\Program Files",
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      env["ProgramData"] ?? "C:\\ProgramData",
    ].filter((item): item is string => typeof item === "string" && item !== "");
  }

  private shortcutWriter(): ShortcutPort {
    return this.deps.shortcuts ?? new WindowsShortcutWriter();
  }

  /** 记录真实失败：日志写失败不影响原始错误返回 */
  private async logFailure(entry: {
    operation: string;
    product: ProductId | null;
    instanceId: string | null;
    stage: string;
    code: string;
    message: string;
    stagingDirectory?: string | null;
    rolledBack: boolean;
    detail?: Record<string, string | number | boolean | null>;
  }): Promise<string | null> {
    if (!this.deps.errorLog) return null;
    return this.deps.errorLog.write(entry);
  }

  /** 创建/修复实例的桌面快捷方式；失败只返回原因，绝不回滚安装 */
  private async ensureShortcut(instance: ManagedInstance): Promise<{ path: string | null; note: string }> {
    const relative = instance.executableRelativePath;
    if (!relative) return { path: null, note: "桌面快捷方式未创建：未识别到主程序相对路径" };
    const expected = path.resolve(instance.directory, relative);
    const targetExists = await this.deps.fs.isFile(expected);
    const spec = buildShortcutSpec({
      product: instance.product,
      directory: instance.directory,
      executableRelativePath: relative,
      exists: (target) => target.toLowerCase() === expected.toLowerCase() && targetExists,
    });
    if (!spec.ok) return { path: null, note: `桌面快捷方式未创建：${spec.reason}` };

    const created = await this.shortcutWriter().create(spec.spec);
    if (!created.ok) return { path: null, note: `程序已安装，桌面快捷方式创建失败：${created.reason}` };

    this.instances = this.instances.map((item) =>
      item.instanceId === instance.instanceId ? { ...item, shortcutPath: created.path } : item,
    );
    await this.saveInstances();
    return { path: created.path, note: `已创建桌面快捷方式：${spec.spec.name}` };
  }

  /** 删除本工具创建的快捷方式；用户自己创建的不动 */
  private async removeShortcut(instance: ManagedInstance): Promise<string | null> {
    if (!instance.shortcutPath) return null;
    const removed = await this.shortcutWriter().remove(instance.shortcutPath);
    if (!removed.ok) return `桌面快捷方式删除失败：${removed.reason ?? "未知原因"}`;
    this.instances = this.instances.map((item) =>
      item.instanceId === instance.instanceId ? { ...item, shortcutPath: null } : item,
    );
    await this.saveInstances();
    return "已删除本工具创建的桌面快捷方式";
  }

  private inspect(file: string) {
    return (this.deps.inspectFile ?? inspectWindowsFile)(file);
  }

  /** 已安装主程序的可执行文件候选（只来自扫描线索，不猜路径） */
  private candidateExecutables(product: ProductId): string[] {
    const discovery = this.discoveryOf(product);
    const list: string[] = [];
    for (const record of discovery?.installs ?? []) {
      for (const clue of record.clues) {
        if (clue.detail && clue.detail.toLowerCase().endsWith(".exe")) list.push(clue.detail);
      }
      const relative = this.profileOf(product).executableRelativePath;
      if (record.installLocation && relative) list.push(path.join(record.installLocation, relative));
    }
    return [...new Set(list)];
  }

  /**
   * 发布者基线：证据包（verified）→ 用户在本机显式确认过的发布者（observed）→
   * 本机已安装主程序的签名发布者（observed-install）→ 无基线（拒绝）。
   * 用户确认层是首次安装唯一可行的入口，且必须由用户在确认框里明确勾选，
   * 绝不自动信任新证书。
   */
  private async signerBaseline(
    product: ProductId,
    purpose: "package" | "binary" = "binary",
  ): Promise<SignerBaseline> {
    const cacheKey = `${product}:${purpose}`;
    const cached = this.signerBaselines.get(cacheKey as ProductId);
    if (cached) return cached;
    const profile = this.profileOf(product);
    if (profile.trustedSignerSubjects.length > 0) {
      const baseline: SignerBaseline = { source: "evidence", subjects: profile.trustedSignerSubjects };
      this.signerBaselines.set(cacheKey as ProductId, baseline);
      return baseline;
    }
    const approved = await this.userTrustedSigners(product, purpose);
    if (approved.subjects.length > 0) {
      const baseline: SignerBaseline = {
        source: "user-approved",
        subjects: approved.subjects,
        thumbprints: approved.thumbprints,
      };
      this.signerBaselines.set(cacheKey as ProductId, baseline);
      return baseline;
    }
    // 安装包与已安装主程序由官方用不同证书签发，不能互相充当基线
    if (purpose === "package") return { source: "none", subjects: [] };
    for (const executable of this.candidateExecutables(product)) {
      if (!(await this.deps.fs.isFile(executable))) continue;
      const info = await this.inspect(executable);
      const subject = info.authenticode?.status === "Valid" ? info.authenticode.signerSubject : null;
      if (subject) {
        const baseline: SignerBaseline = {
          source: "observed-install",
          subjects: [subject],
          thumbprints: info.authenticode?.signerThumbprint ? [info.authenticode.signerThumbprint] : [],
        };
        this.signerBaselines.set(cacheKey as ProductId, baseline);
        return baseline;
      }
    }
    return { source: "none", subjects: [] };
  }

  private get signerTrustFile(): string {
    return path.join(this.deps.stateDir, "signer-trust.json");
  }

  private async userTrustedSigners(
    product: ProductId,
    purpose: "package" | "binary" = "binary",
  ): Promise<{ subjects: string[]; thumbprints: string[] }> {
    const text = await this.deps.fs.readText(this.signerTrustFile);
    if (!text) return { subjects: [], thumbprints: [] };
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const bucket = parsed?.[product];
      // 兼容旧格式：直接是数组时按 binary 处理
      const list = Array.isArray(bucket)
        ? purpose === "binary"
          ? bucket
          : []
        : ((bucket as Record<string, { subject?: unknown; thumbprint?: unknown }[]> | undefined)?.[purpose] ?? []);
      if (!Array.isArray(list)) return { subjects: [], thumbprints: [] };
      const subjects = list.map((item) => (typeof item?.subject === "string" ? item.subject : "")).filter((item) => item !== "");
      const thumbprints = list
        .map((item) => (typeof item?.thumbprint === "string" ? item.thumbprint.replace(/[^0-9a-f]/gi, "") : ""))
        .filter((item) => item !== "");
      return { subjects, thumbprints };
    } catch {
      return { subjects: [], thumbprints: [] };
    }
  }

  /** 用户显式确认「信任该发布者」后，把它记录为本机基线。 */
  async trustSigner(input: {
    product: ProductId;
    subject: string;
    thumbprint?: string | null;
    purpose?: "package" | "binary";
  }): Promise<Result<true>> {
    const subject = input.subject.trim();
    if (subject === "") return fail("E_VALIDATION", "发布者主题为空，无法记录信任");
    const purpose = input.purpose ?? "package";
    const text = await this.deps.fs.readText(this.signerTrustFile);

    type Entry = { subject: string; thumbprint: string | null; approvedAt: string };
    type Bucket = { package: Entry[]; binary: Entry[] };
    const store: Record<string, Bucket> = {};
    if (text) {
      try {
        const existing = JSON.parse(text) as Record<string, unknown>;
        for (const [key, value] of Object.entries(existing ?? {})) {
          if (Array.isArray(value)) {
            store[key] = { package: [], binary: value as Entry[] };
          } else if (value && typeof value === "object") {
            const bucket = value as Partial<Bucket>;
            store[key] = {
              package: Array.isArray(bucket.package) ? bucket.package : [],
              binary: Array.isArray(bucket.binary) ? bucket.binary : [],
            };
          }
        }
      } catch {
        // 损坏时重建，不删除原文件内容以外的任何东西
      }
    }

    const bucket = store[input.product] ?? { package: [], binary: [] };
    const list = bucket[purpose];
    const sameThumb =
      input.thumbprint !== undefined &&
      input.thumbprint !== null &&
      list.some((item) => (item.thumbprint ?? "").toUpperCase() === input.thumbprint!.toUpperCase());
    if (!sameThumb && !list.some((item) => item.subject.toLowerCase() === subject.toLowerCase())) {
      list.push({ subject, thumbprint: input.thumbprint ?? null, approvedAt: this.deps.now() });
    }
    bucket[purpose] = list;
    store[input.product] = bucket;

    await this.deps.fs.writeFile(this.signerTrustFile, JSON.stringify(store, null, 2));
    this.signerBaselines.delete(`${input.product}:package` as ProductId);
    this.signerBaselines.delete(`${input.product}:binary` as ProductId);
    return ok(true);
  }

  /** 供界面显示「当前发布者基线来源」 */
  async signerBaselineInfo(product: ProductId): Promise<{ source: string; subjects: string[]; thumbprints: string[] }> {
    const baseline = await this.signerBaseline(product, "package");
    return { source: baseline.source, subjects: baseline.subjects, thumbprints: baseline.thumbprints ?? [] };
  }

  /* ------------------------------------------------------- 辅助启动（安装 / 更新 / 卸载） */

  async runAssisted(input: {
    product: ProductId;
    kind: AssistedKind;
    packagePath?: string | null;
    targetRecordId?: string | null;
    confirmed: boolean;
    timeoutMs?: number;
  }): Promise<Result<AssistedResult>> {
    if (input.confirmed !== true) {
      return fail("E_VALIDATION", "必须由用户在确认框中明确同意后才能启动官方界面");
    }
    // 能力判定必须基于最新一次扫描，否则可能对已消失的安装做操作
    if (!this.scanResult) await this.scan();
    const availability = (await this.operationAvailability()).find(
      (item) => item.product === input.product && item.kind === input.kind,
    );
    if (!availability) return fail("E_VALIDATION", "未知的产品或操作类型");
    if (availability.state === "blocked") {
      return fail("E_CAPABILITY_BLOCKED", availability.reason);
    }
    if (availability.state === "guidance-only") {
      return fail("E_CAPABILITY_BLOCKED", `${availability.reason}（本工具不会代为执行）`);
    }

    let launchTarget: string;
    const notes: string[] = [];
    const product = input.product;

    if (input.kind === "uninstall") {
      const recordId = input.targetRecordId ?? "";
      if (recordId === "") return fail("E_VALIDATION", "卸载必须明确指定一个安装实例");
      const target = availability.targets.find((item) => item.recordId === recordId);
      if (!target) return fail("E_VALIDATION", "指定的安装实例不在当前扫描结果中");
      if (!target.uninstallerPath) {
        return fail("E_CAPABILITY_BLOCKED", target.uninstallerDetail ?? "该实例没有可直接启动的官方卸载程序");
      }
      const discovery = this.discoveryOf(product);
      const record = discovery?.installs.find((item) => item.id === recordId);
      if (!record || record.identity !== "identified" || record.needsReview) {
        return fail("E_IDENTITY_UNKNOWN", "该实例身份未确认或需人工确认，禁止启动卸载程序");
      }
      if (!record.installLocation) return fail("E_VALIDATION", "该实例没有可用安装路径");
      if (!this.insideDirectory(target.uninstallerPath, record.installLocation)) {
        return fail(
          "E_PATH_REJECTED",
          "登记的卸载程序不在该安装目录内，为避免误删其他程序，请从「应用和功能」手动卸载",
        );
      }
      launchTarget = target.uninstallerPath;
      notes.push(`目标实例：${record.installLocation}`);
      notes.push("官方卸载程序是否删除用户数据未知；本工具不删除任何文件、注册表或快捷方式");
    } else {
      const raw = input.packagePath ?? "";
      if (raw.trim() === "") return fail("E_VALIDATION", "需要先选择一个官方安装包");
      if (!path.isAbsolute(raw)) return fail("E_VALIDATION", "安装包必须使用绝对路径");
      if (!raw.toLowerCase().endsWith(".exe")) return fail("E_VALIDATION", "只接受 .exe 官方安装包");
      if (!(await this.deps.fs.isFile(raw))) return fail("E_NOT_FOUND", "安装包文件不存在或不可读");

      const inspected = await this.inspectPackage(raw, product);
      if (!inspected.ok) return inspected;
      const baseline = await this.signerBaseline(product);
      const verdict = evaluateAssistedPackage(inspected.value, baseline);
      if (!verdict.allowed) {
        return fail("E_SIGNATURE_INVALID", `安装包未通过预检：${verdict.reasons.join("；")}`, {
          verdict: inspected.value.verdict,
          baseline: baseline.source,
        });
      }
      notes.push(...verdict.reasons);
      notes.push(`安装包：${inspected.value.file}`);
      notes.push(`SHA-256：${inspected.value.sha256}`);

      if (input.kind === "update") {
        if (input.targetRecordId) {
          const target = availability.targets.find((item) => item.recordId === input.targetRecordId);
          if (!target) return fail("E_VALIDATION", "指定的更新目标不在当前扫描结果中");
          notes.push(`更新目标：${target.path ?? "(路径待解析)"}`);
        } else if (availability.requiresTarget) {
          return fail("E_VALIDATION", "更新必须明确指定一个安装实例");
        }
      }
      launchTarget = raw;
      notes.push("只启动官方交互式安装器：不附加静默参数、不指定安装目录、不模拟点击");
    }

    // 记录操作前的检测快照
    const other = product === "workbuddy-cn" ? "workbuddy-ai" : "workbuddy-cn";
    const before: SnapshotSummary = snapshotOf(this.scanResult, product);
    const counterpartBefore: SnapshotSummary = snapshotOf(this.scanResult, other);
    const launchedAt = this.deps.now();

    const launcher = this.deps.launcher ?? defaultLauncher;
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 10 * 60 * 1000, 30_000), 30 * 60 * 1000);
    const launched = await launcher(launchTarget, timeoutMs);

    // 无论安装器结果如何都以复扫为准
    await this.scan();
    const after = snapshotOf(this.scanResult, product);
    const counterpartAfter = snapshotOf(this.scanResult, other);
    const comparison = compareAfterLaunch(input.kind, before, after, counterpartBefore, counterpartAfter, product);

    let outcome: AssistedOutcome;
    if (launched.error) outcome = "installer-failed";
    else if (launched.timedOut) outcome = "timeout";
    else if (comparison.rescanConfirmed) outcome = "launched-and-verified";
    else outcome = "launched-not-verified";

    notes.push(...comparison.notes);
    notes.push("进程退出码与窗口关闭都不作为成功依据，结论以复扫结果为准");

    const result: AssistedResult = {
      product,
      kind: input.kind,
      outcome,
      launchedPath: launchTarget,
      launchedAt,
      exitCode: launched.exitCode,
      timedOut: launched.timedOut,
      before,
      after,
      counterpart: { product: other, ...counterpartAfter, changed: comparison.counterpartChanged },
      rescanConfirmed: comparison.rescanConfirmed,
      notes,
    };
    this.lastAssisted = result;
    return ok(result);
  }

  /* ------------------------------------------------------- 受管实例：真实安装 / 更新 / 卸载 */

  private get instancesFile(): string {
    return path.join(this.deps.stateDir, "instances.json");
  }

  async listInstances(): Promise<ManagedInstance[]> {
    return this.instances;
  }

  private async loadInstances(): Promise<void> {
    const text = await this.deps.fs.readText(this.instancesFile);
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) return;
      this.instances = parsed
        .filter((item): item is ManagedInstance => {
          if (typeof item !== "object" || item === null) return false;
          const record = item as Record<string, unknown>;
          return (
            (record["product"] === "workbuddy-cn" || record["product"] === "workbuddy-ai") &&
            typeof record["instanceId"] === "string" &&
            typeof record["directory"] === "string" &&
            typeof record["version"] === "string"
          );
        })
        // 旧版本把自动登记写成 "adopted"，这里统一迁移为 "external"
        .map((item) => ({ ...item, origin: item.origin === "deployed" ? "deployed" : "external" }));
    } catch {
      // 注册表损坏时视为空，不删除原文件，避免误删用户部署记录
    }
  }

  private async saveInstances(): Promise<void> {
    await this.deps.fs.writeFile(this.instancesFile, JSON.stringify(this.instances, null, 2));
  }

  private archivePort(): Result<ArchivePort> {
    if (this.deps.archive) return ok(this.deps.archive);
    if (this.archiveCache) return ok(this.archiveCache);
    const appPath = this.deps.appPath ?? process.cwd();
    const adapter = SevenZipAdapter.resolve(SevenZipAdapter.defaultCandidates(appPath, this.deps.resourcesPath ?? null));
    if (!adapter) {
      return fail("E_PACKAGE_FORMAT", "管理器内置解包组件缺失，请重新下载并解压管理器");
    }
    this.archiveCache = adapter;
    return ok(adapter);
  }

  private normalizeVersion(raw: string | null | undefined): string | null {
    const value = (raw ?? "").trim();
    if (value === "") return null;
    // 只保留数字与点，去掉 "v" 前缀和多余段尾
    const cleaned = value.replace(/^v/i, "").replace(/[^0-9.]+$/, "");
    return /^\d+(\.\d+)*$/.test(cleaned) ? cleaned : null;
  }

  private instanceId(product: ProductId, version: string, directory: string): string {
    const digest = createHash("sha1").update(toCompareKey(directory)).digest("hex").slice(0, 8);
    return `${product}@${version}@${digest}`;
  }

  /** 探测安装目录内的主可执行文件（相对路径），只读，不执行。 */
  private async detectExecutable(directory: string, product: ProductId): Promise<string | null> {
    const relative = this.profileOf(product).executableRelativePath;
    if (relative && (await this.deps.fs.isFile(path.join(directory, relative)))) return relative;
    const entries = await this.deps.fs.listDirectory(directory).catch(() => [] as string[]);
    const exes = entries.filter((name) => name.toLowerCase().endsWith(".exe"));
    if (exes.length === 0) return null;
    // 官方目录里还有 Uninstall WorkBuddy.exe / RepairApp.exe，必须先排除维护程序
    const maintenance = /uninstall|repair|update|crash/i;
    const preferred =
      exes.find((name) => /^workbuddy(ai)?\.exe$/i.test(name)) ??
      exes.find((name) => /workbuddy/i.test(name) && !maintenance.test(name)) ??
      null;
    return preferred;
  }

  private async verifyDeployed(
    directory: string,
    product: ProductId,
  ): Promise<{ ok: boolean; reason?: string; version?: string }> {
    const executable = await this.detectExecutable(directory, product);
    if (!executable) return { ok: false, reason: "解包目录中没有客户端主程序" };
    if (!(await this.deps.fs.isFile(path.join(directory, executable)))) {
      return { ok: false, reason: "客户端主程序文件不存在" };
    }
    return { ok: true };
  }

  private async detectPackageFormat(file: string): Promise<PackageFormat> {
    const archive = this.archivePort();
    if (!archive.ok) return "unknown";
    try {
      return classifyPackage(file, await archive.value.list(file));
    } catch {
      return "unknown";
    }
  }

  /* ------------------------------------------------------- 接管既有安装（只登记，不动文件） */

  /**
   * 接管是只读登记：不移动、不覆盖、不删除、不改客户端文件或注册表。
   * 因此这里的路径校验不能用写操作的 PathGuard（它要求目标在管理根内），
   * 而是单独校验“可作为跟踪目标”的条件。
   */
  async installFromPackage(input: {
    product: ProductId;
    packagePath: string;
    targetDirectory?: string | null;
    source?: "local-file" | "official";
    operationPrefix?: string;
  }): Promise<Result<DeployOutcome>> {
    const product = input.product;
    const inspected = await this.inspectPackage(input.packagePath, product);
    if (!inspected.ok) {
      await this.logFailure({
        operation: "install",
        product,
        instanceId: null,
        stage: "inspect-package",
        code: inspected.error.code,
        message: inspected.error.message,
        rolledBack: true,
      });
      return inspected;
    }
    const check = inspected.value;

    // 签名与信任基线只用于诊断：不再阻断安装，也不再要求用户额外批准发布者
    const version = this.normalizeVersion(check.productVersion) ??
      this.normalizeVersion(path.basename(check.file)) ?? "unknown";

    // 安装目标必须由用户明确选择：不再静默回退到管理根下的默认路径
    const requested = (input.targetDirectory ?? "").trim();
    if (requested === "") {
      return fail("E_VALIDATION", "请先选择安装目录：安装目标不能为空");
    }

    // 只有“有效的本地安装目录”才算占用：空值、相对路径、盘符根一律丢弃。
    // 盘符根来自异常的进程线索（D://）时，不能让它拦住该盘所有安装目标。
    const occupied = [
      ...this.instances.map((item) => item.directory),
      ...(this.scanResult?.records ?? []).map((record) => record.installLocation),
    ].filter(
      (item): item is string =>
        typeof item === "string" && item.trim() !== "" && path.isAbsolute(item) && !isDriveRoot(item),
    );
    const validated = await validateInstallTarget(
      {
        target: requested,
        forbiddenRoots: this.forbiddenInstallRoots(),
        selfDirectories: this.deps.selfDirectories,
        occupiedDirectories: occupied,
      },
      {
        exists: (target) => this.deps.fs.exists(target),
        isDirectory: async (target) => (await this.deps.fs.stat(target))?.isDirectory === true,
        listDirectory: (directory) => this.deps.fs.listDirectory(directory),
        realpath: (target) => this.deps.fs.realpath(target),
        isWritable: (target) => this.deps.fs.isWritable(target),
      },
    );
    if (!validated.ok) return validated;
    const target = validated.value.absolute;

    // 目标已存在（且已验证为空目录）：提交前再确认一次，然后移除空目录让事务重新创建，
    // 避免“检查后目录被替换/写入”导致覆盖
    if (validated.value.existing) {
      const entries = await this.deps.fs.listDirectory(target).catch(() => null);
      if (entries === null) {
        return fail("E_PERMISSION", `无法读取目标目录：${target}`);
      }
      if (entries.length > 0) {
        return fail("E_TARGET_EXISTS", "目标目录在确认后变为非空，已停止安装；请换一个空目录");
      }
      try {
        await this.deps.fs.removeTree(target);
      } catch (error) {
        return fail("E_PERMISSION", `无法清理空目录：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // staging 必须与目标同卷，避免跨盘 rename 不是原子操作
    const stagingDirectory = path.join(path.dirname(target), `.wb-staging-${Date.now().toString(36)}`);
    const guard = new PathGuard({
      managementRoot: this.settings.managementRoot,
      externalRoots: [target, stagingDirectory],
    });

    const archive = this.archivePort();
    if (!archive.ok) return archive;

    const operationId = `${input.operationPrefix ?? "install"}-${product}-${Date.now().toString(36)}`;
    const deployed = await deployPackage(
      {
        product,
        version,
        packagePath: check.file,
        packageCheck: check,
        operationId,
        stagingDirectory,
        targetDirectory: target,
        backupDirectory: backupsDirectory(this.settings.managementRoot, product),
      },
      {
        fs: this.deps.fs,
        tree: this.deps.fs,
        guard,
        archive: archive.value,
        journal: this.deps.journal,
        now: this.deps.now,
        verifyInstalled: async (directory, expected) => {
          const verified = await this.verifyDeployed(directory, expected);
          return verified.ok ? { ok: true } : { ok: false, reason: verified.reason };
        },
        progress: (phase, percent) => this.deps.emit?.({ operationId, product, phase, percent }),
      },
    );
    if (!deployed.ok) {
      await this.logFailure({
        operation: "install",
        product,
        instanceId: null,
        stage: "deploy",
        code: deployed.error.code,
        message: deployed.error.message,
        stagingDirectory,
        rolledBack: true,
        detail: { version, target },
      });
      return deployed;
    }

    const executableRelativePath = await this.detectExecutable(target, product);
    const previousActive = this.instances.find((item) => item.product === product && item.active) ?? null;
    const instance: ManagedInstance = {
      instanceId: this.instanceId(product, version, target),
      product,
      version,
      directory: target,
      origin: "deployed",
      active: previousActive === null,
      source: input.source ?? "local-file",
      packageFile: check.file,
      packageSha256: check.sha256,
      packageFormat: await this.detectPackageFormat(check.file),
      signerSubject: check.authenticode?.signerSubject ?? null,
      signerThumbprint: check.authenticode?.signerThumbprint ?? null,
      installedAt: this.deps.now(),
      operationId,
      verified: true,
      executableRelativePath,
    };
    this.instances = [...this.instances, instance];
    try {
      await this.saveInstances();
    } catch (error) {
      // 登记失败必须回滚，不能留下“文件已安装但管理器不可见”的孤儿目录
      this.instances = this.instances.filter((item) => item.instanceId !== instance.instanceId);
      try {
        await this.deps.fs.removeTree(target);
      } catch {
        // 回滚失败：保留目录并如实报错
      }
      await this.logFailure({
        operation: "install",
        product,
        instanceId: instance.instanceId,
        stage: "register-instance",
        code: "E_IO",
        message: `写入实例登记失败：${error instanceof Error ? error.message : String(error)}`,
        stagingDirectory,
        rolledBack: true,
        detail: { target },
      });
      return fail("E_IO", `安装已回滚：写入实例登记失败（${error instanceof Error ? error.message : "未知错误"}）`);
    }
    await this.scan();

    // 安装已提交：快捷方式失败只提示，不回滚
    const currentInstance = this.instances.find((item) => item.instanceId === instance.instanceId) ?? instance;
    const shortcut = await this.ensureShortcut(currentInstance);

    return ok({
      instance: this.instances.find((item) => item.instanceId === instance.instanceId) ?? instance,
      operationId,
      previousActiveInstanceId: previousActive?.instanceId ?? null,
      notes: [
        ...check.reasons,
        `目标目录：${target}`,
        "只解包并部署官方安装包内的文件，未执行官方安装器，也未修改安装包",
        shortcut.note,
      ],
    });
  }

  /** 更新：把新版本并排部署，成功后切换默认实例，旧版本保留为回滚点。 */
  /**
   * 更新：把新版本真正替换到**用户选定的那个实例目录**。
   * 不是部署到别的目录后让原实例保持旧版本。失败会回滚并如实报告。
   */
  async updateInstance(input: {
    product: ProductId;
    instanceId: string;
    packagePath: string;
  }): Promise<Result<DeployOutcome>> {
    const current = this.instances.find(
      (item) => item.product === input.product && item.instanceId === input.instanceId,
    );
    if (!current) {
      return fail("E_TARGET_NOT_MANAGED", "该实例不在跟踪列表中，无法更新");
    }
    if (!(await this.deps.fs.exists(current.directory))) {
      return fail("E_NOT_FOUND", "该实例的安装目录已不存在，请先重新扫描或清理登记");
    }

    const inspected = await this.inspectPackage(input.packagePath, input.product);
    if (!inspected.ok) return inspected;
    const check = inspected.value;

    // 签名与信任基线只用于诊断：不阻断更新
    const nextVersion = this.normalizeVersion(check.productVersion) ??
      this.normalizeVersion(path.basename(check.file)) ?? "unknown";
    const order = nextVersion === "unknown" || current.version === "unknown"
      ? 1
      : nextVersion.localeCompare(current.version, undefined, { numeric: true });
    if (nextVersion === current.version) {
      return fail("E_CONFLICT", `安装包版本与当前实例相同（${current.version}），无需更新`);
    }
    if (order < 0) {
      return fail("E_CONFLICT", `安装包版本 ${nextVersion} 低于当前实例 ${current.version}，降级需单独处理`);
    }

    // 只读检测目标进程：运行中不覆盖文件，也不强杀
    const running = await this.runningExecutables();
    const busy = running.find((item) => this.insideDirectory(item, current.directory));
    if (busy) {
      return fail("E_BUSY", "目标客户端正在运行，请先正常退出后再重试更新");
    }

    const guard = new PathGuard({
      managementRoot: this.settings.managementRoot,
      // 已接管实例位于管理根之外：只放行它自己的目录
      externalRoots: [current.directory],
    });
    const archive = this.archivePort();
    if (!archive.ok) return archive;

    const operationId = `update-${input.product}-${Date.now().toString(36)}`;
    const before = new Map(this.instances.map((item) => [item.instanceId, `${item.version}|${item.directory}`]));

    const replaced = await replaceInstanceInPlace(
      {
        operationId,
        product: input.product,
        version: nextVersion,
        packagePath: check.file,
        packageCheck: check,
        targetDirectory: current.directory,
        stagingDirectory: path.join(this.settings.managementRoot, ".staging", operationId),
        backupDirectory: backupsDirectory(this.settings.managementRoot, input.product),
      },
      {
        fs: this.deps.fs,
        tree: this.deps.fs,
        guard,
        archive: archive.value,
        journal: this.deps.journal,
        now: this.deps.now,
        verifyInstalled: async (directory, expected) => {
          const verified = await this.verifyDeployed(directory, expected);
          return verified.ok ? { ok: true } : { ok: false, reason: verified.reason };
        },
        progress: (phase, percent) => this.deps.emit?.({ operationId, product: input.product, phase, percent }),
      },
    );
    if (!replaced.ok) return replaced;

    const executableRelativePath = await this.detectExecutable(current.directory, input.product);
    const packageFormat = await this.detectPackageFormat(check.file);
    this.instances = this.instances.map((item) =>
      item.instanceId === current.instanceId
        ? {
            ...item,
            version: nextVersion,
            verified: true,
            installedAt: this.deps.now(),
            operationId,
            packageFile: check.file,
            packageSha256: check.sha256,
            packageFormat,
            signerSubject: check.authenticode?.signerSubject ?? item.signerSubject,
            signerThumbprint: check.authenticode?.signerThumbprint ?? item.signerThumbprint,
            executableRelativePath: executableRelativePath ?? item.executableRelativePath,
          }
        : item,
    );
    await this.saveInstances();

    // 复扫并核对：目标实例应变成新版本，其他实例（同产品其他副本 / 另一产品）不得变化
    await this.scan();
    const changed: string[] = [];
    for (const item of this.instances) {
      if (item.instanceId === current.instanceId) continue;
      const beforeValue = before.get(item.instanceId);
      const afterValue = `${item.version}|${item.directory}`;
      if (beforeValue !== afterValue) changed.push(`${item.instanceId}（${beforeValue ?? "新增"} → ${afterValue}）`);
    }

    return ok({
      instance: this.instances.find((item) => item.instanceId === current.instanceId)!,
      operationId,
      previousActiveInstanceId: null,
      notes: [
        `已在原路径更新：${current.directory}（${current.version} → ${nextVersion}）`,
        `更新前备份：${replaced.value.backupDirectory}`,
        `旧版本目录：${replaced.value.retiredDirectory}（可手动恢复）`,
        replaced.value.preservedFiles.length > 0
          ? `已保留安装维护文件：${replaced.value.preservedFiles.join("、")}`
          : "新版本已包含全部文件（无需保留旧维护文件）",
        changed.length === 0 ? "其他实例（同产品其它副本 / 另一产品）未发生变化" : `注意：检测到其他实例变化：${changed.join("；")}`,
        "未执行官方安装器，未写入注册表/快捷方式；官方更新器是否认可需你自行确认",
      ],
    });
  }

  /** 只读列出正在运行的可执行文件路径 */
  private async runningExecutables(): Promise<string[]> {
    const provider = this.deps.processes ?? new WindowsProcessReader();
    try {
      const list = await provider.list();
      return list.map((item) => item.path).filter((item) => typeof item === "string" && item !== "");
    } catch {
      return [];
    }
  }

  /** 打开产品官网（URL 由主进程查表，渲染进程无法注入） */
  async openOfficialSite(product: ProductId): Promise<Result<{ url: string }>> {
    const site = OFFICIAL_SITES[product];
    if (!site) return fail("E_VALIDATION", "未知产品，未配置官网入口");
    if (!this.deps.openExternal) return fail("E_INTERNAL", "当前环境不支持打开浏览器");
    try {
      await this.deps.openExternal(site.url);
      return ok({ url: site.url });
    } catch (error) {
      return fail("E_INTERNAL", `打开官网失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }


  /**
   * 打开顶栏赞助商站点。目标地址硬编码在主进程常量里，
   * 不接受任何入参——renderer 无法替换域名、协议或路径。
   */
  async openSponsorSite(): Promise<Result<{ url: string }>> {
    if (!this.deps.openExternal) return fail("E_INTERNAL", "当前环境不支持打开浏览器");
    try {
      await this.deps.openExternal(SPONSOR_SITE.url);
      return ok({ url: SPONSOR_SITE.url });
    } catch (error) {
      return fail("E_INTERNAL", `打开赞助商链接失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  /**
   * 卸载已接管的官方安装：只调用**与该实例目录精确匹配的官方卸载器**。
   * 不递归删除目录、不执行未验证命令、不碰用户数据。
   */
  private async uninstallAdopted(target: ManagedInstance): Promise<Result<UninstallOutcome>> {
    const registry = await this.deps.registry.readUninstallEntries();
    const env = this.deps.env ?? process.env;
    const matches: { executable: string; args: string[]; key: string }[] = [];
    for (const entry of registry.entries) {
      const command = entry.values["UninstallString"] ?? entry.values["QuietUninstallString"] ?? null;
      if (!command) continue;
      const parsed = parseUninstallInvocation(command, env);
      if (!parsed.ok) continue;
      if (!this.insideDirectory(parsed.value.executable, target.directory)) continue;
      matches.push({ executable: parsed.value.executable, args: parsed.value.args, key: entry.key });
    }

    // 独立复制出来的官方安装目录可能没有自己的卸载注册表项。
    // 此时仅接受目录内名称符合该版本的卸载器，并在启动前检查产品元数据。
    if (matches.length === 0 && (await this.deps.fs.exists(target.directory))) {
      const expectedName = target.product === "workbuddy-cn" ? /^Uninstall WorkBuddy\.exe$/i : /^Uninstall WorkBuddyAI\.exe$/i;
      const local = (await this.deps.fs.listDirectory(target.directory))
        .filter((name) => expectedName.test(name))
        .map((name) => path.join(target.directory, name));
      if (local.length === 1 && (await this.deps.fs.isFile(local[0]!))) {
        const localInfo = await this.inspect(local[0]!);
        const localProduct = (localInfo.versionInfo?.productName ?? localInfo.versionInfo?.fileDescription ?? "").trim().toLowerCase();
        const productMatches = target.product === "workbuddy-cn"
          ? localProduct === "workbuddy"
          : localProduct === "workbuddy ai" || localProduct === "workbuddyai";
        if (productMatches) matches.push({ executable: local[0]!, args: [], key: "verified-local-uninstaller" });
      }
    }

    if (matches.length === 0) {
      return fail(
        "E_NOT_FOUND",
        "找不到与该实例目录和产品匹配的官方卸载程序；请从 Windows「设置 → 应用」手动卸载",
      );
    }
    if (matches.length > 1) {
      return fail("E_CONFLICT", `有 ${matches.length} 条卸载登记指向该目录，无法确定唯一官方卸载器，已停止`, {
        keys: matches.map((item) => item.key).slice(0, 5),
      });
    }

    const invocation = matches[0]!;
    if (!(await this.deps.fs.isFile(invocation.executable))) {
      return fail("E_NOT_FOUND", "官方卸载程序文件不存在（可能已被删除）");
    }
    const info = await this.inspect(invocation.executable);
    // 签名只记录不阻断；真正决定能否执行的是：登记精确匹配该目录 + 文件位于该目录内 + 产品标识匹配
    const productName = info.versionInfo?.productName ?? info.versionInfo?.fileDescription ?? "";
    if (!/workbuddy/i.test(productName)) {
      return fail("E_IDENTITY_MISMATCH", `卸载程序的产品标识为「${productName || "未知"}」，与所选产品不匹配`);
    }
    if (!this.insideDirectory(invocation.executable, target.directory)) {
      return fail("E_IDENTITY_MISMATCH", "卸载程序不在该实例目录内，已拒绝执行");
    }

    const operationId = `uninstall-${target.product}-${Date.now().toString(36)}`;
    this.deps.emit?.({ operationId, product: target.product, phase: "等待官方卸载器完成", percent: 10 });
    const runner = this.deps.execRunner;
    let exitInfo: { exitCode: number | null; timedOut: boolean };
    if (runner) {
      exitInfo = await runner(invocation.executable, invocation.args, 300_000);
    } else {
      const finished = await this.runAndWait(invocation.executable, invocation.args, 300_000);
      if (!finished.ok) return finished;
      exitInfo = finished.value;
    }

    // 官方卸载器可能留下空目录或维护残留文件；用客户端主程序是否还在判定卸载结果。
    this.deps.emit?.({ operationId, product: target.product, phase: "确认卸载结果", percent: 70 });
    const deadline = Date.now() + (this.deps.uninstallPollMs ?? 60_000);
    let executableRemoved = false;
    while (Date.now() < deadline) {
      if (!(await this.detectExecutable(target.directory, target.product))) {
        executableRemoved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (!executableRemoved) {
      await this.logFailure({
        operation: "uninstall",
        product: target.product,
        instanceId: target.instanceId,
        stage: "wait-official-uninstaller",
        code: "E_BUSY",
        message: "官方卸载器已退出，但客户端主程序仍然存在",
        rolledBack: false,
        detail: { directory: target.directory, exitCode: exitInfo.exitCode },
      });
      return fail(
        "E_BUSY",
        "官方卸载器已退出，但客户端主程序仍然存在：可能取消、需要重启或卸载未完成。已保留实例，可重试",
        { directory: target.directory, exitCode: exitInfo.exitCode },
      );
    }

    const directoryRemains = await this.deps.fs.exists(target.directory);
    const adoptedShortcutNote = await this.removeShortcut(target);
    this.instances = this.instances.filter((item) => item.instanceId !== target.instanceId);
    if (target.active) {
      const remaining = this.instances
        .filter((item) => item.product === target.product)
        .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
      if (remaining[0]) {
        this.instances = this.instances.map((item) =>
          item.instanceId === remaining[0]!.instanceId ? { ...item, active: true } : item,
        );
      }
    }
    await this.saveInstances();
    await this.scan();

    return ok({
      instanceId: target.instanceId,
      product: target.product,
      directory: target.directory,
      removed: true,
      userDataRetained: [],
      operationId,
      notes: [
        `官方卸载器：${invocation.executable}`,
        `参数：${invocation.args.join(" ") || "（无）"}`,
        "已确认原安装目录消失；用户数据（账号/配置/聊天/登录态）未由本工具删除",
        "官方卸载器是否保留了这些数据取决于它自身，本工具未验证",
        ...(directoryRemains ? ["客户端已卸载；安装目录仍有残留文件，已从主界面移除该实例，但未擅自删除残留目录"] : []),
        adoptedShortcutNote ?? "该实例没有本工具创建的桌面快捷方式",
      ],
    });
  }

  /** 启动一个程序并等待退出（带超时，不强杀） */
  private async runAndWait(
    file: string,
    args: string[],
    timeoutMs: number,
  ): Promise<Result<{ exitCode: number | null; timedOut: boolean }>> {
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(file, args, { windowsHide: false, stdio: "ignore" });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(ok({ exitCode: null, timedOut: true }));
      }, timeoutMs);
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fail("E_IO", `无法启动程序：${error.message}`));
      });
      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok({ exitCode: code, timedOut: false }));
      });
    });
  }

  /** 卸载：仅删除本工具部署的程序目录，用户数据默认保留。 */
  async uninstallInstance(input: { product: ProductId; instanceId: string }): Promise<Result<UninstallOutcome>> {
    const target = this.instances.find(
      (item) => item.product === input.product && item.instanceId === input.instanceId,
    );
    if (!target) {
      return fail("E_TARGET_NOT_MANAGED", "只能卸载本工具部署的安装实例；扫描发现的安装请用官方卸载程序");
    }
    if (target.origin === "external") {
      // 已接管的官方安装：调用与该目录精确匹配的官方卸载器，不做递归目录删除
      return this.uninstallAdopted(target);
    }
    const guard = new PathGuard({
      managementRoot: this.settings.managementRoot,
      // 用户自选安装目录可能位于管理根之外：只放行该实例自己的目录
      externalRoots: [target.directory],
    });
    const operationId = `uninstall-${input.product}-${Date.now().toString(36)}`;
    const removed = await removeManagedDirectory(
      {
        product: input.product,
        directory: target.directory,
        backupDirectory: backupsDirectory(this.settings.managementRoot, input.product),
        operationId,
      },
      {
        fs: this.deps.fs,
        tree: this.deps.fs,
        guard,
        journal: this.deps.journal,
        now: this.deps.now,
        verifyInstalled: async (directory, expected) => {
          const verified = await this.verifyDeployed(directory, expected);
          return verified.ok ? { ok: true } : { ok: false, reason: verified.reason };
        },
        progress: (phase, percent) => this.deps.emit?.({ operationId, product: input.product, phase, percent }),
      },
    );
    if (!removed.ok) {
      await this.logFailure({
        operation: "uninstall",
        product: input.product,
        instanceId: target.instanceId,
        stage: "remove-directory",
        code: removed.error.code,
        message: removed.error.message,
        stagingDirectory: path.join(this.settings.managementRoot, ".staging", operationId),
        rolledBack: true,
        detail: { directory: target.directory },
      });
      return removed;
    }

    const shortcutNote = await this.removeShortcut(target);
    this.instances = this.instances.filter((item) => item.instanceId !== target.instanceId);
    if (target.active) {
      const remaining = this.instances
        .filter((item) => item.product === input.product)
        .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
      if (remaining[0]) {
        this.instances = this.instances.map((item) =>
          item.instanceId === remaining[0]!.instanceId ? { ...item, active: true } : item,
        );
      }
    }
    await this.saveInstances();
    await this.scan();

    return ok({
      instanceId: target.instanceId,
      product: input.product,
      directory: target.directory,
      removed: true,
      userDataRetained: [],
      operationId,
      notes: [
        "只删除本工具部署的程序目录；用户数据目录（%APPDATA% / 聊天记录 / 登录态）从未被访问",
        "删除前已生成程序目录备份，可在备份目录回滚",
        shortcutNote ?? "该实例没有本工具创建的桌面快捷方式",
      ],
    });
  }

  /** 启动指定实例（不传实例时用该产品的默认实例）。 */
  async launchInstance(input: { product: ProductId; instanceId?: string | null }): Promise<Result<true>> {
    const candidates = this.instances.filter((item) => item.product === input.product);
    const target = input.instanceId
      ? candidates.find((item) => item.instanceId === input.instanceId)
      : candidates.find((item) => item.active) ?? candidates[0];
    if (!target) return fail("E_TARGET_NOT_MANAGED", "没有本工具部署的实例可启动；扫描发现的安装请自行启动");

    const relative = target.executableRelativePath ?? (await this.detectExecutable(target.directory, input.product));
    if (!relative) return fail("E_NOT_FOUND", "该实例没有可执行文件");
    const executable = path.join(target.directory, relative);
    if (!(await this.deps.fs.isFile(executable))) return fail("E_NOT_FOUND", "可执行文件不存在");

    // 签名只用于诊断：实例来自用户选择的包，不因签名状态阻止启动
    const child = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return ok(true);
  }

  private insideDirectory(file: string, directory: string): boolean {
    const normalize = (value: string) => path.resolve(value).toLowerCase().replace(/[\\/]+$/, "");
    const target = normalize(file);
    const root = normalize(directory);
    return target === root || target.startsWith(`${root}${path.sep}`);
  }

  lastAssistedResult(): AssistedResult | null {
    return this.lastAssisted;
  }

  async updateSettings(patch: Partial<Settings>): Promise<Result<Settings>> {
    if (patch.managementRoot !== undefined) {
      const guard = new PathGuard({ managementRoot: patch.managementRoot });
      const check = guard.check(path.join(patch.managementRoot, "probe"));
      if (!check.ok) return fail("E_PATH_REJECTED", `管理根目录不可用：${check.error.message}`);
      this.settings.managementRoot = path.resolve(patch.managementRoot);
    }
    if (patch.userScanRoots !== undefined) {
      this.settings.userScanRoots = patch.userScanRoots.filter((p) => path.isAbsolute(p));
    }
    // 自动安装/下载默认关闭；开启自动安装需要显式能力门通过
    this.settings.autoCheckUpdates = patch.autoCheckUpdates === true;
    this.settings.autoDownload = patch.autoDownload === true && this.capability.updateAutomation;
    this.settings.autoInstall = patch.autoInstall === true && this.capability.updateAutomation;
    await this.deps.fs.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2));
    return ok(this.settings);
  }

  async getSettings(): Promise<Settings> {
    return this.settings;
  }

  /* ---------------------------------------------------------------- 只读扫描 */

  async scan(): Promise<Result<ScanReport>> {
    const managed = await this.readManagedInstallations();
    const context = {
      profiles: this.profiles,
      userRoots: this.settings.userScanRoots,
      managed,
      selfDirectories: this.deps.selfDirectories,
      temporaryDirectory: tmpdir(),
    };
    const report = this.deps.scanImplementation
      ? await this.deps.scanImplementation(context)
      : await scanInstallations({
          deps: {
            registry: this.deps.registry,
            probe: this.deps.fs,
            listDirectory: (dir) => this.deps.fs.listDirectory(dir),
            isReparsePoint: (target) => this.deps.fs.isReparsePoint(target),
            existsPath: (target) => this.deps.fs.exists(target),
            shortcuts: new WindowsShortcutReader(),
            processes: new WindowsProcessReader(),
            commonLocations: new WindowsCommonLocationReader(),
          },
          profiles: this.profiles,
          userRoots: this.settings.userScanRoots,
          managed,
          selfDirectories: this.deps.selfDirectories,
          temporaryDirectory: tmpdir(),
        });
    this.scanResult = report;
    await this.autoTrackFromScan(report);
    this.updates = this.updates.map((update) => {
      const record = report.records.find((r) => r.product === update.product && r.identity === "identified");
      return { ...update, currentVersion: record?.displayVersion ?? record?.identityCheck?.observedVersion ?? null };
    });
    return ok(report);
  }

  /** 扫描即自动登记：只写管理器状态，不触碰客户端文件 */
  private async autoTrackFromScan(report: ScanReport): Promise<void> {
    const decisions: AutoTrackDecision[] = [];
    for (const discovery of report.products) {
      for (const record of discovery.installs) {
        try {
          decisions.push(await evaluateAutoTrack(record, this.autoTrackProbe()));
        } catch (error) {
          // 单条记录校验失败不能中断整次扫描
          decisions.push({
            recordId: record.id,
            product: record.product ?? discovery.product,
            directory: record.installLocation ?? "",
            version: record.displayVersion ?? null,
            executableRelativePath: null,
            signerSubject: null,
            signerThumbprint: null,
            eligible: false,
            blockers: [`自动登记校验异常：${error instanceof Error ? error.message : "未知错误"}`],
          });
        }
      }
    }
    this.autoTrackDecisions = decisions;

    const merged = mergeAutoTrackedInstances({
      decisions,
      previous: this.instances,
      report,
      now: this.deps.now,
    });
    const before = JSON.stringify(this.instances);
    const after = JSON.stringify(merged);
    if (before !== after) {
      this.instances = merged;
      await this.saveInstances();
    }
    // 本轮没有线索、但登记过的既有目录：做一次补偿校验（客户端没运行时扫描会漏掉它）
    await this.revalidateKnownExternal(decisions);
  }

  private async revalidateKnownExternal(decisions: AutoTrackDecision[]): Promise<void> {
    const covered = new Set(decisions.map((item) => toCompareKey(item.directory)));
    let changed = false;
    const next: ManagedInstance[] = [];
    for (const item of this.instances) {
      if (item.origin === "external" && isTemporaryOperationPath(item.directory, tmpdir())) {
        // 更新/解包临时副本不属于用户安装；只清除管理器登记，不删除磁盘文件。
        changed = true;
        continue;
      }
      if (item.origin !== "external" || covered.has(toCompareKey(item.directory))) {
        next.push(item);
        continue;
      }
      if (!(await this.deps.fs.exists(item.directory))) {
        // 目录已不存在，属于过期的外部安装登记，不应继续占据主界面。
        changed = true;
        continue;
      }
      const expectedExecutable = this.profileOf(item.product).executableRelativePath;
      const executable = expectedExecutable && (await this.deps.fs.isFile(path.join(item.directory, expectedExecutable)))
        ? expectedExecutable
        : null;
      if (!executable) {
        // 只剩卸载器、修复器等残余文件时，客户端实例已不存在。
        changed = true;
        continue;
      }
      const signature = await this.inspect(`${item.directory.replace(/[\\/]+$/, "")}\\${executable}`);
      const valid = signature.authenticode?.status === "Valid";
      const updated: ManagedInstance = {
        ...item,
        executableRelativePath: executable,
        signerSubject: signature.authenticode?.signerSubject ?? item.signerSubject,
        signerThumbprint: signature.authenticode?.signerThumbprint ?? item.signerThumbprint,
        verified: valid,
      };
      if (JSON.stringify(updated) !== JSON.stringify(item)) changed = true;
      next.push(updated);
    }
    let normalized = next;
    for (const product of PRODUCT_IDS) {
      const group = normalized.filter((item) => item.product === product);
      if (group.length > 0 && !group.some((item) => item.active)) {
        const preferred = [...group].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]!;
        normalized = normalized.map((item) => item.instanceId === preferred.instanceId ? { ...item, active: true } : item);
        changed = true;
      }
    }
    if (changed || JSON.stringify(normalized) !== JSON.stringify(this.instances)) {
      this.instances = normalized;
      await this.saveInstances();
    }
  }

  private autoTrackProbe(): AutoTrackProbe {
    return {
      directoryExists: async (dir) => {
        const stat = await this.deps.fs.stat(dir);
        return stat?.isDirectory ?? false;
      },
      isReparsePoint: (target) => this.deps.fs.isReparsePoint(target),
      findExecutable: (dir, product) => this.detectExecutable(dir, product),
      signatureStatus: async (executable) => {
        const info = await this.inspect(executable);
        const status =
          info.authenticode?.status === "Valid" ? "Valid" : info.authenticode ? "Invalid" : "Unknown";
        return {
          status,
          subject: info.authenticode?.signerSubject ?? null,
          thumbprint: info.authenticode?.signerThumbprint ?? null,
        };
      },
    };
  }

  private async readManagedInstallations(): Promise<ManagedInstallation[]> {
    const text = await this.deps.fs.readText(this.installationsFile);
    if (!text) return [];
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) return [];
      const guard = new PathGuard({ managementRoot: this.settings.managementRoot });
      return parsed.filter((item): item is ManagedInstallation => {
        if (typeof item !== "object" || item === null) return false;
        const record = item as Record<string, unknown>;
        if (record["product"] !== "workbuddy-cn" && record["product"] !== "workbuddy-ai") return false;
        if (typeof record["directory"] !== "string" || typeof record["version"] !== "string") return false;
        return guard.check(record["directory"]).ok;
      });
    } catch {
      return [];
    }
  }

  /* ---------------------------------------------------------------- 包校验 */

  async inspectPackage(file: string, product: ProductId): Promise<Result<PackageCheck>> {
    if (!path.isAbsolute(file)) return fail("E_VALIDATION", "必须提供绝对路径");
    if (!(await this.deps.fs.isFile(file))) return fail("E_NOT_FOUND", "安装包文件不存在或不可读");
    if (!file.toLowerCase().endsWith(".exe")) return fail("E_VALIDATION", "MVP 只接受官方 .exe 安装包");

    const profile = this.profileOf(product);
    const counterpart = this.profiles.find((p) => p.product !== product) ?? null;
    const stat = await this.deps.fs.stat(file);
    const size = stat?.size ?? 0;
    if (size === 0) return fail("E_VALIDATION", "安装包为空文件");
    if (size > 1024 * 1024 * 1024) return fail("E_VALIDATION", "安装包体积异常（超过 1GB）");

    const { createHash } = await import("node:crypto");
    // 官方包可达 500MB，必须流式哈希，不能整包读进内存
    const sha256 = await new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(file);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
    const info = await this.inspect(file);

    const check = await verifyPackage(
      { file, expected: product, profile, counterpart, expectedSha256: null },
      {
        sha256: async () => sha256,
        size: async () => size,
        authenticode: async () => info.authenticode,
        versionInfo: async () => info.versionInfo,
      },
    );
    this.packageCache.set(product, check);
    return ok(check);
  }

  private profileOf(product: ProductId): ProductProfile {
    const profile = this.profiles.find((p) => p.product === product);
    if (!profile) throw new Error(`缺少产品 profile: ${product}`);
    return profile;
  }

  /* ---------------------------------------------------------------- 预演 */

  async preview(kind: OperationKind, selections: InstallSelection[]): Promise<Result<{ plans: PreviewBundle[]; blocked: string[] }>> {
    const chosen = selections.filter((s) => s.selected);
    if (chosen.length === 0) return fail("E_VALIDATION", "至少需要勾选一个产品");
    const plans: PreviewBundle[] = [];
    const blocked: string[] = [];

    for (const selection of chosen) {
      const operationId = `op-${kind}-${selection.product}-${Date.now().toString(36)}`;
      const built = buildPlan({
        operationId,
        kind,
        selection,
        profile: this.profileOf(selection.product),
        capability: this.capability,
        managementRoot: this.settings.managementRoot,
        packageCheck: this.packageCache.get(selection.product) ?? null,
        scan: this.scanResult,
        stagingDirectory: path.join(this.settings.managementRoot, ".staging", operationId),
        now: this.deps.now(),
      });
      if (!built.ok) {
        blocked.push(`${PRODUCT_LABELS[selection.product]}：${built.error.message}`);
        continue;
      }
      if (built.value.blockers.length > 0) {
        blocked.push(...built.value.blockers.map((b) => `${PRODUCT_LABELS[selection.product]}：${b}`));
      }
      plans.push({ plan: built.value, text: renderPlanText(built.value) });
    }
    return ok({ plans, blocked });
  }

  /* ---------------------------------------------------------------- 执行 */

  async start(kind: OperationKind, selections: InstallSelection[]): Promise<Result<OperationResult[]>> {
    const chosen = selections.filter((s) => s.selected);
    if (chosen.length === 0) return fail("E_VALIDATION", "至少需要勾选一个产品");

    const gateError = this.checkCapability(kind);
    if (gateError) return gateError;

    const preview = await this.preview(kind, chosen);
    if (!preview.ok) return preview;
    if (preview.value.blocked.length > 0) {
      return fail("E_CAPABILITY_BLOCKED", "预演存在阻断项，禁止执行", { blockers: preview.value.blocked });
    }

    const results: OperationResult[] = [];
    const guard = new PathGuard({ managementRoot: this.settings.managementRoot });
    const transaction = new FileTransaction({
      journal: this.deps.journal,
      guard,
      fs: this.deps.fs,
      now: this.deps.now,
      verifyInstalled: async (directory, product) => {
        const profile = this.profileOf(product);
        const counterpart = product === "workbuddy-cn" ? "workbuddy-ai" : "workbuddy-cn";
        const identity = await verifyProductIdentity({ root: directory, expected: product, profile, counterpart, probe: this.deps.fs });
        return identity.verdict === "match" ? { ok: true } : { ok: false, reason: identity.reasons.join("；") || "身份不符" };
      },
    });

    for (const item of preview.value.plans) {
      const controller = new AbortController();
      this.aborts.set(item.plan.operationId, controller);
      this.deps.emit?.({
        operationId: item.plan.operationId,
        product: item.plan.product,
        phase: "开始执行（暂存 → 校验 → 提交）",
        percent: 5,
      });
      try {
        const result = await transaction.apply(item.plan, controller.signal);
        if (result.ok) {
          results.push(result.value);
          this.deps.emit?.({ operationId: item.plan.operationId, product: item.plan.product, phase: "已完成", percent: 100 });
        } else {
          results.push({
            operationId: item.plan.operationId,
            state: "failed",
            completedSteps: 0,
            failure: result.error,
            notes: [],
          });
          this.deps.emit?.({
            operationId: item.plan.operationId,
            product: item.plan.product,
            phase: `失败：${result.error.message}`,
            percent: 100,
          });
        }
      } finally {
        this.aborts.delete(item.plan.operationId);
      }
    }
    return ok(results);
  }

  /**
   * 证据门不再阻断安装/更新/卸载：真实操作由产品身份、包签名、应用树完整性和
   * 实例级检查保证。这里保留方法以便诊断展示，但恒返回“无阻断”。
   */
  private checkCapability(kind: OperationKind): Result<never> | null {
    void kind;
    return null;
  }

  async cancel(operationId: string): Promise<Result<true>> {
    const controller = this.aborts.get(operationId);
    if (!controller) return fail("E_NOT_FOUND", "该操作不在运行中");
    controller.abort();
    return ok(true);
  }

  async rollback(operationId: string): Promise<Result<OperationResult>> {
    const guard = new PathGuard({ managementRoot: this.settings.managementRoot });
    const transaction = new FileTransaction({
      journal: this.deps.journal,
      guard,
      fs: this.deps.fs,
      now: this.deps.now,
    });
    return transaction.rollback(operationId);
  }

  async listOperations() {
    return this.deps.journal.list();
  }

  /* ---------------------------------------------------------------- 更新检查 */

  async checkUpdates(product: ProductId): Promise<Result<UpdateStatus>> {
    const source = new HttpReleaseSource({
      config: this.releaseConfig,
      fetch: (url, init) => fetch(url, init) as unknown as Promise<never>,
      now: this.deps.now,
    });
    const releases = await source.listVerifiedReleases(product);
    const current = this.scanResult?.records.find((r) => r.product === product && r.identity === "identified");
    const currentVersion = current?.displayVersion ?? current?.identityCheck?.observedVersion ?? null;
    let status: UpdateStatus;
    if (!releases.ok) {
      status = {
        product,
        checkedAt: this.deps.now(),
        currentVersion,
        latestVersion: null,
        state: "unavailable",
        reason: releases.error.message,
      };
    } else if (releases.value.length === 0) {
      status = {
        product,
        checkedAt: this.deps.now(),
        currentVersion,
        latestVersion: null,
        state: "unavailable",
        reason: "没有来自已核验来源的可用版本",
      };
    } else {
      const latest = releases.value
        .map((r) => r.version)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]!;
      status = {
        product,
        checkedAt: this.deps.now(),
        currentVersion,
        latestVersion: latest,
        state: currentVersion && latest === currentVersion ? "up-to-date" : "available",
        reason: null,
      };
    }
    this.updates = this.updates.map((u) => (u.product === product ? status : u));
    return ok(status);
  }

  /* ---------------------------------------------------------------- 启动产品 */

  async launchProduct(product: ProductId): Promise<Result<true>> {
    const record = this.verifiedRecord(product);
    if (!record) return fail("E_IDENTITY_UNKNOWN", "没有已核验的安装，无法启动");
    const profile = this.profileOf(product);
    if (!profile.executableRelativePath || !record.installLocation) {
      return fail("E_CAPABILITY_BLOCKED", "缺少证据支持的可执行文件相对路径，无法安全启动");
    }
    const executable = path.join(record.installLocation, profile.executableRelativePath);
    if (!(await this.deps.fs.isFile(executable))) return fail("E_NOT_FOUND", "未找到产品可执行文件");
    const child = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return ok(true);
  }

  private verifiedRecord(product: ProductId): InstallRecord | null {
    const record = this.scanResult?.records.find((r) => r.product === product && r.identity === "identified");
    return record ?? null;
  }

  /* ---------------------------------------------------------------- 证据导入 */

  async exportDiagnostics(destinationDirectory: string): Promise<Result<string>> {
    if (!path.isAbsolute(destinationDirectory)) return fail("E_VALIDATION", "必须提供绝对路径");

    const exportStartedAt = this.deps.now();
    const startedMs = Date.parse(exportStartedAt);

    // 导出前必须重新扫描：报告的时间必须是本次扫描时间，不能沿用旧缓存
    let scanStatus: ScanStatus;
    try {
      const scanned = await this.scan();
      const finishedMs = Date.parse(this.deps.now());
      if (scanned.ok) {
        scanStatus = {
          status: "ok",
          startedAt: exportStartedAt,
          scannedAt: scanned.value.scannedAt,
          durationMs: Number.isNaN(finishedMs - startedMs) ? 0 : Math.max(0, finishedMs - startedMs),
          failure: null,
        };
      } else {
        scanStatus = {
          status: "failed",
          startedAt: exportStartedAt,
          scannedAt: null,
          durationMs: Number.isNaN(finishedMs - startedMs) ? 0 : Math.max(0, finishedMs - startedMs),
          failure: { code: scanned.error.code, message: scanned.error.message },
        };
      }
    } catch (error) {
      scanStatus = {
        status: "failed",
        startedAt: exportStartedAt,
        scannedAt: null,
        durationMs: 0,
        failure: {
          code: "E_INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    // 扫描失败时不回退到旧结果：报告里 scan 为空，并带失败原因
    const scan = scanStatus.status === "ok" ? this.scanResult : null;

    // 管理器登记：以 instances.json 为准（内存可能尚未包含外部改动）
    const registered = await this.readInstancesForDiagnostics();
    const managedInstances: ManagedInstanceDiagnostic[] = [];
    for (const instance of registered.instances) {
      const executable = instance.executableRelativePath
        ? path.join(instance.directory, instance.executableRelativePath)
        : null;
      managedInstances.push({
        instanceId: instance.instanceId,
        product: instance.product,
        version: instance.version,
        active: instance.active,
        origin: instance.origin,
        registeredAt: instance.installedAt,
        directory: instance.directory,
        executableRelativePath: instance.executableRelativePath,
        executablePresent: executable ? await this.deps.fs.exists(executable) : false,
      });
    }

    // 事务 journal 与错误日志是两个独立来源，都要读
    let operations: OperationRecord[] = [];
    let journalReadable = true;
    try {
      operations = await this.deps.journal.list();
    } catch {
      journalReadable = false;
    }
    const sortedOperations = [...operations]
      .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
      .slice(0, 20);

    const errorRead = this.deps.errorLog
      ? await this.deps.errorLog.readRecent(20)
      : { entries: [], total: 0, corrupted: 0, readable: true };
    const recentErrors: DiagnosticErrorRecord[] = errorRead.entries.map((entry) => ({
      at: entry.at,
      operation: entry.operation,
      product: entry.product,
      instanceId: entry.instanceId,
      stage: entry.stage,
      code: entry.code,
      message: entry.message,
      rolledBack: entry.rolledBack,
    }));

    const notes: string[] = [];
    if (!journalReadable) notes.push("事务 journal 读取失败，最近操作可能不完整");
    if (!errorRead.readable) notes.push("错误日志目录不可读，最近失败可能不完整");
    if (errorRead.corrupted > 0) notes.push("错误日志中有 " + errorRead.corrupted + " 个文件无法解析，已跳过");
    if (registered.source === "memory") notes.push("实例登记文件不可读，已回退到内存中的实例列表");

    const registryReadable = registered.source === "file";
    const history: HistoryStatus = {
      state: !journalReadable
        ? "journal-unreadable"
        : !errorRead.readable
          ? "error-log-unreadable"
          : !registryReadable
            ? "registry-unreadable"
            : sortedOperations.length === 0 && recentErrors.length === 0
              ? "no-history"
              : "ok",
      journalReadable,
      journalTotal: operations.length,
      errorLogReadable: errorRead.readable,
      errorLogTotal: errorRead.total,
      errorLogCorrupted: errorRead.corrupted,
      notes,
    };

    const text = serializeDiagnostics({
      generatedAt: this.deps.now(),
      exportStartedAt,
      appVersion: this.deps.appVersion,
      buildId: this.deps.buildId ?? "dev",
      buildTime: this.deps.buildTime ?? "dev",
      packaged: this.deps.packaged === true,
      platform: process.platform,
      portable: this.deps.portable,
      deployment: {
        install: this.capability.installAutomation,
        update: this.capability.updateAutomation,
        uninstall: this.capability.uninstallAutomation,
        builtInUpdateControl: this.capability.builtInUpdateControl,
      },
      scan,
      scanStatus,
      managedInstances,
      scanToManaged: correlateScanAndManaged(scan, managedInstances),
      recentOperations: sortedOperations,
      recentErrors,
      history,
      instanceRegistry: {
        source: registered.source,
        readable: registryReadable,
        count: registered.instances.length,
      },
      errorLogDirectory: this.deps.errorLog?.directory ?? null,
      settings: {
        managementRoot: this.settings.managementRoot,
        userScanRoots: this.settings.userScanRoots,
      },
    });

    const target = path.join(destinationDirectory, "workbuddy-diagnostics-" + Date.now() + ".json");
    await this.deps.fs.writeFile(target, text);
    this.lastDiagnostics = target;
    return ok(target);
  }

  /** 诊断用：以 instances.json 为事实来源读取登记实例；读不到时回退内存并标注 */
  private async readInstancesForDiagnostics(): Promise<{
    instances: ManagedInstance[];
    source: "file" | "memory";
  }> {
    // 文件不存在 = 还没有任何登记（不是“不可读”）
    if (!(await this.deps.fs.exists(this.instancesFile))) {
      return { instances: [], source: "file" };
    }
    try {
      const text = await this.deps.fs.readText(this.instancesFile);
      if (text) {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          const instances = parsed.filter((item): item is ManagedInstance => {
            if (typeof item !== "object" || item === null) return false;
            const value = item as Record<string, unknown>;
            return (
              typeof value["instanceId"] === "string" &&
              typeof value["directory"] === "string" &&
              (value["product"] === "workbuddy-cn" || value["product"] === "workbuddy-ai")
            );
          });
          return { instances, source: "file" };
        }
      }
    } catch {
      // 落到内存回退
    }
    return { instances: this.instances, source: "memory" };
  }

  /** 供 UI 显示的“为什么不能自动操作”摘要 */
  explainReadOnly(): string[] {
    const lines: string[] = [];
    if (this.evidence.problem) lines.push(this.evidence.problem);
    lines.push(...this.capability.blockers);
    return [...new Set(lines)];
  }
}

export function recordKey(record: InstallRecord): string {
  return `${record.primarySource}:${toCompareKey(record.installLocation ?? record.id)}`;
}
