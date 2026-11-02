import { promises as fsp } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * 校验打包产物是否包含完整 Electron 运行时。
 *
 * 背景：electron-builder 会先清空输出目录再解包 Electron。如果上一次构建被中断
 * （例如旧进程占用 resources/app.asar），输出目录会留下**残缺**的 win-unpacked，
 * 缺 ffmpeg.dll / libEGL.dll 等文件，启动时报“找不到 ffmpeg.dll”。
 * 这个脚本把“产物是否完整”变成可判定的检查，避免残缺目录被当成交付物。
 *
 * 用法：
 *   node scripts/verify-package.mjs <win-unpacked 目录> [electron/dist 目录]
 */

const REQUIRED_ROOT_FILES = [
  "ffmpeg.dll",
  "libEGL.dll",
  "libGLESv2.dll",
  "d3dcompiler_47.dll",
  "vk_swiftshader.dll",
  "vulkan-1.dll",
  "vk_swiftshader_icd.json",
  "resources.pak",
  "icudtl.dat",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
];

/** Electron 原始运行时里“必须逐字节一致”的文件（exe 会被改名/改图标，不比较） */
const MUST_MATCH = REQUIRED_ROOT_FILES.filter((name) => name !== "vk_swiftshader_icd.json");

async function statSize(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.isFile() ? stat.size : -1;
  } catch {
    return -1;
  }
}

async function listRoot(directory) {
  try {
    return new Set(await fsp.readdir(directory));
  } catch {
    return new Set();
  }
}

export async function verifyUnpacked(unpackedDirectory, electronDistDirectory) {
  const problems = [];
  const root = path.resolve(unpackedDirectory);
  const dist = path.resolve(electronDistDirectory);

  const entries = await listRoot(root);
  if (entries.size === 0) {
    return { ok: false, problems: [`目录不存在或为空：${root}`], checked: 0 };
  }

  const exe = [...entries].find((name) => name.toLowerCase().endsWith(".exe"));
  if (!exe) problems.push("缺少主程序 exe");

  for (const name of REQUIRED_ROOT_FILES) {
    if (!entries.has(name)) {
      problems.push(`缺少 Electron 运行时文件：${name}`);
      continue;
    }
    if (MUST_MATCH.includes(name)) {
      const produced = await statSize(path.join(root, name));
      const expected = await statSize(path.join(dist, name));
      if (expected > 0 && produced !== expected) {
        problems.push(`运行时文件大小不一致：${name}（产物 ${produced} B，Electron ${expected} B）`);
      }
    }
  }

  const locales = path.join(root, "locales");
  const localeFiles = await fsp.readdir(locales).catch(() => []);
  if (localeFiles.filter((name) => name.endsWith(".pak")).length === 0) {
    problems.push("缺少 locales/*.pak");
  }

  const asar = path.join(root, "resources", "app.asar");
  if ((await statSize(asar)) <= 0) {
    problems.push("缺少 resources/app.asar（应用代码未打入）");
  }

  for (const name of ["7za.exe", "7za.dll", "7zxa.dll", "License.txt", "NOTICE.txt"]) {
    const sevenZipPart = path.join(root, "resources", "7zip", name);
    if ((await statSize(sevenZipPart)) <= 0) {
      problems.push(`缺少 resources/7zip/${name}`);
    }
  }

  return { ok: problems.length === 0, problems, checked: entries.size };
}

async function main() {
  const unpacked = process.argv[2] ?? "release-portable/win-unpacked";
  const dist = process.argv[3] ?? path.join("node_modules", "electron", "dist");
  const result = await verifyUnpacked(unpacked, dist);
  if (result.ok) {
    console.log(`打包校验通过：${unpacked}（${result.checked} 个根文件，Electron 运行时完整）`);
    return;
  }
  console.error(`打包校验失败：${unpacked}`);
  for (const problem of result.problems) console.error(` - ${problem}`);
  process.exitCode = 1;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
