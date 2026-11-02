import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fsp } from "node:fs";

/**
 * 只读扫描报告：启动打包/开发态的 Electron 主进程，执行一次 scan()，
 * 输出脱敏 JSON 后退出。不创建窗口、不写任何文件（日志目录除外）。
 */

const root = path.resolve(import.meta.dirname, "..");
const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [".", "--scan-report", "--no-sandbox", "--disable-gpu"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const timer = setTimeout(() => {
  console.error("扫描超时（60s）");
  child.kill();
  process.exit(1);
}, 60000);

child.on("exit", async (code) => {
  clearTimeout(timer);
  const start = stdout.indexOf("{");
  if (start < 0) {
    console.error("未取得扫描结果，退出码", code);
    if (stderr) console.error(stderr.slice(0, 2000));
    process.exit(1);
  }
  const json = stdout.slice(start);
  const outDir = path.join(root, "artifacts");
  await fsp.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `scan-report-${Date.now()}.json`);
  await fsp.writeFile(file, json, "utf8");
  const parsed = JSON.parse(json);
  const records = Array.isArray(parsed.records) ? parsed.records : [];
  console.log(`扫描完成：${records.length} 条记录，冲突 ${parsed.conflicts?.length ?? 0} 项`);
  for (const record of records) {
    const product = record.product ?? `线索:${record.productHint ?? "未知"}`;
    console.log(
      `- [${record.primarySource}] ${record.displayName} ${record.displayVersion ?? ""} → ${product} ` +
        `| 发现:${record.discovery} 身份:${record.identity}` +
        `${record.needsReview ? " 需人工确认" : ""}` +
        ` | 路径来源:${record.locationSource} 路径:${record.installLocation ?? "（待解析）"}`,
    );
  }
  for (const item of parsed.products ?? []) {
    console.log(`产品 ${item.product}: ${item.state}，安装 ${item.copyCount} 份，待解析登记 ${item.pendingPath.length} 条`);
  }
  console.log(`完整脱敏报告：${file}`);
  process.exit(code === 0 ? 0 : 1);
});
