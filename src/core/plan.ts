import path from "node:path";
import {
  fail,
  ok,
  PRODUCT_LABELS,
  type CapabilityState,
  type InstallSelection,
  type OperationKind,
  type OperationPlan,
  type PackageCheck,
  type PlannedStep,
  type ProductId,
  type ProductProfile,
  type Result,
  type ScanReport,
} from "./contracts";
import { PathGuard, backupsDirectory, productFolderName, versionDirectory } from "./pathGuard";

/**
 * 预演（dry-run）计划生成。计划就是“用户确认的合同”：
 * 每个将读取/创建/替换/备份的精确路径都必须列出来，否则不允许执行。
 */

export interface PlanInput {
  operationId: string;
  kind: OperationKind;
  selection: InstallSelection;
  profile: ProductProfile;
  capability: CapabilityState;
  managementRoot: string;
  packageCheck: PackageCheck | null;
  scan: ScanReport | null;
  /** 暂存目录（已校验的安装文件） */
  stagingDirectory: string;
  now: string;
}

function capabilityBlocker(kind: OperationKind, capability: CapabilityState): string | null {
  if (kind === "install" && !capability.installAutomation) {
    return "官方安装器尚未在虚拟机中验证可稳定安装到独立路径，一键安装被阻断";
  }
  if (kind === "update" && !capability.updateAutomation) {
    return "官方更新链路尚未验证可安全接管，一键更新被阻断";
  }
  if (kind === "uninstall" && !capability.uninstallAutomation) {
    return "官方卸载器尚未验证会保留用户数据且不触及另一产品，一键卸载被阻断";
  }
  return null;
}

export function buildPlan(input: PlanInput): Result<OperationPlan> {
  const { kind, selection, profile, capability, managementRoot, packageCheck, scan } = input;
  const product: ProductId = selection.product;
  const blockers: string[] = [];
  const notes: string[] = [];

  const gate = capabilityBlocker(kind, capability);
  if (gate) blockers.push(gate);

  if (selection.version.trim() === "") blockers.push("未选择版本");
  if (!profile.verifiedVersions.includes(selection.version)) {
    blockers.push(`版本 ${selection.version} 不在该产品的已验证版本清单中`);
  }

  const guard = new PathGuard({ managementRoot });
  const expectedTarget = versionDirectory(managementRoot, product, selection.version || "0.0.0");
  const targetCheck = guard.check(selection.targetDirectory || expectedTarget);
  if (!targetCheck.ok) {
    blockers.push(`安装路径被拒绝：${targetCheck.error.message}`);
  }

  if (kind !== "uninstall" && packageCheck && packageCheck.verdict !== "valid") {
    blockers.push("安装包未通过签名/身份校验");
  }
  if (kind !== "uninstall" && !packageCheck) {
    blockers.push("尚未选择并校验安装包");
  }

  const productRecords = scan?.records.filter((r) => r.product === product) ?? [];
  for (const record of productRecords) {
    if (record.identity === "conflict" || record.needsReview) {
      blockers.push(`发现冲突安装记录，需人工确认：${record.displayName}`);
    }
  }

  const targetDirectory = targetCheck.ok ? targetCheck.value.absolute : expectedTarget;
  const steps: PlannedStep[] = [];
  const rollbackSteps: PlannedStep[] = [];
  const deletionTargets: string[] = [];
  let index = 1;
  const push = (step: Omit<PlannedStep, "index">) => {
    steps.push({ ...step, index: index++ });
  };

  if (kind === "install" || kind === "update") {
    if (packageCheck) {
      push({ action: "read", target: packageCheck.file, source: null, reason: "读取并再次校验安装包哈希与签名", reversible: true });
      notes.push(`安装包 SHA-256：${packageCheck.sha256}`);
      notes.push(`签名发布者：${packageCheck.authenticode?.signerSubject ?? "未取得"}`);
    }
    push({ action: "backup", target: targetDirectory, source: null, reason: "备份同版本目录（若存在）", reversible: true });
    push({
      action: "create",
      target: targetDirectory,
      source: path.join(input.stagingDirectory, productFolderName(product)),
      reason: "把校验通过的暂存文件复制到版本目录",
      reversible: true,
    });
    push({ action: "verify", target: targetDirectory, source: null, reason: "核对安装后产品身份与可执行文件版本", reversible: false });
    rollbackSteps.push({
      index: 1,
      action: "restore",
      target: targetDirectory,
      source: null,
      reason: "从备份恢复旧版本目录",
      reversible: false,
    });
  }

  if (kind === "uninstall") {
    const managed = productRecords.find((r) => r.managedByTool);
    if (!managed || !managed.installLocation) {
      blockers.push("该产品不是由本工具管理的安装，一键卸载不可用（仅提供官方人工卸载指引）");
    } else {
      const managedGuard = guard.check(managed.installLocation);
      if (!managedGuard.ok) {
        blockers.push("受管目录不在管理根目录内，拒绝删除");
      } else {
        deletionTargets.push(managedGuard.value.absolute);
        push({ action: "verify", target: managedGuard.value.absolute, source: null, reason: "删除前复验产品身份与签名", reversible: false });
        push({ action: "backup", target: managedGuard.value.absolute, source: null, reason: "删除前备份程序文件（不含用户数据）", reversible: true });
        push({ action: "delete", target: managedGuard.value.absolute, source: null, reason: "仅删除本工具受管的程序目录", reversible: true });
      }
    }
  }

  const requiredFreeSpaceBytes =
    kind === "uninstall" ? 0 : Math.max(0, (packageCheck?.sizeBytes ?? 0) * 2 + 50 * 1024 * 1024);

  const plan: OperationPlan = {
    operationId: input.operationId,
    kind,
    product,
    createdAt: input.now,
    expectedProduct: product,
    source: selection.source,
    version: selection.version,
    signerSubject: packageCheck?.authenticode?.signerSubject ?? null,
    sha256: packageCheck?.sha256 ?? null,
    requiredFreeSpaceBytes,
    backupDirectory: backupsDirectory(managementRoot, product),
    steps,
    rollbackSteps,
    deletionTargets,
    blockers,
    notes,
  };
  return ok(plan);
}

