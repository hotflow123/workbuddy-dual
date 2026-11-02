import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { promises as fsp } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist");
// 每次构建都从干净目录开始，禁止复用过期 bundle
await rm(out, { recursive: true, force: true }).catch(() => undefined);
const BUILD_ID = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const BUILD_TIME = new Date().toISOString();

async function main() {
  await fsp.rm(out, { recursive: true, force: true });
  await fsp.mkdir(path.join(out, "renderer"), { recursive: true });

  const common = {
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
    bundle: true,
    sourcemap: true,
    logLevel: "info",
    target: "node20",
  };

  await build({
    ...common,
    entryPoints: [path.join(root, "src/main/index.ts")],
    outfile: path.join(out, "main/index.js"),
    platform: "node",
    format: "cjs",
    // original-fs 是 Electron 运行时内置模块，必须在打包时保持 external
    external: ["electron", "original-fs"],
  });

  await build({
    ...common,
    entryPoints: [path.join(root, "src/preload/index.ts")],
    outfile: path.join(out, "preload/index.js"),
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });

  await build({
    ...common,
    target: "chrome128",
    entryPoints: [path.join(root, "src/renderer/renderer.ts")],
    outfile: path.join(out, "renderer/renderer.js"),
    platform: "browser",
    format: "iife",
  });

  await fsp.copyFile(path.join(root, "src/renderer/index.html"), path.join(out, "renderer/index.html"));
  await fsp.copyFile(path.join(root, "src/renderer/styles.css"), path.join(out, "renderer/styles.css"));

  await fsp.mkdir(path.join(out, "config"), { recursive: true });
  for (const file of ["evidence.json", "releases.json"]) {
    await fsp.copyFile(path.join(root, "config", file), path.join(out, "config", file));
  }

  console.log("build ok → dist/");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
