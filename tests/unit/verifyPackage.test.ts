import { describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyUnpacked } from "../../scripts/verify-package.mjs";

const ROOT_FILES = [
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

async function makeTree(root: string, options: { size?: number; skip?: string[] } = {}) {
  const size = options.size ?? 64;
  await fsp.mkdir(path.join(root, "locales"), { recursive: true });
  await fsp.mkdir(path.join(root, "resources"), { recursive: true });
  await fsp.mkdir(path.join(root, "resources", "7zip"), { recursive: true });
  await fsp.writeFile(path.join(root, "locales", "zh-CN.pak"), "x");
  await fsp.writeFile(path.join(root, "resources", "app.asar"), "asar");
  for (const name of ["7za.exe", "7za.dll", "7zxa.dll", "License.txt", "NOTICE.txt"]) {
    await fsp.writeFile(path.join(root, "resources", "7zip", name), "7zip");
  }
  await fsp.writeFile(path.join(root, "WorkBuddy Dual Edition Manager.exe"), "exe");
  for (const name of ROOT_FILES) {
    if (options.skip?.includes(name)) continue;
    await fsp.writeFile(path.join(root, name), Buffer.alloc(size, 1));
  }
}

describe("打包产物校验：Electron 运行时完整性", () => {
  it("完整产物通过", async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-verify-"));
    const dist = path.join(base, "electron");
    const unpacked = path.join(base, "win-unpacked");
    await makeTree(dist);
    await makeTree(unpacked);
    const result = await verifyUnpacked(unpacked, dist);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("缺少 ffmpeg.dll 时失败并指出具体文件", async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-verify-"));
    const dist = path.join(base, "electron");
    const unpacked = path.join(base, "win-unpacked");
    await makeTree(dist);
    await makeTree(unpacked, { skip: ["ffmpeg.dll"] });
    const result = await verifyUnpacked(unpacked, dist);
    expect(result.ok).toBe(false);
    expect(result.problems.join("；")).toContain("ffmpeg.dll");
  });

  it("运行时文件大小不一致时失败", async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-verify-"));
    const dist = path.join(base, "electron");
    const unpacked = path.join(base, "win-unpacked");
    await makeTree(dist, { size: 64 });
    await makeTree(unpacked, { size: 32 });
    const result = await verifyUnpacked(unpacked, dist);
    expect(result.ok).toBe(false);
    expect(result.problems.join("；")).toContain("大小不一致");
  });

  it("缺少 app.asar 或内置 7-Zip 文件时失败", async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-verify-"));
    const dist = path.join(base, "electron");
    const unpacked = path.join(base, "win-unpacked");
    await makeTree(dist);
    await makeTree(unpacked);
    await fsp.rm(path.join(unpacked, "resources", "app.asar"));
    await fsp.rm(path.join(unpacked, "resources", "7zip", "7za.exe"));
    const result = await verifyUnpacked(unpacked, dist);
    expect(result.ok).toBe(false);
    expect(result.problems.join("；")).toContain("app.asar");
    expect(result.problems.join("；")).toContain("resources/7zip/7za.exe");
  });
});
