import os from "node:os";
import path from "node:path";
import { existsSync, promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { SevenZipAdapter } from "../../src/main/adapters/sevenZip";
import { classifyPackage, findAppRoot, findInnerArchive } from "../../src/core/packageFormat";
import { evaluateAppTree } from "../../src/core/appTree";
import { validateArchiveEntries } from "../../src/core/archiveSafety";
import { findAsarEntry, parseAsarHeader } from "../../src/core/asar";

/**
 * 真实官方安装包只读验证。
 *
 * 前置：把官方安装包放到 `artifacts/official-packages/` 下（默认不随仓库分发）。
 * 只做「列出 / 安全校验 / 完整树判定 / 读元数据」，**不执行安装器、不解包整个包**。
 * 缺失包时整组跳过，不会伪造通过。
 */
const PACKAGE_DIR = path.join(process.cwd(), "artifacts", "official-packages");
const CANDIDATES = ["workbuddy-cn-setup.exe", "workbuddy-ai-setup.exe"]
  .map((name) => path.join(PACKAGE_DIR, name))
  .filter((file) => existsSync(file));

const sevenZip = SevenZipAdapter.resolve(
  SevenZipAdapter.defaultCandidates(process.cwd(), null),
);

const maybe = CANDIDATES.length > 0 && sevenZip ? describe : describe.skip;

async function readAsarFile(asarPath: string, entry: string): Promise<string | null> {
  const handle = await fsp.open(asarPath, "r");
  try {
    const prefix = Buffer.alloc(16);
    await handle.read(prefix, 0, 16, 0);
    const jsonLength = prefix.readUInt32LE(12);
    if (jsonLength === 0 || jsonLength > 32 * 1024 * 1024) return null;
    const jsonBytes = Buffer.alloc(jsonLength);
    await handle.read(jsonBytes, 0, jsonLength, 16);
    const header = parseAsarHeader(prefix, jsonBytes);
    if (!header) return null;
    const found = findAsarEntry(header, entry);
    if (!found || found.unpacked || found.size === 0) return null;
    const data = Buffer.alloc(found.size);
    await handle.read(data, 0, found.size, header.baseOffset + found.offset);
    return data.toString("utf8");
  } finally {
    await handle.close();
  }
}

maybe("真实官方安装包（只读）", () => {
  for (const packageFile of CANDIDATES) {
    const label = path.basename(packageFile);

    it(`${label}：能列出条目并通过归档安全校验`, async () => {
      const entries = await sevenZip!.listDetailed(packageFile);
      // 7-Zip 24 显示 NSIS 外壳视图（十几个条目 + 内层 app-64.7z）；
      // 7za 21 显示尾部 7z 的扁平视图（数千条目）。两者都是合法视图。
      expect(entries.length).toBeGreaterThan(5);
      const validation = validateArchiveEntries(entries);
      expect(validation.ok, validation.ok ? "" : validation.error.message).toBe(true);
    }, 120_000);

    it(`${label}：格式识别正确，且能找到应用内容（直接目录或内层归档）`, async () => {
      const paths = await sevenZip!.list(packageFile);
      const format = classifyPackage(packageFile, paths);
      expect(["nsis", "7z"]).toContain(format);
      const inner = findInnerArchive(paths);
      const appRoot = findAppRoot(paths);
      // NSIS 视图：应用在 $PLUGINSDIR/app-64.7z 内；扁平视图：直接就是应用根
      expect(inner !== null || appRoot !== null).toBe(true);
      if (inner) expect(inner.toLowerCase()).toContain("app-64.7z");
    }, 120_000);

    it(`${label}：扁平视图下完整应用树判定通过（主 exe + 应用代码 + runtime）`, async () => {
      const paths = await sevenZip!.list(packageFile);
      if (findInnerArchive(paths) !== null) {
        // NSIS 外壳视图：完整树在内层归档里，由 officialDeploy 测试覆盖
        return;
      }
      const report = evaluateAppTree(paths);
      expect(report.ok, `缺少：${report.missing.join("、")}`).toBe(true);
      expect(report.mainExecutable?.toLowerCase()).toContain("workbuddy");
      expect(report.hasAsar || report.hasAppDir).toBe(true);
      expect(report.runtimeFiles.length).toBeGreaterThan(0);
    }, 120_000);

    it(`${label}：包内 app.asar 携带可读的产品元数据`, async () => {
      const paths = await sevenZip!.list(packageFile);
      const inner = findInnerArchive(paths);
      const work = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-official-meta-"));

      let asarPath: string;
      if (inner) {
        // NSIS 外壳：先取出内层 app-64.7z，再从中取 resources/app.asar
        await sevenZip!.extractEntry(packageFile, inner, work);
        const innerFile = path.join(work, inner);
        const appDir = path.join(work, "app");
        await fsp.mkdir(appDir, { recursive: true });
        await sevenZip!.extractEntry(innerFile, "resources\\app.asar", appDir);
        asarPath = path.join(appDir, "resources", "app.asar");
      } else {
        await sevenZip!.extractEntry(packageFile, "resources\\app.asar", work);
        asarPath = path.join(work, "resources", "app.asar");
      }

      const text = await readAsarFile(asarPath, "package.json");
      expect(text).not.toBeNull();
      const meta = JSON.parse(text!) as { name?: string; productName?: string; version?: string };
      expect(meta.version ?? "").toMatch(/^\d+\.\d+\.\d+/);
      expect((meta.productName ?? meta.name ?? "").toLowerCase()).toContain("workbuddy");
    }, 300_000);
  }
});