const ACTION_LABELS: Record<PlannedStep["action"], string> = {
  read: "读取",
  create: "创建",
  replace: "替换",
  delete: "删除",
  backup: "备份",
  restore: "恢复",
  verify: "校验",
  launch: "启动",
};

export function renderPlanText(plan: OperationPlan): string {
  const lines: string[] = [];
  lines.push(`操作编号：${plan.operationId}`);
  lines.push(`操作类型：${plan.kind}　产品：${PRODUCT_LABELS[plan.product]}`);
  lines.push(`目标版本：${plan.version}`);
  lines.push(`包来源：${plan.source.kind === "official" ? "官方在线安装包" : `本地安装包 ${plan.source.path}`}`);
  lines.push(`签名发布者：${plan.signerSubject ?? "未取得"}`);
  lines.push(`包 SHA-256：${plan.sha256 ?? "未取得"}`);
  lines.push(`预计需要空间：${(plan.requiredFreeSpaceBytes / 1024 / 1024).toFixed(1)} MB`);
  lines.push(`备份目录：${plan.backupDirectory ?? "无"}`);
  lines.push("");
  lines.push("将执行的步骤：");
  for (const step of plan.steps) {
    lines.push(`  ${step.index}. [${ACTION_LABELS[step.action]}] ${step.target}`);
    lines.push(`     原因：${step.reason}`);
  }
  if (plan.rollbackSteps.length > 0) {
    lines.push("");
    lines.push("失败时的回滚步骤：");
    for (const step of plan.rollbackSteps) {
      lines.push(`  - [${ACTION_LABELS[step.action]}] ${step.target}：${step.reason}`);
    }
  }
  lines.push("");
  lines.push(`删除清单：${plan.deletionTargets.length === 0 ? "无（不会删除任何文件）" : plan.deletionTargets.join(", ")}`);
  if (plan.blockers.length > 0) {
    lines.push("");
    lines.push("阻断项（存在阻断项时禁止执行）：");
    for (const blocker of plan.blockers) lines.push(`  ! ${blocker}`);
  }
  if (plan.notes.length > 0) {
    lines.push("");
    lines.push("备注：");
    for (const note of plan.notes) lines.push(`  · ${note}`);
  }
  return lines.join("\n");
}
