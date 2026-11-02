import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { SevenZipAdapter } from "../../src/main/adapters/sevenZip";
import { deployPackage } from "../../src/core/managedInstall";
import { PathGuard } from "../../src/core/pathGuard";
import { NodeFsPort } from "../../src/main/adapters/fsPort";
import type { JournalStore } from "../../src/core/journal";
import type { PackageCheck } from "../../src/core/contracts";

const run = promisify(execFile);

/**
 * 真实文件操作：用随包分发的 7za.exe 造一个合法的 7z 包，再走完整部署管线。
 * 不涉及任何真实客户端安装包，也不执行归档内的程序。
 */
const sevenZip = SevenZipAdapter.resolve([
  path.join(process.cwd(), "node_modules", "7zip-bin", "win", "x64", "7za.exe"),
]);

const maybe = sevenZip ? describe : describe.skip;

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
    file: "E:\\pkgs\\fixture.7z",
    sizeBytes: 1024,
    sha256: "c".repeat(64),
    authenticode: {
      status: "Valid",
      signerSubject: "CN=Tencent Technology (Shenzhen) Company Limited",
      signerThumbprint: "ABC",
      notAfter: null,
      chainOk: true,
    },
    productName: "WorkBuddy",
    productVersion: "9.9.9",
    verdict: "unknown",
    reasons: [],
  };
}

maybe("真实解包部署（7za.exe + 临时目录）", () => {
  it("解出 resources/app 并部署到版本化目录", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-real-deploy-"));
    const tree = path.join(root, "tree");
    await fsp.mkdir(path.join(tree, "resources", "app"), { recursive: true });
    await fsp.writeFile(
      path.join(tree, "resources", "app", "package.json"),
      JSON.stringify({ productName: "WorkBuddy", version: "9.9.9" }, null, 2),
      "utf8",
    );
    await fsp.writeFile(path.join(tree, "WorkBuddy.exe"), "stub-executable", "utf8");
    await fsp.writeFile(path.join(tree, "resources", "app.asar"), "stub-asar", "utf8");
    await fsp.writeFile(path.join(tree, "ffmpeg.dll"), "stub-dll", "utf8");
    await fsp.writeFile(path.join(tree, "libEGL.dll"), "stub-dll", "utf8");

    const archiveFile = path.join(root, "fixture.7z");
    await run(sevenZip!.path, ["a", "-t7z", archiveFile, path.join(tree, "*")], { windowsHide: true });

    const managementRoot = path.join(root, "managed");
    await fsp.mkdir(managementRoot, { recursive: true });
    const target = path.join(managementRoot, "WorkBuddy-CN", "versions", "9.9.9");
    const fsPort = new NodeFsPort();

    const result = await deployPackage(
      {
        product: "workbuddy-cn",
        version: "9.9.9",
        packagePath: archiveFile,
        packageCheck: packageCheck(),
        operationId: "op-real-1",
        stagingDirectory: path.join(managementRoot, ".staging", "op-real-1"),
        targetDirectory: target,
        backupDirectory: path.join(managementRoot, "WorkBuddy-CN", "backups"),
      },
      {
        fs: fsPort,
        tree: fsPort,
        guard: new PathGuard({ managementRoot }),
        archive: sevenZip!,
        journal: memoryJournal(),
        now: () => "2026-10-18T00:00:00.000Z",
        verifyInstalled: async (directory) =>
          (await fsPort.isFile(path.join(directory, "resources", "app", "package.json")))
            ? { ok: true }
            : { ok: false, reason: "缺少元数据" },
      },
    );

    expect(result.ok).toBe(true);
    expect(await fsPort.isFile(path.join(target, "WorkBuddy.exe"))).toBe(true);
    const meta = JSON.parse(await fsp.readFile(path.join(target, "resources", "app", "package.json"), "utf8")) as {
      version: string;
    };
    expect(meta.version).toBe("9.9.9");
  }, 60_000);
});
