/**
 * 共享契约。界面（renderer）与主进程（main）都只能依赖本文件中的类型与 schema。
 * 设计原则：
 *  - 不使用 boolean 成功标志，统一用 Result<T> + 明确的失败分类。
 *  - 所有跨 IPC 的输入都经 zod 严格解析（strip 未知字段 → 拒绝未知关键字段）。
 */

export type ProductId = "workbuddy-cn" | "workbuddy-ai";

export const PRODUCT_IDS: readonly ProductId[] = ["workbuddy-cn", "workbuddy-ai"] as const;

export const PRODUCT_LABELS: Record<ProductId, string> = {
  "workbuddy-cn": "国内版 WorkBuddy",
  "workbuddy-ai": "国际版 WorkBuddy AI",
};

/* ------------------------------------------------------------------ 结果与错误 */

export type FailureCode =
  | "E_VALIDATION"
  | "E_CAPABILITY_BLOCKED"
  | "E_PATH_REJECTED"
  | "E_NOT_FOUND"
  | "E_IDENTITY_UNKNOWN"
  | "E_IDENTITY_MISMATCH"
  | "E_CONFLICT"
  | "E_SIGNATURE_INVALID"
  | "E_SIGNER_UNTRUSTED"
  | "E_HOST_NOT_ALLOWED"
  | "E_REMOTE_SCHEMA"
  | "E_SPACE"
  | "E_PERMISSION"
  | "E_BUSY"
  | "E_CANCELLED"
  | "E_IO"
  | "E_JOURNAL_CORRUPT"
  | "E_ROLLBACK_FAILED"
  | "E_UNSUPPORTED_PLATFORM"
  | "E_PACKAGE_FORMAT"
  | "E_TARGET_NOT_MANAGED"
  | "E_TARGET_EXISTS"
  | "E_INTERNAL";

