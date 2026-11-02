import path from "node:path";
import os from "node:os";
import type {
  Clue,
  ClueKind,
  ConflictReason,
  DiscoveryState,
  IdentityCheck,
  InstallRecord,
  LocationSource,
  ProductDiscovery,
  ProductId,
  ProductProfile,
  ScanReport,
  SourceUsage,
} from "./contracts";
import { hintFromName, verifyProductIdentity, type FileProbe } from "./identity";
import { PRODUCT_IDS, traitsOf } from "./knownProducts";
import { isDriveRoot as isDriveRootPath, isSubPath, toCompareKey } from "./pathGuard";
import { resolveProcessCandidate } from "./processPath";

/**
 * 只读发现。任何分支都不得写入、删除、启动安装器或客户端。
 *
 * 设计要点：
 *  - 多条线索指向同一路径 → 合并为一份安装（附“重复登记”提示），而不是多条安装；
 *  - 登记没有 InstallLocation → 保留为“登记已发现，路径待解析”，绝不丢弃；
 *  - 路径解析必须确认目标存在，推导值要标注来源；
 *  - 发现状态（discovery）与身份状态（identity）分开，身份状态与写操作授权再分开。
 */

/* ------------------------------------------------------------------ 适配器接口 */

export interface RegistryEntry {
  view: "HKLM64" | "HKLM32" | "HKCU";
  key: string;
  values: Record<string, string>;
}

export interface RegistryReadResult {
  entries: RegistryEntry[];
  skipped: { source: string; reason: string }[];
}

export interface RegistryReader {
  readUninstallEntries(): Promise<RegistryReadResult>;
}

export interface ShortcutProvider {
  list(): Promise<{ file: string; target: string | null }[]>;
}

export interface ProcessProvider {
  list(): Promise<{ path: string; name: string }[]>;
  /** 可选：同时返回被拒绝的线索（盘符根、卸载器、临时目录等），用于诊断 */
  listDetailed?(): Promise<{
    accepted: { path: string; name: string }[];
    rejected: { path: string; name: string; reason: string; detail: string }[];
  }>;
}

export interface CommonLocationProvider {
  /** 返回候选安装目录（已按名称相关性筛选），并附来源说明 */
  list(): Promise<{ path: string; source: string }[]>;
}

export interface ManagedInstallation {
  product: ProductId;
  directory: string;
  version: string;
}

export interface ScanDeps {
  registry: RegistryReader;
  probe: FileProbe;
  listDirectory(directory: string): Promise<string[]>;
  isReparsePoint(target: string): Promise<boolean>;
  /** 判断路径是否存在（目录或文件）；缺省时用 listDirectory 探测 */
  existsPath?(target: string): Promise<boolean>;
  shortcuts?: ShortcutProvider;
  processes?: ProcessProvider;
  commonLocations?: CommonLocationProvider;
}

export interface ScanInput {
  deps: ScanDeps;
  profiles: ProductProfile[];
  /** 用户显式选择的额外只读扫描根目录 */
  userRoots: string[];
  managed: ManagedInstallation[];
  /**
   * 本工具自身的运行/打包目录。这些目录可能因名称含 workbuddy 被当作候选，
   * 但它们是管理器自身，不是 WorkBuddy 客户端安装：保留为诊断，不计入任何产品。
   */
  selfDirectories?: string[];
  /** 系统临时目录；仅排除其下本工具命名的安装/更新事务目录 */
  temporaryDirectory?: string;
}

/* ------------------------------------------------------------------ 路径推导 */

export interface DerivedLocation {
  path: string;
  source: Extract<LocationSource, "derived-display-icon" | "derived-uninstall-string" | "derived-install-source">;
}

