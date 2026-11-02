import { createHash } from "node:crypto";
import {
  type InstallRecord,
  type ManagedInstance,
  type ProductId,
  type ScanReport,
  type Result,
  fail,
  ok,
} from "./contracts";
import { toCompareKey } from "./pathGuard";

/**
 * 自动登记（auto-track）。
 *
 * 设计要点：
 *  - 扫描结果是唯一事实来源：每次扫描后，把"安全识别 + 校验通过"的既有安装**幂等**登记为可管理实例；
 *  - 用户不需要点"纳入管理"；登记只是写管理器自己的状态文件；
 *  - 不移动、不覆盖、不删除、不启动客户端，不碰注册表/快捷方式/用户数据；
 *  - 同一真实目录永远得到同一个 instanceId，多副本按路径分别登记，绝不合并。
 */

export interface AutoTrackProbe {
  directoryExists(directory: string): Promise<boolean>;
  isReparsePoint(target: string): Promise<boolean>;
  /** 返回主程序相对路径；找不到返回 null */
  findExecutable(directory: string, product: ProductId): Promise<string | null>;
  /** 读取主程序签名（失败返回 unknown） */
  signatureStatus(executable: string): Promise<{
    status: "Valid" | "Invalid" | "Unknown";
    subject: string | null;
    thumbprint: string | null;
  }>;
}

