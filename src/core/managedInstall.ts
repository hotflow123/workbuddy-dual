import path from "node:path";
import { fail, ok, type OperationPlan, type PackageCheck, type PackageFormat, type ProductId, type Result } from "./contracts";
import { FileTransaction, type FsPort } from "./transaction";
import type { JournalStore } from "./journal";
import { PathGuard } from "./pathGuard";
import { classifyPackage, findAppRoot, findInnerArchive } from "./packageFormat";
import { validateArchiveEntries, validateExtractedTree, type ArchiveEntry, type TreeProbe } from "./archiveSafety";
import { evaluateAppDirectory, type AppTreeReport } from "./appTree";
import type { ArchivePort } from "../main/adapters/sevenZip";

/**
 * 受管部署管线：把官方安装包**解包**后部署到版本化目录。
 *
 * 为什么不是调用安装器：
 *  - 官方安装器是否支持静默参数与自定义目录**没有任何证据**，猜参数属于高危行为；
 *  - 解包部署不修改安装包、不重打包、不绕过签名，且能精确控制目标目录、天然支持 side-by-side 与回滚。
 *
 * 边界：只解包与复制文件；不执行归档内的任何程序。
 */

export interface DeployPaths {
  operationId: string;
  /** 解包与暂存目录（必须位于管理根目录内） */
  stagingDirectory: string;
  /** 最终安装目录（版本化目录，必须位于管理根目录内且不存在） */
  targetDirectory: string;
  /** 回滚备份目录 */
  backupDirectory: string;
}

export interface DeployInput {
  product: ProductId;
  version: string;
  packagePath: string;
  packageCheck: PackageCheck;
  operationId: string;
  stagingDirectory: string;
  targetDirectory: string;
  backupDirectory: string;
}

export interface DeployDeps {
  fs: FsPort;
  /** 解包后与部署后的树校验端口 */
  tree: TreeProbe & { isFile(target: string): Promise<boolean> };
  guard: PathGuard;
  archive: ArchivePort;
  journal: JournalStore;
  now: () => string;
  /** 部署后核验：读目标目录的产品元数据与可执行文件 */
  verifyInstalled: (directory: string, product: ProductId) => Promise<{ ok: boolean; reason?: string }>;
  progress?: (phase: string, percent: number) => void;
}

/** 卸载不需要解包能力，单独定义依赖，避免传假的归档实现。 */
export type UninstallDeps = Omit<DeployDeps, "archive">;

async function detailedEntries(archive: ArchivePort, target: string): Promise<ArchiveEntry[]> {
  if (archive.listDetailed) return archive.listDetailed(target);
  const paths = await archive.list(target);
  return paths.map((entry) => ({ path: entry, size: 0, attributes: "", isDirectory: entry.endsWith("/") }));
}

/**
 * 解包安装包并定位应用根目录，全程做必要保护：
 * 1) 归档条目路径/链接/体量（写盘前）；
 * 2) 解包结果不越界、无重解析点（写盘后）；
 * 3) 只确认存在主 exe 与 Electron runtime；不假设官方包内部 app.asar 布局。
 */
