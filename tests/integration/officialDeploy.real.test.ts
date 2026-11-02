import path from "node:path";
import { existsSync, promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { SevenZipAdapter } from "../../src/main/adapters/sevenZip";
import { deployPackage } from "../../src/core/managedInstall";
import { evaluateAppDirectory } from "../../src/core/appTree";
import { PathGuard } from "../../src/core/pathGuard";
import { NodeFsPort } from "../../src/main/adapters/fsPort";
import type { JournalStore } from "../../src/core/journal";
import type { PackageCheck } from "../../src/core/contracts";

/**
 * 真实官方包的**完整部署**验证（耗时，默认跳过）。
 *
 * 开启方式：先放包到 artifacts/official-packages/，再
 *   WB_FULL_DEPLOY=1 npx vitest run tests/integration/officialDeploy.real.test.ts
 *
 * 只解包 + 复制到临时管理根，不执行安装器、不触碰真实客户端目录，结束后不清理临时目录（便于人工核对）。
 */
const PACKAGE = path.join(process.cwd(), "artifacts", "official-packages", "workbuddy-cn-setup.exe");
const enabled = process.env["WB_FULL_DEPLOY"] === "1" && existsSync(PACKAGE);
const sevenZip = SevenZipAdapter.resolve(
  SevenZipAdapter.defaultCandidates(process.cwd(), null),
);
const maybe = enabled && sevenZip ? describe : describe.skip;

function memoryJournal(): JournalStore {
  const store = new Map<string, import("../../src/core/contracts").OperationRecord>();
  return {
    read: async (id) => store.get(id) ?? null,
    write: async (record) => {
      store.set(record.operationId, record);
    },
    list: async () => [...store.values()],
  };
}

function packageCheck(): PackageCheck {
  return {
    file: PACKAGE,
    sizeBytes: 441094104,
    sha256: "824de10f3196c501004f540eb84ee881292fef2f5df9fb3fc48af9ea5366c03c",
    authenticode: {
      status: "Valid",
      signerSubject: "CN=Tencent Technology (Shenzhen) Company Limited",
      signerThumbprint: "2241B013E2D6B9AAD7590E8056BF5E17CB1C795B",
      notAfter: null,
      chainOk: true,
    },
    productName: "WorkBuddy",
    productVersion: "5.8.3",
    verdict: "unknown",
    reasons: [],
  };
}

maybe("真实官方包完整部署（7za 解包 + 事务复制）", () => {
  it("部署出可用的完整应用目录", async () => {
    // 官方包解压后约 1.1GB，staging + target 需要 ~2.4GB：
    // 放到项目所在盘（artifacts 不入库），避免系统盘空间不足导致假失败
    const base = path.join(process.cwd(), "artifacts");
    await fsp.mkdir(base, { recursive: true });
    const root = await fsp.mkdtemp(path.join(base, "wb-official-deploy-"));
    const managementRoot = path.join(root, "managed");
    await fsp.mkdir(managementRoot, { recursive: true });
    const target = path.join(managementRoot, "WorkBuddy-CN", "versions", "5.8.3");
    const fsPort = new NodeFsPort();

    const result = await deployPackage(
      {
        product: "workbuddy-cn",
        version: "5.8.3",
        packagePath: PACKAGE,
        packageCheck: packageCheck(),
        operationId: "op-official-real",
        stagingDirectory: path.join(managementRoot, ".staging", "op-official-real"),
        targetDirectory: target,
        backupDirectory: path.join(managementRoot, "WorkBuddy-CN", "backups"),
      },
      {
        fs: fsPort,
        tree: fsPort,
        guard: new PathGuard({ managementRoot }),
        archive: sevenZip!,
        journal: memoryJournal(),
        now: () => new Date().toISOString(),
        verifyInstalled: async () => ({ ok: true }),
      },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);

    // 完整应用树：主程序 + 应用代码 + Electron runtime
    const tree = await evaluateAppDirectory(target, fsPort);
    expect(tree.ok, tree.ok ? "" : tree.error.message).toBe(true);
    expect(tree.ok && tree.value.mainExecutable).toBe("WorkBuddy.exe");
    expect(await fsPort.isFile(path.join(target, "resources", "app.asar"))).toBe(true);
    expect(await fsPort.isFile(path.join(target, "WorkBuddy.exe"))).toBe(true);
    expect(await fsPort.isFile(path.join(target, "ffmpeg.dll"))).toBe(true);

    console.log(`真实部署目录：${target}`);
  }, 900_000);
});
