import path from "node:path";
import type { IdentityCheck, IdentityFieldEvidence, ProductId, ProductProfile } from "./contracts";
import { normalizeName, traitsOf } from "./knownProducts";

/**
 * 产品身份核验：只读取应用元数据（product.json / package.json，含 app.asar 内），
 * 绝不读取登录凭据、令牌、聊天内容或用户数据文件。
 *
 * 重要：身份识别与“是否授权写操作”是两件事。
 * 即使没有虚拟机证据包，只要元数据与已知产品特征一致，也可以给出
 * “已识别（observed）”的结论用于展示；写操作仍然由证据门单独控制。
 */

export interface FileProbe {
  /** 返回文件内容（最多 maxBytes），不存在/不可读返回 null */
  readText(file: string, maxBytes: number): Promise<string | null>;
  isFile(file: string): Promise<boolean>;
  /** 读取 asar 归档内某个文本文件；不支持时返回 null */
  readAsarText?(asarFile: string, entryPath: string, maxBytes: number): Promise<string | null>;
}

/** 候选元数据位置（普通文件），按可信度从高到低尝试 */
export const METADATA_CANDIDATES = [
  "resources/app/product.json",
  "resources/app/package.json",
  "product.json",
  "package.json",
] as const;

/** 打包进 app.asar 时的候选位置 */
export const ASAR_CANDIDATES = ["product.json", "package.json"] as const;

const ASAR_FILE = "resources/app.asar";
const MAX_METADATA_BYTES = 512 * 1024;

export interface ParsedMetadata {
  source: string;
  name: string | null;
  productName: string | null;
  applicationName: string | null;
  dataFolderName: string | null;
  version: string | null;
}

export type MetadataRead =
  | { kind: "missing" }
  | { kind: "corrupt"; source: string }
  | { kind: "ok"; meta: ParsedMetadata };

function pickString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseMetadataText(text: string, source: string): ParsedMetadata | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  return {
    source,
    name: pickString(record, "name"),
    productName: pickString(record, "productName"),
    applicationName: pickString(record, "applicationName") ?? pickString(record, "win32Name"),
    dataFolderName: pickString(record, "dataFolderName"),
    version: pickString(record, "version"),
  };
}

export async function readMetadata(root: string, probe: FileProbe): Promise<MetadataRead> {
  for (const relative of METADATA_CANDIDATES) {
    const file = path.join(root, relative);
    let text: string | null;
    try {
      text = await probe.readText(file, MAX_METADATA_BYTES);
    } catch {
      continue;
    }
    if (text === null) continue;
    const parsed = parseMetadataText(text, relative);
    if (!parsed) return { kind: "corrupt", source: relative };
    return { kind: "ok", meta: parsed };
  }

  // Electron 应用常把元数据打进 app.asar；此时普通文件读取会全部失败
  if (probe.readAsarText) {
    const asarFile = path.join(root, ASAR_FILE);
    for (const entry of ASAR_CANDIDATES) {
      let text: string | null;
      try {
        text = await probe.readAsarText(asarFile, entry, MAX_METADATA_BYTES);
      } catch {
        continue;
      }
      if (text === null) continue;
      const parsed = parseMetadataText(text, `${ASAR_FILE}#${entry}`);
      if (!parsed) return { kind: "corrupt", source: `${ASAR_FILE}#${entry}` };
      return { kind: "ok", meta: parsed };
    }
  }

  return { kind: "missing" };
}

function matchesAny(value: string | null, candidates: string[]): boolean {
  if (!value) return false;
  const normalized = normalizeName(value);
  return candidates.some((c) => normalizeName(c) === normalized);
}

export interface IdentityVerificationInput {
  root: string;
  expected: ProductId;
  /** 证据基线（可为未验证） */
  profile: ProductProfile;
  /** 另一产品，用于识别“装错产品” */
  counterpart: ProductId;
  probe: FileProbe;
}

/**
 * verdict 语义：
 *  - match    ：元数据产品名与期望产品一致
 *  - mismatch ：能读到身份但与期望产品冲突（含“装成了另一版”）
 *  - unknown  ：读不到元数据 / JSON 损坏
 *
 * confidence 语义：
 *  - verified ：同时满足证据基线（数据目录名、版本清单）
 *  - observed ：仅元数据与已知产品特征一致
 *  - none     ：没有可用信息
 */
