import { z } from "zod";
import type { CapabilityState, EvidenceRef, ProductId, ProductProfile, TrustState } from "./contracts";

/**
 * 证据包（evidence bundle）是本工具唯一的产品身份/安装能力来源。
 * 只有在可重置虚拟机中按 docs/TEST_MATRIX.md 采集的证据才可标记为 verified。
 * 仓库内随包分发的 config/evidence.json 默认为空（无证据），因此工具默认降级为只读模式。
 */

const authenticodeSchema = z.object({
  status: z.string(),
  subject: z.string().nullable(),
  thumbprint: z.string().nullable(),
  notAfter: z.string().nullable(),
});

const packageEvidenceSchema = z.object({
  version: z.string().min(1),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  authenticode: authenticodeSchema,
  productName: z.string().nullable(),
  dataFolderName: z.string().nullable(),
});

const productEvidenceSchema = z.object({
  officialSource: z.object({
    pageUrl: z.string().url(),
    apiEndpoint: z.string().url().nullable(),
    downloadHost: z.string().min(1),
    observedAt: z.string().min(1),
  }),
  packages: z.array(packageEvidenceSchema),
  installer: z.object({
    scope: z.enum(["user", "machine", "both", "unknown"]),
    supportsCustomPath: z.boolean(),
    customPathArgument: z.string().nullable(),
    unattended: z.boolean(),
    note: z.string(),
  }),
  postInstall: z.object({
    installLocation: z.string().nullable(),
    dataDirectory: z.string().nullable(),
    uninstallKey: z.string().nullable(),
    shortcuts: z.array(z.string()),
    runningExecutable: z.string().nullable(),
    productName: z.string().nullable(),
  }),
  update: z.object({
    builtInUpdater: z.enum(["unknown", "present", "absent"]),
    controllable: z.boolean(),
    note: z.string(),
  }),
  uninstall: z.object({
    command: z.string().nullable(),
    removesUserData: z.enum(["unknown", "yes", "no"]),
    preservesOtherProduct: z.boolean(),
  }),
});

export const evidenceBundleSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string().min(1),
  capturedBy: z.string().min(1),
  environment: z.object({
    osVersion: z.string().min(1),
    locale: z.string().min(1),
    accountPrivilege: z.enum(["standard", "administrator"]),
    diskFreeGb: z.number().nonnegative(),
    snapshotId: z.string().min(1),
    vmTool: z.enum(["windows-sandbox", "hyper-v", "vmware", "virtualbox", "other"]),
  }),
  products: z.object({
    "workbuddy-cn": productEvidenceSchema.optional(),
    "workbuddy-ai": productEvidenceSchema.optional(),
  }),
});

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
export type ProductEvidence = z.infer<typeof productEvidenceSchema>;

export interface LoadedEvidence {
  bundle: EvidenceBundle | null;
  ref: EvidenceRef | null;
  /** 解析失败原因（用于 UI 解释为什么没有证据） */
  problem: string | null;
  rawText: string | null;
}

export const EMPTY_EVIDENCE: LoadedEvidence = {
  bundle: null,
  ref: null,
  problem: "未导入任何虚拟机证据包",
  rawText: null,
};

export function parseEvidenceBundle(raw: string, ref: EvidenceRef): LoadedEvidence {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { bundle: null, ref: null, problem: "证据包不是合法 JSON", rawText: null };
  }
  if (json === null) {
    return { bundle: null, ref: null, problem: "尚未导入虚拟机证据包", rawText: null };
  }
  const parsed = evidenceBundleSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? first.path.join(".") : "root";
    return { bundle: null, ref: null, problem: `证据包字段不合法（${where}）`, rawText: null };
  }
  return { bundle: parsed.data, ref, problem: null, rawText: raw };
}

function productTrust(ev: ProductEvidence | undefined): TrustState {
  if (!ev) return "unverified";
  const signed = ev.packages.some(
    (p) => p.authenticode.status === "Valid" && p.authenticode.thumbprint !== null && p.sha256.length === 64,
  );
  if (!signed) return "unverified";
  if (ev.installer.supportsCustomPath && ev.installer.scope !== "unknown" && ev.installer.scope !== "machine") {
    return "verified";
  }
  return "unverified";
}

export function profilesFromEvidence(evidence: LoadedEvidence): ProductProfile[] {
  const bundle = evidence.bundle;
  const ref = evidence.ref;
  const build = (product: ProductId, displayName: string): ProductProfile => {
    const ev = bundle?.products[product];
    const trust = productTrust(ev);
    return {
      product,
      displayName,
      productNames: ev?.postInstall.productName ? [ev.postInstall.productName] : [],
      dataFolderNames: ev?.packages.map((p) => p.dataFolderName).filter((x): x is string => Boolean(x)) ?? [],
      trustedSignerSubjects: ev?.packages.map((p) => p.authenticode.subject).filter((x): x is string => Boolean(x)) ?? [],
      installerArguments: ev?.installer.customPathArgument ? [ev.installer.customPathArgument] : [],
      executableRelativePath: ev?.postInstall.runningExecutable ?? null,
      trust,
      evidence: ref,
      verifiedVersions: ev?.packages.map((p) => p.version) ?? [],
    };
  };
  return [build("workbuddy-cn", "国内版 WorkBuddy"), build("workbuddy-ai", "国际版 WorkBuddy AI")];
}

/**
 * 能力状态（0.6.1）。
 *
 * 安装/更新/卸载由**管理器自己的解包部署管线**完成，不依赖官方安装器的无人值守能力，
 * 因此不再由虚拟机证据包决定，也不存在 read-only 降级。
 * 证据包仍然可以存在，但只用于展示产品特征（productName / dataFolderName），不参与放行判定。
 *
 * builtInUpdateControl 恒为 false：管理器从不接管客户端内置更新器，更新靠用户从官网下载后选择本地包。
 */
export function deriveCapabilities(_evidence: LoadedEvidence): CapabilityState {
  return {
    installAutomation: true,
    uninstallAutomation: true,
    updateAutomation: true,
    builtInUpdateControl: false,
    blockers: [],
    mode: "full",
    evidence: [],
  };
}