export async function extractApplicationTree(
  input: { packagePath: string; packageFormat: PackageFormat; workDirectory: string },
  archive: ArchivePort,
  tree: TreeProbe & { isFile(target: string): Promise<boolean> },
): Promise<Result<{ root: string; format: PackageFormat; appTree: AppTreeReport; uncompressedBytes: number }>> {
  const outerEntries = await archive.list(input.packagePath);
  if (outerEntries.length === 0) return fail("E_PACKAGE_FORMAT", "安装包为空或无法读取目录结构");

  const outerSafe = validateArchiveEntries(await detailedEntries(archive, input.packagePath));
  if (!outerSafe.ok) return outerSafe;
  let uncompressedBytes = outerSafe.value.totalBytes;

  const format = input.packageFormat === "unknown" ? classifyPackage(input.packagePath, outerEntries) : input.packageFormat;
  if (format === "unknown") return fail("E_PACKAGE_FORMAT", "无法识别的安装包格式（仅支持 NSIS / 7z / zip）");

  const outer = path.join(input.workDirectory, "outer");
  await archive.extract(input.packagePath, outer);
  const outerTree = await validateExtractedTree(outer, tree);
  if (!outerTree.ok) return outerTree;

  const innerName = findInnerArchive(outerEntries);
  if (innerName) {
    const innerArchive = path.join(outer, innerName);
    const innerSafe = validateArchiveEntries(await detailedEntries(archive, innerArchive));
    if (!innerSafe.ok) return innerSafe;
    uncompressedBytes = Math.max(uncompressedBytes, innerSafe.value.totalBytes);
    const inner = path.join(input.workDirectory, "app");
    await archive.extract(innerArchive, inner);
    const innerTree = await validateExtractedTree(inner, tree);
    if (!innerTree.ok) return innerTree;

    const innerEntries = await archive.list(innerArchive);
    // 解包完整性校验：用 listDetailed 的目录标记统计真实文件数，避免把目录算成文件
    const detailed = archive.listDetailed ? await archive.listDetailed(innerArchive).catch(() => null) : null;
    const expectedFiles = detailed
      ? detailed.filter((entry) => !entry.isDirectory).length
      : innerEntries.filter((entry) => !entry.endsWith("/")).length;
    if (expectedFiles > 0 && innerTree.ok && innerTree.value.files < expectedFiles * 0.9) {
      return fail(
        "E_PACKAGE_FORMAT",
        `解包不完整：归档内 ${expectedFiles} 个文件，实际解出 ${innerTree.value.files} 个（检查磁盘空间与 7-Zip 版本）`,
        { expectedFiles, actualFiles: innerTree.value.files, archive: innerArchive },
      );
    }
    const root = findAppRoot(innerEntries);
    const rootDir = path.join(inner, root ?? "");
    const report = await evaluateAppDirectory(rootDir, tree);
    if (!report.ok) return report;
    return ok({ root: rootDir, format, appTree: report.value, uncompressedBytes });
  }

  const root = findAppRoot(outerEntries);
  const rootDir = path.join(outer, root ?? "");
  const report = await evaluateAppDirectory(rootDir, tree);
  if (!report.ok) return report;
  return ok({ root: rootDir, format, appTree: report.value, uncompressedBytes });
}