export interface AppError {
  code: FailureCode;
  message: string;
  /** 已脱敏的补充信息，禁止放入凭据、聊天内容或完整用户目录。 */
  details?: Record<string, unknown>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(code: FailureCode, message: string, details?: Record<string, unknown>): Result<T> => ({
  ok: false,
  error: details ? { code, message, details } : { code, message },
});

/* ------------------------------------------------------------------ 包来源与选择 */

export type PackageSource = { kind: "official" } | { kind: "local-file"; path: string };

export interface InstallSelection {
  product: ProductId;
  selected: boolean;
  source: PackageSource;
  version: string;
  targetDirectory: string;
}

/* ------------------------------------------------------------------ 身份与证据 */

/**
 * 证据可信度。只有 `verified` 才允许参与自动安装/更新/卸载；
 * 未经 Task 2 虚拟机实测的字段一律为 `unverified`。
 */
export type TrustState = "verified" | "unverified" | "expired";

export interface EvidenceRef {
  /** 证据文件相对仓库路径，例如 docs/evidence/vm-2026xxxx.json */
  ref: string;
  /** ISO 时间戳，证据采集时间 */
  capturedAt: string;
  /** 采集环境标识，例如 win11-23h2-x64-vm01 */
  environment: string;
}

export interface IdentityFieldEvidence {
  field: string;
  expected: string;
  observed: string;
  /** 该字段在证据中的可信状态 */
  trust: TrustState;
}

export type IdentityVerdict = "match" | "mismatch" | "unknown";

/**
 * 身份置信度：
 *  - verified ：字段与已核实证据一致（可用于写操作）
 *  - observed ：只读到元数据并与已知产品特征一致，但基线未核实（仅用于展示）
 *  - none     ：读不到任何可识别信息
 */
export type IdentityConfidence = "verified" | "observed" | "none";

export interface IdentityCheck {
  root: string;
  expected: ProductId;
  verdict: IdentityVerdict;
  confidence: IdentityConfidence;
  /** 实际读到的产品名/版本等，可能为空 */
  observedProductName: string | null;
  observedVersion: string | null;
  observedDataFolderName: string | null;
  /** 命中的元数据来源文件（相对 root） */
  metadataSource: string | null;
  fields: IdentityFieldEvidence[];
  reasons: string[];
}

export interface ProductProfile {
  product: ProductId;
  displayName: string;
  /** 允许出现在产品元数据里的产品名（大小写不敏感） */
  productNames: string[];
  /** 期望的用户数据目录名（仅作身份线索，不作为隔离证明） */
  dataFolderNames: string[];
  /** 受信任的 Authenticode 发布者主题前缀 */
  trustedSignerSubjects: string[];
  /** 已实测可用的官方安装参数（未验证时为空） */
  installerArguments: string[];
  /** 安装目录内可执行文件相对路径（来自证据；未知为 null） */
  executableRelativePath: string | null;
  /** 该 profile 的信任状态与证据 */
  trust: TrustState;
  evidence: EvidenceRef | null;
  /** 最后一次确认可用的产品版本（空表示未知） */
  verifiedVersions: string[];
}

/* ------------------------------------------------------------------ 只读发现 */

/**
 * 发现阶段与身份阶段必须分开：
 *  - discovery：有没有找到登记 / 有没有解析出存在的路径
 *  - identity ：路径上的东西到底是什么（与“是否授权写操作”无关）
 */
export type DiscoveryState = "not-found" | "registry-only" | "path-found";
export type IdentityState = "unverified" | "identified" | "conflict";

export type ClueKind = "registry" | "shortcut" | "process" | "common-location" | "user-root" | "managed";

/** 一条发现线索。多条线索指向同一路径时合并为一份安装，而不是多份。 */
export interface Clue {
  kind: ClueKind;
  /** 来源标识：注册表视图、快捷方式文件名、进程名、目录名等 */
  source: string;
  detail: string | null;
}

/** 安装路径的取得方式：必须让用户知道路径是“登记值”还是“推导值” */
export type LocationSource =
  | "registry"
  | "derived-display-icon"
  | "derived-uninstall-string"
  | "derived-install-source"
  | "shortcut"
  | "process"
  | "common-location"
  | "user-root"
  | "managed"
  | "none";

export type ConflictReason =
  | "duplicate-uninstall-entry"
  | "duplicate-registration"
  | "install-location-shared"
  | "reparse-point"
  | "access-denied"
  | "path-missing"
  | "path-unreadable"
  | "corrupt-metadata"
  | "unknown-version"
  | "version-conflict"
  | "unverified-profile"
  | "identity-mismatch"
  | "identity-conflict"
  | "manager-self"
  | "multiple-installs"
  | "path-outside-management-root"
  | "managed-directory-orphan";

export interface InstallRecord {
  /** 稳定标识：有路径时为规范化路径，否则为登记键 */
  id: string;
  /** 已识别的产品；身份未确认时为 null */
  product: ProductId | null;
  /** 仅凭名称得到的线索，不参与任何写操作判定 */
  productHint: ProductId | null;
  displayName: string;
  displayVersion: string | null;
  publisher: string | null;
  installLocation: string | null;
  /** 安装路径来源，UI 必须展示，避免把推导值当成登记值 */
  locationSource: LocationSource;
  uninstallString: string | null;
  /** 最主要的一条线索来源 */
  primarySource: ClueKind;
  /** 指向同一路径的全部线索（已去重） */
  clues: Clue[];
  discovery: DiscoveryState;
  identity: IdentityState;
  identityCheck: IdentityCheck | null;
  /** 指向同一路径的卸载登记条数（>1 表示重复登记） */
  duplicateRegistrations: number;
  /** 需要人工确认（身份冲突、元数据损坏、重解析点等） */
  needsReview: boolean;
  /** 该目录是本工具自身的运行/打包目录，不是 WorkBuddy 客户端安装 */
  isManagerSelf: boolean;
  conflicts: ConflictReason[];
  /** 该目录是否由本工具创建并记录 */
  managedByTool: boolean;
}

/** 单个产品的发现汇总 */
export interface ProductDiscovery {
  product: ProductId;
  /** 已解析出存在路径的安装，可能多份（副本） */
  installs: InstallRecord[];
  /** 只找到登记、路径待解析 */
  pendingPath: InstallRecord[];
  state: "not-found" | "pending-path" | "found";
  /** 已解析路径的安装份数（>1 表示存在副本） */
  copyCount: number;
}

export interface SourceUsage {
  kind: ClueKind;
  count: number;
  note: string | null;
}

export interface ScanReport {
  scannedAt: string;
  /** 只读：本次扫描未写入任何位置 */
  readOnly: true;
  records: InstallRecord[];
  /** 扫描过程中被跳过的来源（含原因），便于解释结果 */
  skippedSources: { source: string; reason: string }[];
  /** 需要人工确认的冲突摘要 */
  conflicts: string[];
  products: ProductDiscovery[];
  sources: SourceUsage[];
}

/* ------------------------------------------------------------------ 操作计划 */

export type OperationKind = "install" | "update" | "uninstall" | "rollback";

export type StepAction = "read" | "create" | "replace" | "delete" | "backup" | "restore" | "verify" | "launch";

export interface PlannedStep {
  index: number;
  action: StepAction;
  /** 精确绝对路径或可读的操作目标 */
  target: string;
  /** 复制类步骤的来源（暂存目录内的路径），其它步骤为 null */
  source: string | null;
  reason: string;
  /** 该步骤是否可回滚 */
  reversible: boolean;
}

export interface OperationPlan {
  operationId: string;
  kind: OperationKind;
  product: ProductId;
  createdAt: string;
  expectedProduct: ProductId;
  source: PackageSource;
  version: string;
  signerSubject: string | null;
  sha256: string | null;
  requiredFreeSpaceBytes: number;
  backupDirectory: string | null;
  steps: PlannedStep[];
  rollbackSteps: PlannedStep[];
  /** 计划中的删除目标：MVP 只允许本工具受管目录，未知路径永远为空 */
  deletionTargets: string[];
  /** 阻断项（存在即禁止执行） */
  blockers: string[];
  notes: string[];
}

/* ------------------------------------------------------------------ 操作日志 */

export type OperationState =
  | "planned"
  | "staged"
  | "verified"
  | "committed"
  | "rolled-back"
  | "failed"
  | "interrupted";

export interface JournalStep {
  index: number;
  action: StepAction;
  target: string;
  state: "pending" | "done" | "failed";
  at: string | null;
  detail: string | null;
}

export interface OperationRecord {
  operationId: string;
  kind: OperationKind;
  product: ProductId;
  version: string;
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  planPath: string;
  steps: JournalStep[];
  notes: string[];
  failure: AppError | null;
}

/* ------------------------------------------------------------------ 操作结果 */

export interface OperationResult {
  operationId: string;
  state: OperationState;
  completedSteps: number;
  failure: AppError | null;
  notes: string[];
}

/* ------------------------------------------------------------------ 发布与包校验 */

export interface ReleaseInfo {
  product: ProductId;
  version: string;
  url: string;
  /** 官方元数据提供的哈希（若官方未提供则为 null） */
  sha256: string | null;
  publishedAt: string | null;
  sourceHost: string;
}

export interface AuthenticodeInfo {
  status: string;
  signerSubject: string | null;
  signerThumbprint: string | null;
  notAfter: string | null;
  chainOk: boolean;
}

export type PackageVerdict = "valid" | "invalid" | "unknown";

export interface PackageCheck {
  file: string;
  sizeBytes: number;
  sha256: string;
  authenticode: AuthenticodeInfo | null;
  /** 从包内读到的产品身份（若可读） */
  productName: string | null;
  productVersion: string | null;
  verdict: PackageVerdict;
  reasons: string[];
}

/* ------------------------------------------------------------------ 能力门 */

export interface CapabilityState {
  /** 官方安装器能否在 VM 证据支持下稳定安装到独立路径 */
  installAutomation: boolean;
  uninstallAutomation: boolean;
  updateAutomation: boolean;
  /** 内置更新能否被安全接管 */
  builtInUpdateControl: boolean;
  /** 阻断原因（面向用户的中文说明） */
  blockers: string[];
  /** 降级后的模式说明 */
  mode: "read-only" | "assisted" | "full";
  evidence: EvidenceRef[];
}

/* ------------------------------------------------------------------ 界面状态 */

export interface UpdateStatus {
  product: ProductId;
  checkedAt: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  state: "unknown" | "up-to-date" | "available" | "unavailable";
  reason: string | null;
}

export interface OnlineSourceState {
  /** 是否已配置并核实官方在线来源（未配置时不得显示任何在线版本） */
  configured: boolean;
  note: string;
}

/* ------------------------------------------------------------ 辅助操作（assisted） */

/**
 * 辅助操作只做三件事：预检、用户确认后启动官方交互式界面、操作后复扫。
 * 它不携带任何静默参数、不模拟点击、不接管客户端内置更新器。
 */
export type AssistedKind = "install" | "update" | "uninstall";

/**
 * - assisted      ：可辅助启动官方界面（仍需通过安装包/实例/确认检查）
 * - guidance-only ：只能提供手动指引（无可用官方入口或无法安全约束目标）
 * - blocked       ：被安全检查阻止（身份冲突、需人工确认等）
 */
export type AvailabilityState = "assisted" | "guidance-only" | "blocked";

export interface AssistedTarget {
  /** 安装记录 id（来自扫描结果，渲染端只能回传这个 id） */
  recordId: string;
  path: string | null;
  version: string | null;
  displayName: string;
  /** 仅卸载：从卸载登记里解析出的本地卸载程序（只展示与启动，不附加静默参数） */
  uninstallerPath: string | null;
  /** 卸载程序的解析说明或不可用原因 */
  uninstallerDetail: string | null;
}

export interface OperationAvailability {
  product: ProductId;
  kind: AssistedKind;
  state: AvailabilityState;
  /** 面向用户的说明：为什么是当前状态 */
  reason: string;
  /** 该操作可作用于的实例；多副本时用户必须显式选一个 */
  targets: AssistedTarget[];
  /** 必须显式选择实例（多副本或卸载时恒为 true） */
  requiresTarget: boolean;
  /** 必须选择本地安装包（install/update 为 true） */
  requiresPackage: boolean;
}

export type AssistedOutcome =
  | "launched-and-verified"
  | "launched-not-verified"
  | "installer-failed"
  | "cancelled"
  | "timeout"
  | "blocked";

export interface SnapshotSummary {
  version: string | null;
  paths: string[];
}

export interface AssistedResult {
  product: ProductId;
  kind: AssistedKind;
  outcome: AssistedOutcome;
  /** 实际启动的绝对路径 */
  launchedPath: string;
  launchedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  before: SnapshotSummary;
  after: SnapshotSummary;
  /** 另一产品的状态，用于证明/否定隔离 */
  counterpart: { product: ProductId; version: string | null; paths: string[]; changed: boolean };
  /** 复扫是否确认了目标产品的变化 */
  rescanConfirmed: boolean;
  notes: string[];
}

export interface AppState {
  appVersion: string;
  /** 构建标识：用于确认运行的是否为最新构建 */
  buildId: string;
  /** 构建时间（ISO） */
  buildTime: string;
  /** 是否打包运行 */
  packaged: boolean;
  platform: NodeJS.Platform;
  isWindows: boolean;
  /** 是否为携带版（数据与受管目录跟随 exe 所在目录） */
  portable: boolean;
  managementRoot: string;
  onlineSource: OnlineSourceState;
  capability: CapabilityState;
  /** 按产品 × 按操作的辅助能力（与“检测状态”分开） */
  operations: OperationAvailability[];
  profiles: ProductProfile[];
  scan: ScanReport | null;
  updates: UpdateStatus[];
  /** 本工具部署的受管实例（真正的安装/更新/卸载作用对象） */
  instances: ManagedInstance[];
  /** 本轮扫描的自动登记判定（含无法管理的原因，供界面短提示） */
  autoTrack: AutoTrackDecisionSummary[];
  lastDiagnosticsExport: string | null;
}

/* --------------------------------------------------------- 受管实例（真实安装） */

export type PackageFormat = "nsis" | "7z" | "zip" | "directory" | "unknown";

/**
 * 实例来源：
 *  - deployed：本工具解包部署到管理根目录的实例，可被更新/卸载；
 *  - external：扫描自动登记的既有官方安装，本工具只跟踪与启动；
 *             更新走原位替换（先备份），卸载走官方卸载器，**绝不直接递归删除**。
 */
export type InstanceOrigin = "deployed" | "external";

export interface ManagedInstance {
  instanceId: string;
  product: ProductId;
  version: string;
  directory: string;
  origin: InstanceOrigin;
  /** 该产品当前默认启动实例 */
  active: boolean;
  source: "local-file" | "official";
  packageFile: string;
  packageSha256: string;
  packageFormat: PackageFormat;
  /** 主程序签名发布者（接管实例来自本机读取） */
  signerSubject: string | null;
  /** 主程序签名指纹（十六进制，无分隔符） */
  signerThumbprint: string | null;
  installedAt: string;
  operationId: string;
  verified: boolean;
  /** 产品主可执行文件相对安装目录的路径 */
  executableRelativePath: string | null;
  /** 本工具创建的桌面快捷方式（用户自建的快捷方式不记录、也不删除） */
  shortcutPath?: string | null;
}

/** 接管候选：来自只读扫描，供用户在界面里显式接管 */
export interface AdoptCandidate {
  recordId: string;
  product: ProductId;
  displayName: string;
  version: string | null;
  directory: string;
  executableRelativePath: string | null;
  signerSubject: string | null;
  signerThumbprint: string | null;
  eligible: boolean;
  /** 不能接管时的具体原因 */
  blockers: string[];
  /** 已接管则给出实例 id */
  adoptedInstanceId: string | null;
}

export interface AdoptOutcome {
  instance: ManagedInstance;
  notes: string[];
}

/** 自动登记判定结果（与 core/autoTrack.ts 的 AutoTrackDecision 结构一致） */
export interface AutoTrackDecisionSummary {
  recordId: string;
  product: ProductId;
  directory: string;
  version: string | null;
  executableRelativePath: string | null;
  signerSubject: string | null;
  signerThumbprint: string | null;
  eligible: boolean;
  blockers: string[];
}

export interface DeployOutcome {
  instance: ManagedInstance;
  operationId: string;
  /** 部署前的默认实例（用于回滚与对比） */
  previousActiveInstanceId: string | null;
  notes: string[];
}

export interface UninstallOutcome {
  instanceId: string;
  product: ProductId;
  directory: string;
  removed: boolean;
  /** 默认保留的用户数据位置（本工具从不触碰） */
  userDataRetained: string[];
  operationId: string;
  notes: string[];
}
