import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { verifyUnpacked } from "./verify-package.mjs";

/**
 * 打包携带版并**先校验再交付**。
 *
 * 直接 `electron-builder --config.directories.output=release-portable` 有两个坑：
 *  1. 旧进程占用 resources/app.asar 时，electron-builder 会先清空目录再失败，
 *     留下缺 ffmpeg.dll 的残缺 win-unpacked；
 *  2. 残缺目录看起来“有 exe”，容易被当成交付物，启动时报“找不到 ffmpeg.dll”。
 *
 * 这里改为：构建到临时目录 → 校验 Electron 运行时完整 → 覆盖式写入 release-portable。
 * 暂存目录放在系统临时目录，构建结束后自动清理，不在仓库里留半成品。
 */

const projectRoot = path.resolve(import.meta.dirname, "..");
const output = path.join(projectRoot, "release-portable");
const electronDist = path.join(projectRoot, "node_modules", "electron", "dist");
const builderCli = path.join(projectRoot, "node_modules", "electron-builder", "cli.js");

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`electron-builder 退出码 ${code}`))));
    child.on("error", reject);
  });
}

/**
 * 覆盖式复制：逐文件 copyFile，不删除目标。
 * 某些环境会给 fs.rm/unlink 加安全钩子，删除会失败；这里只写不删，
 * 完整性由 verifyUnpacked 兜底（缺文件/大小不符都会失败）。
 */
async function copyTree(source, target) {
  const entries = await fsp.readdir(source, { withFileTypes: true });
  await fsp.mkdir(target, { recursive: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await fsp.copyFile(from, to);
    }
  }
}

async function sha256(file) {
  const buffer = await fsp.readFile(file);
  return { size: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

async function main() {
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-pack-"));
  let ok = false;
  try {
    await runNode(
      [builderCli, "--win", "portable", "--x64", "--publish", "never", `--config.directories.output=${staging}`],
      projectRoot,
    );

    const unpacked = path.join(staging, "win-unpacked");
    const verified = await verifyUnpacked(unpacked, electronDist);
    if (!verified.ok) {
      console.error("打包校验失败，不交付：");
      for (const problem of verified.problems) console.error(` - ${problem}`);
      process.exitCode = 1;
      return;
    }

    const pkg = JSON.parse(await fsp.readFile(path.join(projectRoot, "package.json"), "utf8"));
    const artifactName = `workbuddy-dual-edition-manager-${pkg.version}-x64-portable.exe`;
    const built = path.join(staging, artifactName);
    const stats = await sha256(built);

    // 覆盖式写入：不删除旧目录，避免半途失败留下更残缺的交付物
    await fsp.mkdir(output, { recursive: true });
    await copyTree(unpacked, path.join(output, "win-unpacked"));
    await fsp.copyFile(built, path.join(output, artifactName));

    const delivered = await verifyUnpacked(path.join(output, "win-unpacked"), electronDist);
    if (!delivered.ok) {
      console.error("交付目录复检失败：");
      for (const problem of delivered.problems) console.error(` - ${problem}`);
      process.exitCode = 1;
      return;
    }

    console.log(`携带版已生成并校验：release-portable/${artifactName}`);
    console.log(`  体积：${stats.size} 字节`);
    console.log(`  SHA-256：${stats.sha256}`);
    console.log(`  win-unpacked：${verified.checked} 个根文件，Electron 运行时完整`);

    const stale = (await fsp.readdir(output)).filter(
      (entry) => entry.endsWith("-portable.exe") && entry !== artifactName,
    );
    if (stale.length > 0) console.log(`  注意：交付目录还有旧版本 exe：${stale.join("、")}`);
    ok = true;
  } finally {
    if (ok) {
      // 临时目录在系统 temp 下，清理不会触碰仓库或用户目录
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.error(`构建暂存目录保留在：${staging}（便于排查）`);
    }
  }
}

await main();