export async function verifyProductIdentity(input: IdentityVerificationInput): Promise<IdentityCheck> {
  const { root, expected, profile, counterpart, probe } = input;
  const base: IdentityCheck = {
    root,
    expected,
    verdict: "unknown",
    confidence: "none",
    observedProductName: null,
    observedVersion: null,
    observedDataFolderName: null,
    metadataSource: null,
    fields: [],
    reasons: [],
  };

  const read = await readMetadata(root, probe);
  if (read.kind === "missing") {
    return { ...base, reasons: ["未找到可识别的应用元数据文件"] };
  }
  if (read.kind === "corrupt") {
    return { ...base, metadataSource: read.source, reasons: [`元数据文件 JSON 解析失败：${read.source}`] };
  }

  const meta = read.meta;
  // 产品名优先级：productName（桌面端对外名称）> applicationName > name
  const observedProductName = meta.productName ?? meta.applicationName ?? meta.name;
  const traits = traitsOf(expected);
  const expectedNames = [...new Set([...traits.productNames, ...profile.productNames])];
  const counterpartNames = traitsOf(counterpart).productNames;

  const fields: IdentityFieldEvidence[] = [];
  const reasons: string[] = [];

  if (observedProductName) {
    fields.push({
      field: meta.productName ? "productName" : "applicationName",
      expected: expectedNames.join(" | "),
      observed: observedProductName,
      trust: profile.trust,
    });
  }
  if (meta.dataFolderName) {
    fields.push({
      field: "dataFolderName",
      expected: profile.dataFolderNames.join(" | ") || "（未核实）",
      observed: meta.dataFolderName,
      trust: profile.trust,
    });
  }
  if (meta.version) {
    fields.push({
      field: "version",
      expected: profile.verifiedVersions.join(" | ") || "（未核实）",
      observed: meta.version,
      trust: profile.verifiedVersions.includes(meta.version) ? "verified" : "unverified",
    });
  }

  const result: IdentityCheck = {
    ...base,
    observedProductName,
    observedVersion: meta.version,
    observedDataFolderName: meta.dataFolderName,
    metadataSource: meta.source,
    fields,
  };

  const matchesExpected = matchesAny(observedProductName, expectedNames);
  const matchesCounterpart = matchesAny(observedProductName, counterpartNames);

  if (matchesCounterpart && !matchesExpected) {
    return { ...result, verdict: "mismatch", confidence: "none", reasons: ["该目录属于另一产品，禁止混用"] };
  }
  if (!matchesExpected) {
    return {
      ...result,
      verdict: "mismatch",
      confidence: "none",
      reasons: [`产品名「${observedProductName ?? "未知"}」与期望产品不一致`],
    };
  }

  // 名称一致：只有在证据基线已核实、且数据目录/版本都对得上时才是 verified
  let confidence: IdentityCheck["confidence"] = "observed";
  if (profile.trust === "verified") {
    const dataFolderOk =
      profile.dataFolderNames.length === 0 ||
      !meta.dataFolderName ||
      matchesAny(meta.dataFolderName, profile.dataFolderNames);
    const versionOk =
      profile.verifiedVersions.length === 0 || !meta.version || profile.verifiedVersions.includes(meta.version);
    if (!dataFolderOk) {
      return { ...result, verdict: "mismatch", confidence: "none", reasons: ["数据目录名与期望产品不一致"] };
    }
    if (versionOk) {
      confidence = "verified";
    } else {
      reasons.push(`版本 ${meta.version} 不在已验证版本清单内`);
    }
  } else {
    reasons.push("身份基线尚未经虚拟机证据核实（仅用于展示，不授权写操作）");
  }

  return { ...result, verdict: "match", confidence, reasons };
}

/** 仅凭名称得到“线索”，永远不构成产品归类。 */
export function hintFromName(displayName: string, profiles: ProductProfile[] = []): ProductId | null {
  const value = normalizeName(displayName);
  if (!value.includes("workbuddy")) return null;
  const isIntl = /workbuddy\s*ai|workbuddyai|international|国际版/.test(value);
  const isCn = /国内版|中文版/.test(value);
  if (isIntl && !isCn) return "workbuddy-ai";
  if (isCn && !isIntl) return "workbuddy-cn";
  if (value === "workbuddy") return "workbuddy-cn";
  const exact = profiles.filter((p) => p.productNames.some((n) => normalizeName(n) === value));
  if (exact.length === 1) return exact[0]!.product;
  return null;
}