function isPlausibleDirectory(directory: string): boolean {
  if (!/^[a-zA-Z]:\\/.test(directory)) return false;
  if (directory.length > 240) return false;
  if (/[*?<>|"]/.test(directory)) return false;
  if (/\\windows\\system32$/i.test(directory)) return false;
  if (path.parse(directory).root.toLowerCase() === directory.toLowerCase()) return false;
  return true;
}

/** 去掉结尾分隔符，避免 "C:\a\b\" 与 "C:\a\b" 被当成两个路径 */
export function trimTrailingSeparator(target: string): string {
  const trimmed = target.replace(/[\\/]+$/, "");
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

/** 从命令行字符串里取出可执行文件路径；只解析，绝不执行 */
function extractExecutablePath(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 1) return trimmed.slice(1, end);
  }
  const exeMatch = /^(.*?\.exe)\b/i.exec(trimmed);
  if (exeMatch?.[1]) return exeMatch[1];
  const first = trimmed.split(/\s+/)[0];
  return first && /\.\w{2,4}$/.test(first) ? first : null;
}

/**
 * 按 DisplayIcon → UninstallString → InstallSource 的顺序给出候选路径。
 * 仅返回“看起来合理”的本地绝对路径，实际存在性由调用方确认。
 */
export function deriveLocationCandidates(values: Record<string, string>): DerivedLocation[] {
  const candidates: DerivedLocation[] = [];

  const icon = values["DisplayIcon"]?.trim();
  if (icon) {
    const cleaned = icon.replace(/,\s*-?\d+\s*$/, "").replace(/^"|"$/g, "").trim();
    if (/^[a-zA-Z]:\\/.test(cleaned)) {
      const directory = path.normalize(/\.(exe|ico|dll)$/i.test(cleaned) ? path.dirname(cleaned) : cleaned);
      if (isPlausibleDirectory(directory)) candidates.push({ path: trimTrailingSeparator(directory), source: "derived-display-icon" });
    }
  }

  const uninstall = values["UninstallString"]?.trim();
  if (uninstall) {
    const executable = extractExecutablePath(uninstall);
    if (executable && /^[a-zA-Z]:\\/.test(executable)) {
      const directory = path.normalize(path.dirname(executable));
      if (isPlausibleDirectory(directory)) candidates.push({ path: trimTrailingSeparator(directory), source: "derived-uninstall-string" });
    }
  }

  const installSource = values["InstallSource"]?.trim();
  if (installSource) {
    const cleaned = installSource.replace(/^"|"$/g, "").trim();
    if (/^[a-zA-Z]:\\/.test(cleaned)) {
      const directory = path.normalize(/\.(exe|msi|log)$/i.test(cleaned) ? path.dirname(cleaned) : cleaned);
      if (isPlausibleDirectory(directory)) candidates.push({ path: trimTrailingSeparator(directory), source: "derived-install-source" });
    }
  }

  return candidates;
}

/** 兼容旧接口：只取第一个候选 */
export function deriveInstallLocation(values: Record<string, string>): DerivedLocation | null {
  return deriveLocationCandidates(values)[0] ?? null;
}

/* ------------------------------------------------------------------ 内部工具 */

const PRODUCT_ORDER = PRODUCT_IDS;

export function isTemporaryOperationPath(target: string, temporaryDirectory: string): boolean {
  const root = toCompareKey(temporaryDirectory);
  const candidate = toCompareKey(target);
  const prefix = root.endsWith("\\") ? root : `${root}\\`;
  if (!candidate.startsWith(prefix)) return false;
  const relative = candidate.slice(root.length).replace(/^\\+/, "");
  return /^wb-(?:install|update)-/i.test(relative.split("\\")[0] ?? "");
}

function looksLikeWorkBuddy(value: string | null | undefined): boolean {
  return typeof value === "string" && value.toLowerCase().includes("workbuddy");
}

function profileFor(profiles: ProductProfile[], product: ProductId): ProductProfile {
  const found = profiles.find((p) => p.product === product);
  if (found) return found;
  // 没有证据时给出一个“未验证”的空基线，保证只读展示仍可用
  return {
    product,
    displayName: traitsOf(product).displayName,
    productNames: [],
    dataFolderNames: [],
    trustedSignerSubjects: [],
    installerArguments: [],
    executableRelativePath: null,
    trust: "unverified",
    evidence: null,
    verifiedVersions: [],
  };
}

interface Classification {
  product: ProductId | null;
  check: IdentityCheck | null;
  /** 同一目录同时符合两个产品 */
  bothMatch: boolean;
  /** 两个产品都不匹配（但能读到身份） */
  mismatched: boolean;
  needsReview: boolean;
}

async function classifyDirectory(location: string, profiles: ProductProfile[], probe: FileProbe): Promise<Classification> {
  const checks: { product: ProductId; check: IdentityCheck }[] = [];
  for (const product of PRODUCT_ORDER) {
    const counterpart: ProductId = product === "workbuddy-cn" ? "workbuddy-ai" : "workbuddy-cn";
    const check = await verifyProductIdentity({
      root: location,
      expected: product,
      profile: profileFor(profiles, product),
      counterpart,
      probe,
    });
    checks.push({ product, check });
  }
  const matched = checks.filter((c) => c.check.verdict === "match");
  if (matched.length === 1) {
    return { product: matched[0]!.product, check: matched[0]!.check, bothMatch: false, mismatched: false, needsReview: false };
  }
  if (matched.length > 1) {
    return { product: null, check: matched[0]!.check, bothMatch: true, mismatched: false, needsReview: true };
  }
  const unknown = checks.find((c) => c.check.verdict === "unknown");
  if (unknown) {
    const corrupt = unknown.check.reasons.some((r) => r.includes("JSON"));
    return {
      product: null,
      check: unknown.check,
      bothMatch: false,
      mismatched: false,
      needsReview: corrupt,
    };
  }
  return { product: null, check: checks[0]?.check ?? null, bothMatch: false, mismatched: true, needsReview: true };
}

function emptyRecord(id: string, primary: ClueKind, discovery: DiscoveryState): InstallRecord {
  return {
    id,
    product: null,
    productHint: null,
    displayName: "",
    displayVersion: null,
    publisher: null,
    installLocation: null,
    locationSource: "none",
    uninstallString: null,
    primarySource: primary,
    clues: [],
    discovery,
    identity: "unverified",
    identityCheck: null,
    duplicateRegistrations: 0,
    needsReview: false,
    isManagerSelf: false,
    conflicts: [],
    managedByTool: false,
  };
}

function addClue(record: InstallRecord, clue: Clue): boolean {
  const duplicate = record.clues.some(
    (c) => c.kind === clue.kind && c.source === clue.source && c.detail === clue.detail,
  );
  if (duplicate) return false;
  record.clues.push(clue);
  return true;
}

function pushConflict(record: InstallRecord, reason: ConflictReason): void {
  if (!record.conflicts.includes(reason)) record.conflicts.push(reason);
}

/* ------------------------------------------------------------------ 主流程 */

export async function scanInstallations(input: ScanInput): Promise<ScanReport> {
  const { deps, profiles, userRoots, managed, selfDirectories, temporaryDirectory } = input;
  const scannedAt = new Date().toISOString();
  const byPath = new Map<string, InstallRecord>();
  const pending: InstallRecord[] = [];
  const skippedSources: { source: string; reason: string }[] = [];
  const conflicts: string[] = [];
  const sourceCounts = new Map<ClueKind, number>();

  const exists = async (target: string): Promise<boolean> => {
    if (deps.existsPath) {
      try {
        return await deps.existsPath(target);
      } catch {
        return false;
      }
    }
    try {
      await deps.listDirectory(target);
      return true;
    } catch {
      return false;
    }
  };

  const countSource = (kind: ClueKind): void => {
    sourceCounts.set(kind, (sourceCounts.get(kind) ?? 0) + 1);
  };

  const ensureRecord = async (directory: string, clue: Clue, locationSource: LocationSource): Promise<InstallRecord | null> => {
    const absolute = path.normalize(directory);
    // 盘符根目录不是安装实例：任何线索（进程/注册表/快捷方式）都不能造出这种记录
    if (isDriveRootPath(absolute)) return null;
    if (temporaryDirectory && isTemporaryOperationPath(absolute, temporaryDirectory)) return null;
    const key = toCompareKey(absolute);
    if (!(await exists(absolute))) return null;
    let record = byPath.get(key);
    if (!record) {
      record = emptyRecord(`path:${key}`, clue.kind, "path-found");
      record.installLocation = absolute;
      record.locationSource = locationSource;
      byPath.set(key, record);
    }
    // 线索计数按“去重后的线索”统计：同一路径的多个进程/快捷方式只算一条
    if (addClue(record, clue)) countSource(clue.kind);
    return record;
  };

  /* ---------------------------------------------- 1. 注册表卸载项（HKCU + HKLM 32/64） */
  let registryResult: RegistryReadResult = { entries: [], skipped: [] };
  try {
    registryResult = await deps.registry.readUninstallEntries();
    skippedSources.push(...registryResult.skipped);
  } catch (error) {
    skippedSources.push({
      source: "registry:uninstall",
      reason: error instanceof Error ? error.message : "读取注册表失败",
    });
  }

  for (const entry of registryResult.entries) {
    const displayName = entry.values["DisplayName"] ?? "";
    const registered = entry.values["InstallLocation"]?.trim() || null;
    if (!looksLikeWorkBuddy(displayName) && !looksLikeWorkBuddy(registered)) continue;

    // 路径解析：登记值优先，其次按 DisplayIcon → UninstallString → InstallSource 推导并确认存在
    let resolved: { path: string; source: LocationSource } | null = null;
    if (registered && (await exists(registered))) {
      resolved = { path: trimTrailingSeparator(path.normalize(registered)), source: "registry" };
    }
    if (!resolved) {
      for (const candidate of deriveLocationCandidates(entry.values)) {
        if (await exists(candidate.path)) {
          resolved = { path: candidate.path, source: candidate.source };
          break;
        }
      }
    }

    const clue: Clue = { kind: "registry", source: entry.view, detail: displayName || entry.key };

    if (!resolved) {
      // 登记已发现，路径待解析：保留记录，绝不丢弃
      const record = emptyRecord(`${entry.view}:${entry.key}`, "registry", "registry-only");
      record.displayName = displayName || "（无显示名的卸载登记）";
      record.displayVersion = entry.values["DisplayVersion"] ?? null;
      record.publisher = entry.values["Publisher"] ?? null;
      record.uninstallString = entry.values["UninstallString"] ?? null;
      record.productHint = hintFromName(displayName, profiles);
      record.locationSource = "none";
      addClue(record, clue);
      pushConflict(record, registered ? "path-missing" : "path-unreadable");
      countSource("registry");
      pending.push(record);
      conflicts.push(
        `${displayName || entry.key}：登记已发现，但${registered ? "登记的安装路径不存在" : "缺少可用安装路径"}，无法核验`,
      );
      continue;
    }

    const record = await ensureRecord(resolved.path, clue, resolved.source);
    if (!record) continue;
    record.displayName = record.displayName || displayName || path.basename(resolved.path);
    record.uninstallString = record.uninstallString ?? (entry.values["UninstallString"] ?? null);
    record.publisher = record.publisher ?? (entry.values["Publisher"] ?? null);
    record.productHint = record.productHint ?? hintFromName(displayName, profiles);
    record.duplicateRegistrations += 1;

    const version = entry.values["DisplayVersion"] ?? null;
    if (version) {
      if (record.displayVersion && record.displayVersion !== version) {
        pushConflict(record, "version-conflict");
        record.needsReview = true;
        conflicts.push(`${resolved.path}：同一路径的登记版本不一致（${record.displayVersion} / ${version}），需人工确认`);
      } else {
        record.displayVersion = version;
      }
    }
  }

  /* ---------------------------------------------- 2. 快捷方式（桌面 + 开始菜单） */
  if (deps.shortcuts) {
    try {
      const items = await deps.shortcuts.list();
      let unparsedRelated = 0;
      let unrelated = 0;
      for (const item of items) {
        const fileName = path.basename(item.file, path.extname(item.file));
        const nameRelated = looksLikeWorkBuddy(fileName);
        if (!item.target) {
          // 只有名称与 WorkBuddy 相关的快捷方式才计入“跳过项”，
          // 否则普通桌面/开始菜单快捷方式会把诊断信息淹没
          if (nameRelated) unparsedRelated += 1;
          else unrelated += 1;
          continue;
        }
        if (!looksLikeWorkBuddy(item.target) && !nameRelated) continue;
        const directory = path.dirname(item.target);
        const record = await ensureRecord(directory, { kind: "shortcut", source: fileName, detail: item.target }, "shortcut");
        if (!record) {
          if (nameRelated) {
            skippedSources.push({ source: `shortcut:${fileName}`, reason: "快捷方式目标目录不存在" });
          }
          continue;
        }
        record.displayName = record.displayName || fileName;
        record.productHint = record.productHint ?? hintFromName(fileName, profiles);
      }
      if (unparsedRelated > 0) {
        skippedSources.push({
          source: "shortcuts",
          reason: `${unparsedRelated} 个与 WorkBuddy 相关的快捷方式无法解析出本地目标（可能是网络路径、UWP 或已损坏）`,
        });
      }
      if (unrelated > 0) {
        skippedSources.push({
          source: "shortcuts:unrelated",
          reason: `另有 ${unrelated} 个与本产品无关的快捷方式无法解析，已忽略（不计入 WorkBuddy 跳过项）`,
        });
      }
    } catch (error) {
      skippedSources.push({
        source: "shortcuts",
        reason: error instanceof Error ? error.message : "读取快捷方式失败",
      });
    }
  }

  /* ---------------------------------------------- 3. 运行中进程（只取可执行文件路径） */
  if (deps.processes) {
    try {
      const detailed = deps.processes.listDetailed
        ? await deps.processes.listDetailed()
        : { accepted: await deps.processes.list(), rejected: [] };
      for (const item of detailed.accepted) {
        if (!looksLikeWorkBuddy(item.path) && !looksLikeWorkBuddy(item.name)) continue;
        // 二次确认：只接受“客户端主程序 .exe”的父目录，盘符根/临时目录一律丢弃
        const resolved = resolveProcessCandidate(item, {
          tempDirectories: [os.tmpdir(), temporaryDirectory].filter(
            (item): item is string => typeof item === "string" && item !== "",
          ),
        });
        if (!resolved.ok) {
          skippedSources.push({
            source: "processes:invalid-path",
            reason: resolved.reject.detail + "（" + path.win32.basename(item.path) + "）",
          });
          continue;
        }
        const directory = resolved.value.directory;
        const record = await ensureRecord(directory, { kind: "process", source: item.name, detail: item.path }, "process");
        if (!record) continue;
        record.displayName = record.displayName || path.basename(directory);
        record.productHint =
          record.productHint ?? resolved.value.product ?? hintFromName(item.name, profiles);
      }
      for (const rejected of detailed.rejected) {
        skippedSources.push({
          source: "processes:invalid-path",
          reason: rejected.detail + "（" + (path.win32.basename(rejected.path) || rejected.name || "未知进程") + "）",
        });
      }
    } catch (error) {
      skippedSources.push({
        source: "processes",
        reason: error instanceof Error ? error.message : "读取进程列表失败",
      });
    }
  }

  /* ---------------------------------------------- 4. 有界常见安装位置 */
  if (deps.commonLocations) {
    try {
      const items = await deps.commonLocations.list();
      for (const item of items) {
        const record = await ensureRecord(
          item.path,
          { kind: "common-location", source: item.source, detail: item.path },
          "common-location",
        );
        if (!record) continue;
        record.displayName = record.displayName || path.basename(item.path);
        record.productHint = record.productHint ?? hintFromName(path.basename(item.path), profiles);
      }
    } catch (error) {
      skippedSources.push({
        source: "common-locations",
        reason: error instanceof Error ? error.message : "扫描常见安装位置失败",
      });
    }
  }

  /* ---------------------------------------------- 5. 用户显式选择的目录 */
  for (const root of userRoots) {
    const absolute = path.resolve(root);
    let children: string[] = [];
    try {
      children = await deps.listDirectory(absolute);
    } catch (error) {
      skippedSources.push({
        source: `user-root:${absolute}`,
        reason: error instanceof Error ? error.message : "目录不可读",
      });
      continue;
    }
    const candidates = children.filter((name) => looksLikeWorkBuddy(name)).map((name) => path.join(absolute, name));
    for (const candidate of candidates) {
      const record = await ensureRecord(
        candidate,
        { kind: "user-root", source: absolute, detail: candidate },
        "user-root",
      );
      if (!record) {
        skippedSources.push({ source: `user-root:${candidate}`, reason: "目录不存在或不可读" });
        continue;
      }
      record.displayName = record.displayName || path.basename(candidate);
      record.productHint = record.productHint ?? hintFromName(path.basename(candidate), profiles);
    }
  }

  /* ---------------------------------------------- 6. 本工具受管目录 */
  for (const item of managed) {
    const record = await ensureRecord(
      item.directory,
      { kind: "managed", source: "本工具受管目录", detail: item.directory },
      "managed",
    );
    if (!record) {
      skippedSources.push({ source: `managed:${item.directory}`, reason: "受管目录不存在" });
      continue;
    }
    record.managedByTool = true;
    record.displayVersion = record.displayVersion ?? item.version;
    record.displayName = record.displayName || `本工具受管安装（${item.product}）`;
  }

  /* ---------------------------------------------- 7. 身份核验 */
  const records = [...byPath.values()].sort((a, b) => (a.installLocation ?? "").localeCompare(b.installLocation ?? ""));
  const selfKeys = new Set((selfDirectories ?? []).map((dir) => toCompareKey(path.normalize(dir))));

  for (const record of records) {
    const location = record.installLocation;
    if (!location) continue;
    try {
      if (await deps.isReparsePoint(location)) {
        pushConflict(record, "reparse-point");
        record.needsReview = true;
        conflicts.push(`${location}：目录是重解析点（符号链接/junction），已拒绝自动处理`);
      }
    } catch {
      pushConflict(record, "path-unreadable");
      record.needsReview = true;
    }

    // 管理器自身的运行/打包目录：保留为诊断，但不算作任何产品的安装
    if (selfKeys.has(toCompareKey(location))) {
      record.isManagerSelf = true;
      record.identity = "unverified";
      record.needsReview = false;
      record.conflicts = record.conflicts.filter((c) => c !== "identity-mismatch" && c !== "identity-conflict");
      pushConflict(record, "manager-self");
      record.identityCheck = await classifyDirectory(location, profiles, deps.probe).then((c) => c.check);
      continue;
    }

    const classification = await classifyDirectory(location, profiles, deps.probe);
    record.identityCheck = classification.check;
    if (classification.product) {
      record.product = classification.product;
      record.identity = "identified";
      if (classification.check?.confidence === "observed") pushConflict(record, "unverified-profile");
    } else if (classification.bothMatch) {
      record.identity = "conflict";
      pushConflict(record, "identity-conflict");
      record.needsReview = true;
      conflicts.push(`${location}：同时符合国内版与国际版特征，需人工确认`);
    } else if (classification.mismatched) {
      record.identity = "conflict";
      pushConflict(record, "identity-mismatch");
      record.needsReview = true;
      conflicts.push(`${location}：产品名与两个已知产品都不匹配，需人工确认`);
    } else {
      record.identity = "unverified";
      const reasons = classification.check?.reasons.join(" ") ?? "";
      pushConflict(record, reasons.includes("JSON") ? "corrupt-metadata" : "unverified-profile");
      if (reasons.includes("JSON")) {
        record.needsReview = true;
        conflicts.push(`${location}：元数据损坏，需人工确认`);
      }
    }

    if (record.duplicateRegistrations > 1) pushConflict(record, "duplicate-registration");
    if (!record.displayVersion && !record.identityCheck?.observedVersion) pushConflict(record, "unknown-version");
  }

  /* ---------------------------------------------- 8. 同一产品的多份安装 */
  for (const product of PRODUCT_ORDER) {
    const installs = records.filter((r) => r.product === product);
    if (installs.length > 1) {
      for (const record of installs) {
        pushConflict(record, "multiple-installs");
        conflicts.push(`${traitsOf(product).displayName}：发现 ${installs.length} 份安装，按路径分别列出（主副本关系未知）`);
      }
    }
  }

  /* ---------------------------------------------- 9. 产品汇总 */
  const products: ProductDiscovery[] = PRODUCT_ORDER.map((product) => {
    const installs = records.filter((r) => r.product === product);
    const pendingPath = pending.filter((r) => r.productHint === product);
    const state: ProductDiscovery["state"] =
      installs.length > 0 ? "found" : pendingPath.length > 0 ? "pending-path" : "not-found";
    return { product, installs, pendingPath, state, copyCount: installs.length };
  });

  const sources: SourceUsage[] = [...sourceCounts.entries()]
    .map(([kind, count]) => ({
      kind,
      count,
      note: kind === "registry" ? "含路径待解析的登记" : null,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    scannedAt,
    readOnly: true,
    records: [...records, ...pending],
    skippedSources,
    conflicts: [...new Set(conflicts)],
    products,
    sources,
  };
}