export interface AutoTrackDecision {
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

export function instanceIdFor(product: ProductId, version: string, directory: string): string {
  const digest = createHash("sha1").update(toCompareKey(directory)).digest("hex").slice(0, 8);
  return `${product}@${version}@${digest}`;
}

/**
 * 判断一条扫描记录能否自动登记。
 * 静态条件（身份、冲突、自指）先判，IO 条件（目录、重解析点、主程序、签名）随后。
 */
export async function evaluateAutoTrack(
  record: InstallRecord,
  probe: AutoTrackProbe,
): Promise<AutoTrackDecision> {
  const directory = record.installLocation ?? "";
  const blockers: string[] = [];
  let executableRelativePath: string | null = null;
  let signerSubject: string | null = null;
  let signerThumbprint: string | null = null;

  const product = record.product;
  if (directory === "") blockers.push("扫描没有解析出安装路径");
  if (!product) blockers.push("无法确定产品归属");
  if (record.isManagerSelf) blockers.push("这是管理器自身目录");
  if (record.identity !== "identified") blockers.push("产品身份未确认");
  if (record.needsReview) blockers.push("存在身份冲突，需人工确认");

  if (blockers.length === 0) {
    if (await probe.isReparsePoint(directory)) blockers.push("安装目录是重解析点");
    else if (!(await probe.directoryExists(directory))) blockers.push("安装目录不存在");
  }

  if (blockers.length === 0 && product) {
    executableRelativePath = await probe.findExecutable(directory, product);
    if (!executableRelativePath) {
      blockers.push("目录内找不到主可执行文件");
    } else {
      const signature = await probe.signatureStatus(
        `${directory.replace(/[\\/]+$/, "")}\\${executableRelativePath}`,
      );
      if (signature.status !== "Valid") {
        blockers.push(`主程序签名状态为 ${signature.status === "Unknown" ? "未知" : "无效"}`);
      } else {
        signerSubject = signature.subject;
        signerThumbprint = signature.thumbprint;
      }
    }
  }

  return {
    recordId: record.id,
    product: (product ?? "workbuddy-cn") as ProductId,
    directory,
    version: record.displayVersion ?? record.identityCheck?.observedVersion ?? null,
    executableRelativePath,
    signerSubject,
    signerThumbprint,
    eligible: blockers.length === 0,
    blockers,
  };
}

export interface MergeInput {
  /** 本轮扫描产生的决策（含不合格项，仅用于展示） */
  decisions: AutoTrackDecision[];
  /** 现有登记（可能包含本工具部署的实例） */
  previous: ManagedInstance[];
  /** 扫描报告（用于取版本等补充信息） */
  report: ScanReport;
  now: () => string;
}

/**
 * 合并扫描结果与已有登记，返回新的登记列表（纯函数，幂等）。
 *  - deployed（本工具部署）：永远保留，不被扫描结果改写；
 *  - external（既有官方安装）：以本轮扫描中 eligible 的记录为准，同目录复用 instanceId；
 *  - 扫描中不再出现、或出现但不合格的 external 实例保留登记但不标记 verified，交由界面显示"无法管理"原因。
 */
export function mergeAutoTrackedInstances(input: MergeInput): ManagedInstance[] {
  const previous = input.previous;
  const byDirectory = new Map<string, ManagedInstance>();
  for (const item of previous) byDirectory.set(toCompareKey(item.directory), item);

  const next = new Map<string, ManagedInstance>();
  // 1) 本工具部署的实例原样保留
  for (const item of previous) {
    if (item.origin === "deployed") next.set(item.instanceId, item);
  }

  // 2) 既有安装：按本轮扫描重建/更新
  for (const decision of input.decisions) {
    if (!decision.eligible) continue;
    const version = decision.version ?? "unknown";
    const key = toCompareKey(decision.directory);
    const existing = byDirectory.get(key);
    const instanceId = existing?.instanceId ?? instanceIdFor(decision.product, version, decision.directory);
    const hasActiveElsewhere = [...next.values(), ...previous.filter((i) => i.product === decision.product)].some(
      (item) => item.product === decision.product && item.active,
    );
    next.set(instanceId, {
      instanceId,
      product: decision.product,
      version,
      directory: decision.directory,
      origin: "external",
      active: existing ? existing.active : !hasActiveElsewhere,
      source: existing?.source ?? "local-file",
      packageFile: existing?.packageFile ?? "",
      packageSha256: existing?.packageSha256 ?? "",
      packageFormat: existing?.packageFormat ?? "directory",
      signerSubject: decision.signerSubject ?? existing?.signerSubject ?? null,
      signerThumbprint: decision.signerThumbprint ?? existing?.signerThumbprint ?? null,
      installedAt: existing?.installedAt ?? input.now(),
      operationId: existing?.operationId ?? `auto-track-${decision.product}-${Date.now().toString(36)}`,
      verified: true,
      executableRelativePath: decision.executableRelativePath ?? existing?.executableRelativePath ?? null,
    });
  }

  // 3) 仍保留但本轮未出现的 external 实例（例如扫描暂时跳过）：保留登记，标记未核验
  for (const item of previous) {
    if (item.origin !== "external") continue;
    if (next.has(item.instanceId)) continue;
    if ([...next.values()].some((candidate) => toCompareKey(candidate.directory) === toCompareKey(item.directory))) {
      continue;
    }
    const noLongerInstalled = input.decisions.some(
      (decision) =>
        toCompareKey(decision.directory) === toCompareKey(item.directory) &&
        (decision.blockers.includes("安装目录不存在") || decision.blockers.includes("目录内找不到主可执行文件")),
    );
    if (noLongerInstalled) continue;
    next.set(item.instanceId, { ...item, verified: false });
  }

  // 4) 保证每个产品最多一个 active
  const list = [...next.values()];
  for (const product of ["workbuddy-cn", "workbuddy-ai"] as ProductId[]) {
    const group = list.filter((item) => item.product === product);
    const actives = group.filter((item) => item.active);
    if (actives.length === 0 && group.length > 0) {
      const chosen = group.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]!;
      const index = list.findIndex((item) => item.instanceId === chosen.instanceId);
      list[index] = { ...chosen, active: true };
    } else if (actives.length > 1) {
      const keep = actives.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]!;
      for (const item of actives) {
        if (item.instanceId === keep.instanceId) continue;
        const index = list.findIndex((candidate) => candidate.instanceId === item.instanceId);
        list[index] = { ...item, active: false };
      }
    }
  }
  return list;
}

/** 校验自动登记的前置条件（供测试直接调用） */
export function assertAutoTrackable(decision: AutoTrackDecision): Result<true> {
  if (decision.eligible) return ok(true);
  return fail("E_IDENTITY_UNKNOWN", `无法自动登记：${decision.blockers.join("；")}`, {
    blockers: decision.blockers,
  });
}