export async function deployPackage(input: DeployInput, deps: DeployDeps): Promise<Result<{ operationId: string; directory: string }>> {
  const targetCheck = deps.guard.check(input.targetDirectory);
  if (!targetCheck.ok) return fail("E_PATH_REJECTED", `安装目录被拒绝：${targetCheck.error.message}`);
  const stagingCheck = deps.guard.check(path.join(input.stagingDirectory, "probe"));
  if (!stagingCheck.ok) return fail("E_PATH_REJECTED", `暂存目录被拒绝：${stagingCheck.error.message}`);
  if (await deps.fs.exists(input.targetDirectory)) {
    return fail("E_TARGET_EXISTS", "目标安装目录已存在，拒绝覆盖（请换一个目录或先卸载该实例）");
  }

  deps.progress?.("解包安装包", 10);
  await deps.fs.ensureDir(input.stagingDirectory);
  let extracted: Awaited<ReturnType<typeof extractApplicationTree>>;
  try {
    extracted = await extractApplicationTree(
      // packageFormat 传 unknown：由归档条目列表自行判定，避免依赖扩展名
      { packagePath: input.packagePath, packageFormat: "unknown", workDirectory: input.stagingDirectory },
      deps.archive,
      deps.tree,
    );
  } catch (error) {
    await deps.fs.removeTree(input.stagingDirectory).catch(() => undefined);
    return fail("E_PACKAGE_FORMAT", `安装包解包失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
  if (!extracted.ok) {
    // 解包失败：清理同卷暂存目录，不留半成品
    await deps.fs.removeTree(input.stagingDirectory).catch(() => undefined);
    return extracted;
  }

  deps.progress?.("校验解包内容", 40);
  const plan: OperationPlan = {
    operationId: input.operationId,
    kind: "install",
    product: input.product,
    createdAt: deps.now(),
    expectedProduct: input.product,
    source: { kind: "local-file", path: input.packagePath },
    version: input.version,
    signerSubject: input.packageCheck.authenticode?.signerSubject ?? null,
    sha256: input.packageCheck.sha256,
    requiredFreeSpaceBytes: Math.max(0, extracted.value.uncompressedBytes) * 2 + 200 * 1024 * 1024,
    backupDirectory: input.backupDirectory,
    steps: [
      {
        index: 1,
        action: "create",
        target: input.targetDirectory,
        source: extracted.value.root,
        reason: "把所选安装包解出的文件复制到安装目录",
        reversible: true,
      },
      {
        index: 2,
        action: "verify",
        target: input.targetDirectory,
        source: null,
        reason: "确认部署目录中存在客户端主程序",
        reversible: false,
      },
    ],
    rollbackSteps: [
      {
        index: 1,
        action: "delete",
        target: input.targetDirectory,
        source: null,
        reason: "删除本次部署产生的目录",
        reversible: false,
      },
    ],
    deletionTargets: [],
    blockers: [],
    notes: [
      `安装包：${input.packagePath}`,
      `SHA-256：${input.packageCheck.sha256}`,
      `格式：${extracted.value.format}`,
      `解压后约 ${Math.round(extracted.value.uncompressedBytes / 1024 / 1024)} MB`,
    ],
  };

  const transaction = new FileTransaction({
    journal: deps.journal,
    guard: deps.guard,
    fs: deps.fs,
    now: deps.now,
    verifyInstalled: deps.verifyInstalled,
  });
  const controller = new AbortController();
  deps.progress?.("部署到目标目录", 60);
  let applied: Awaited<ReturnType<typeof transaction.apply>>;
  try {
    applied = await transaction.apply(plan, controller.signal);
  } catch (error) {
    await deps.fs.removeTree(input.stagingDirectory).catch(() => undefined);
    return fail("E_IO", `部署失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
  // 安装只把最终应用树留在目标目录；outer/app 等临时解包目录不参与管理。
  await deps.fs.removeTree(input.stagingDirectory).catch(() => undefined);
  if (!applied.ok) return applied;

  deps.progress?.("部署完成", 95);
  return ok({ operationId: input.operationId, directory: input.targetDirectory });
}

/** 卸载受管实例：先备份程序目录，再删除；用户数据不在删除范围内。 */
export async function removeManagedDirectory(
  input: { product: ProductId; directory: string; backupDirectory: string; operationId: string },
  deps: UninstallDeps,
): Promise<Result<{ operationId: string }>> {
  const checked = deps.guard.check(input.directory);
  if (!checked.ok) return fail("E_PATH_REJECTED", `卸载目录被拒绝：${checked.error.message}`);
  if (!(await deps.fs.exists(input.directory))) {
    return fail("E_NOT_FOUND", "安装目录已不存在");
  }
  const plan: OperationPlan = {
    operationId: input.operationId,
    kind: "uninstall",
    product: input.product,
    createdAt: deps.now(),
    expectedProduct: input.product,
    source: { kind: "local-file", path: input.directory },
    version: "",
    signerSubject: null,
    sha256: null,
    requiredFreeSpaceBytes: 0,
    backupDirectory: input.backupDirectory,
    steps: [
      {
        index: 1,
        action: "backup",
        target: input.directory,
        source: null,
        reason: "卸载前备份程序目录（保留回滚点）",
        reversible: true,
      },
      {
        index: 2,
        action: "delete",
        target: input.directory,
        source: null,
        reason: "删除本工具部署的程序目录（不含用户数据）",
        reversible: true,
      },
    ],
    rollbackSteps: [
      {
        index: 1,
        action: "restore",
        target: input.directory,
        source: null,
        reason: "从备份恢复程序目录",
        reversible: false,
      },
    ],
    deletionTargets: [input.directory],
    blockers: [],
    notes: ["只删除本工具部署的程序目录；用户数据目录不在删除范围内"],
  };
  const transaction = new FileTransaction({
    journal: deps.journal,
    guard: deps.guard,
    fs: deps.fs,
    now: deps.now,
    verifyInstalled: deps.verifyInstalled,
  });
  deps.progress?.("移除受管程序目录", 20);
  const applied = await transaction.apply(plan, new AbortController().signal);
  if (!applied.ok) return applied;
  deps.progress?.("卸载完成", 95);
  return ok({ operationId: input.operationId });
}


/**
 * 原位更新：把新版本真正替换到用户选定的那个实例目录。
 *
 * 关键约束：
 *  - 先完整备份旧目录，再解包新版本，最后用**同卷目录重命名**交换，避免“先删旧版再装新版”的窗口；
 *  - 新版本先复制到目标同级的 `<dir>.new-<操作号>`，与目标同卷，交换才是原子的；
 *  - 任何一步失败都尝试把旧目录换回来，并如实返回失败原因；
 *  - 用户数据目录不在备份/替换范围内（只处理程序目录本身）。
 */
export async function replaceInstanceInPlace(
  input: {
    operationId: string;
    product: ProductId;
    version: string;
    packagePath: string;
    packageCheck: PackageCheck;
    /** 用户选定的实例目录（可能是管理根内，也可能是已接管的官方安装目录） */
    targetDirectory: string;
    stagingDirectory: string;
    backupDirectory: string;
  },
  deps: DeployDeps,
): Promise<
  Result<{ directory: string; backupDirectory: string; retiredDirectory: string; preservedFiles: string[] }>
> {
  const targetCheck = deps.guard.check(input.targetDirectory);
  if (!targetCheck.ok) return fail("E_PATH_REJECTED", `更新目标被拒绝：${targetCheck.error.message}`);
  if (!(await deps.fs.exists(input.targetDirectory))) {
    return fail("E_NOT_FOUND", "要更新的实例目录不存在");
  }

  const backup = path.join(input.backupDirectory, `${input.operationId}-before`);
  deps.progress?.("备份现有版本", 8);
  await deps.fs.ensureDir(input.backupDirectory);
  if (await deps.fs.exists(backup)) await deps.fs.removeTree(backup);
  await deps.fs.copyTree(input.targetDirectory, backup);

  deps.progress?.("解包新版本", 25);
  await deps.fs.ensureDir(input.stagingDirectory);
  const extracted = await extractApplicationTree(
    { packagePath: input.packagePath, packageFormat: "unknown", workDirectory: input.stagingDirectory },
    deps.archive,
    deps.tree,
  );
  if (!extracted.ok) return extracted;

  const sibling = `${input.targetDirectory}.new-${input.operationId}`;
  const retired = `${input.targetDirectory}.old-${input.operationId}`;
  deps.progress?.("准备同卷替换", 55);
  if (await deps.fs.exists(sibling)) await deps.fs.removeTree(sibling);
  if (await deps.fs.exists(retired)) await deps.fs.removeTree(retired);
  await deps.fs.copyTree(extracted.value.root, sibling);

  // 官方 NSIS 安装目录里的卸载器/版本标记/MSIX 不在内层 app-64.7z 里，
  // 直接整目录替换会把它们弄丢（更新后就无法卸载）。这里从旧目录保留这些维护文件。
  const preservePattern = /^(uninstall.*\.exe|uninstall.*\.exe\.config|version|.*\.msix)$/i;
  const preservedFiles: string[] = [];
  const existing = new Set(await deps.tree.listDirectory(sibling).catch(() => [] as string[]));
  const sourceEntries = await deps.tree.listDirectory(input.targetDirectory).catch(() => [] as string[]);
  for (const name of sourceEntries) {
    if (!preservePattern.test(name)) continue;
    if (existing.has(name)) continue;
    await deps.fs.copyFile(path.join(input.targetDirectory, name), path.join(sibling, name));
    preservedFiles.push(name);
  }

  deps.progress?.("切换程序目录", 70);
  let swapped = false;
  try {
    await deps.fs.rename(input.targetDirectory, retired);
    await deps.fs.rename(sibling, input.targetDirectory);
    swapped = true;
  } catch (error) {
    // 交换失败：尽量把旧目录换回原位
    if (await deps.fs.exists(retired)) {
      if (await deps.fs.exists(input.targetDirectory)) {
        await deps.fs.removeTree(sibling).catch(() => undefined);
      } else {
        await deps.fs.rename(retired, input.targetDirectory).catch(() => undefined);
      }
    }
    return fail("E_IO", `目录替换失败：${error instanceof Error ? error.message : "未知错误"}`, {
      target: input.targetDirectory,
      backup,
    });
  }

  deps.progress?.("校验新版本", 88);
  const verified = await deps.verifyInstalled(input.targetDirectory, input.product);
  if (!verified.ok) {
    // 校验失败：新目录挪开，旧目录换回
    const failed = `${input.targetDirectory}.failed-${input.operationId}`;
    if (await deps.fs.exists(failed)) await deps.fs.removeTree(failed);
    await deps.fs.rename(input.targetDirectory, failed).catch(() => undefined);
    const restored = await deps.fs.rename(retired, input.targetDirectory).then(
      () => true,
      () => false,
    );
    return fail("E_VALIDATION", `更新后校验失败，已${restored ? "回滚" : "尝试回滚但失败"}：${verified.reason}`, {
      target: input.targetDirectory,
      backup,
      failedDirectory: failed,
      swapped,
    });
  }

  deps.progress?.("更新完成", 96);
  return ok({
    directory: input.targetDirectory,
    backupDirectory: backup,
    retiredDirectory: retired,
    preservedFiles,
  });
}


