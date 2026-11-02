import { z } from "zod";
import type {
  AdoptCandidate,
  AdoptOutcome,
  AppState,
  AssistedKind,
  AssistedResult,
  CapabilityState,
  DeployOutcome,
  InstallSelection,
  ManagedInstance,
  OperationKind,
  OperationPlan,
  OperationRecord,
  OperationResult,
  PackageCheck,
  ProductId,
  Result,
  ScanReport,
  UninstallOutcome,
  UpdateStatus,
} from "../core/contracts";

/**
 * IPC 契约：通道名 + 入参 schema。主进程对每个入参做严格解析，
 * renderer 拿不到任何任意 shell / 任意路径写 / 任意文件读能力。
 */

export const IPC = {
  getState: "app:getState",
  getSettings: "app:getSettings",
  updateSettings: "app:updateSettings",
  scan: "scan:run",
  inspectPackage: "package:inspect",
  preview: "operation:preview",
  start: "operation:start",
  cancel: "operation:cancel",
  rollback: "operation:rollback",
  listOperations: "operation:list",
  checkUpdates: "update:check",
  launch: "product:launch",
  runAssisted: "assisted:run",
  installManaged: "managed:install",
  updateManaged: "managed:update",
  uninstallManaged: "managed:uninstall",
  launchInstance: "managed:launch",
  listInstances: "managed:list",
  openOfficial: "official:open",
  openSponsor: "sponsor:open",
  exportDiagnostics: "diagnostics:export",
  pickDirectory: "dialog:pickDirectory",
  pickPackage: "dialog:pickPackage",
  progress: "operation:progress",
} as const;

export const productIdSchema = z.enum(["workbuddy-cn", "workbuddy-ai"]);
export const operationKindSchema = z.enum(["install", "update", "uninstall", "rollback"]);

export const packageSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("official") }).strict(),
  z.object({ kind: z.literal("local-file"), path: z.string().min(1).max(400) }).strict(),
]);

export const installSelectionSchema = z
  .object({
    product: productIdSchema,
    selected: z.boolean(),
    source: packageSourceSchema,
    version: z.string().max(64),
    targetDirectory: z.string().max(400),
  })
  .strict();

export const selectionsSchema = z.array(installSelectionSchema).min(1).max(2);

export const previewInputSchema = z.object({ kind: operationKindSchema, selections: selectionsSchema }).strict();
export const startInputSchema = previewInputSchema;
export const cancelInputSchema = z.object({ operationId: z.string().min(4).max(80) }).strict();
export const rollbackInputSchema = cancelInputSchema;
export const inspectInputSchema = z.object({ file: z.string().min(1).max(400), product: productIdSchema }).strict();
export const productInputSchema = z.object({ product: productIdSchema }).strict();

export const assistedKindSchema = z.enum(["install", "update", "uninstall"]);

/**
 * 辅助操作入参：渲染端只能回传产品、操作类型、用户挑选的安装包绝对路径、
 * 以及扫描结果里的安装记录 id。没有任何“任意命令”或“任意参数”通道。
 */
export const assistedInputSchema = z
  .object({
    product: productIdSchema,
    kind: assistedKindSchema,
    packagePath: z.string().max(400).optional(),
    targetRecordId: z.string().max(400).optional(),
    confirmed: z.boolean(),
    timeoutMs: z.number().int().min(30_000).max(1_800_000).optional(),
  })
  .strict();

/* --------------------------------------------------------- 受管实例（真实安装/更新/卸载） */

export const installManagedSchema = z
  .object({
    product: productIdSchema,
    packagePath: z.string().min(1).max(400),
    /** 用户确认的最终安装目录；必填，主进程不接受空值或缺失 */
    targetDirectory: z.string().min(1).max(400),
    /** 用户同意在本机尚无发布者基线时记录该发布者 */
  })
  .strict();

export const updateManagedSchema = z
  .object({
    product: productIdSchema,
    instanceId: z.string().min(4).max(160),
    packagePath: z.string().min(1).max(400),
  })
  .strict();

export const uninstallManagedSchema = z
  .object({
    product: productIdSchema,
    instanceId: z.string().min(4).max(160),
    /** 必须由用户在二次确认框中明确同意 */
    confirmed: z.boolean(),
  })
  .strict();

export const openOfficialSchema = z
  .object({
    product: productIdSchema,
  })
  .strict();

/**
 * 赞助商入口入参：严格空对象。
 * 目标地址只存在于主进程，renderer 传任何字段（url / host / scheme）都会被拒绝，
 * 因此不存在把该通道扩成“任意 URL 打开”的余地。
 */
export const sponsorInputSchema = z.object({}).strict();

export const adoptSchema = z
  .object({
    product: productIdSchema,
    recordId: z.string().min(1).max(400),
  })
  .strict();

export const releaseSchema = z
  .object({
    product: productIdSchema,
    instanceId: z.string().min(4).max(160),
  })
  .strict();

export const launchInstanceSchema = z
  .object({
    product: productIdSchema,
    instanceId: z.string().min(4).max(160).optional(),
  })
  .strict();
export const importEvidenceInputSchema = z.object({ file: z.string().min(1).max(400) }).strict();
export const settingsPatchSchema = z
  .object({
    managementRoot: z.string().max(400).optional(),
    userScanRoots: z.array(z.string().max(400)).max(10).optional(),
    autoCheckUpdates: z.boolean().optional(),
    autoDownload: z.boolean().optional(),
    autoInstall: z.boolean().optional(),
  })
  .strict();

export interface PreviewPayload {
  plans: { plan: OperationPlan; text: string }[];
  blocked: string[];
}

export interface SettingsPayload {
  managementRoot: string;
  userScanRoots: string[];
  autoCheckUpdates: boolean;
  autoDownload: boolean;
  autoInstall: boolean;
}

export interface ProgressPayload {
  operationId: string;
  product?: ProductId;
  /** 阶段文字（中文，面向用户） */
  phase?: string;
  percent?: number;
  received?: number;
  total?: number;
}

/** preload 暴露给界面的最小 API 面 */
export interface WorkBuddyApi {
  getState(): Promise<Result<AppState>>;
  getSettings(): Promise<Result<SettingsPayload>>;
  updateSettings(patch: Partial<SettingsPayload>): Promise<Result<SettingsPayload>>;
  scan(): Promise<Result<ScanReport>>;
  inspectPackage(file: string, product: ProductId): Promise<Result<PackageCheck>>;
  preview(kind: OperationKind, selections: InstallSelection[]): Promise<Result<PreviewPayload>>;
  start(kind: OperationKind, selections: InstallSelection[]): Promise<Result<OperationResult[]>>;
  cancel(operationId: string): Promise<Result<true>>;
  rollback(operationId: string): Promise<Result<OperationResult>>;
  listOperations(): Promise<Result<OperationRecord[]>>;
  checkUpdates(product: ProductId): Promise<Result<UpdateStatus>>;
  launch(product: ProductId): Promise<Result<true>>;
  runAssisted(input: {
    product: ProductId;
    kind: AssistedKind;
    packagePath?: string;
    targetRecordId?: string;
    confirmed: boolean;
    timeoutMs?: number;
  }): Promise<Result<AssistedResult>>;
  installManaged(input: {
    product: ProductId;
    packagePath: string;
    targetDirectory?: string;
  }): Promise<Result<DeployOutcome>>;
  updateManaged(input: {
    product: ProductId;
    instanceId: string;
    packagePath: string;
  }): Promise<Result<DeployOutcome>>;
  uninstallManaged(input: { product: ProductId; instanceId: string; confirmed: boolean }): Promise<Result<UninstallOutcome>>;
  launchInstance(input: { product: ProductId; instanceId?: string }): Promise<Result<true>>;
  listInstances(): Promise<Result<ManagedInstance[]>>;
  openOfficial(input: { product: ProductId }): Promise<Result<{ url: string }>>;
  openSponsor(): Promise<Result<{ url: string }>>;
  exportDiagnostics(): Promise<Result<string>>;
  pickDirectory(): Promise<string | null>;
  pickPackage(): Promise<string | null>;
  onProgress(listener: (payload: ProgressPayload) => void): () => void;
}
