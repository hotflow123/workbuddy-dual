import { spawn } from "node:child_process";
import { readFileSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");

const env = { ...process.env };
// 让主进程把“导出诊断”的原生目录对话框替换成固定目录，便于自动点击并读回报告
const exportDir = path.join(root, "artifacts", "e2e-diagnostics");
await fsp.rm(exportDir, { recursive: true, force: true }).catch(() => undefined);
await fsp.mkdir(exportDir, { recursive: true });
env.WB_E2E_EXPORT_DIR = exportDir;
env.WB_E2E_OCCUPANCY_PROBE = "1";
// 赞助商入口：主进程把实际 openExternal 的地址写入该文件，自动化里不真的弹出浏览器
const openLog = path.join(os.tmpdir(), `wb-e2e-open-${process.pid}-${Date.now()}.log`);
env.WB_E2E_OPEN_LOG = openLog;
// 某些宿主环境会注入 ELECTRON_RUN_AS_NODE，导致 electron.exe 以纯 Node 方式启动
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [".", "--e2e", "--no-sandbox", "--disable-gpu"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const TIMEOUT_MS = Number(process.env.WB_E2E_TIMEOUT_MS ?? 70000);
const timer = setTimeout(() => {
  console.error(`E2E 超时（${TIMEOUT_MS / 1000}s），强制结束`);
  child.kill();
  process.exit(1);
}, TIMEOUT_MS);

child.on("exit", (code) => {
  clearTimeout(timer);
  const line = stdout.split(/\r?\n/).find((l) => l.includes("E2E_RESULT"));
  if (!line) {
    console.error("未取得 E2E_RESULT，退出码", code);
    if (stderr) console.error(stderr);
    process.exit(1);
  }
  const payload = JSON.parse(line.slice(line.indexOf("{")));
  const problems = [];
  if (!payload.ok) problems.push("界面报告失败");
  if (process.env.WB_E2E_INSTALL && payload.ipcInstall?.ok !== true) {
    problems.push(`真实安装探针失败：${payload.ipcInstall?.code ?? "无错误码"} ${payload.ipcInstall?.message ?? "未返回安装结果"}`);
  }
  if (payload.productCards !== 2) problems.push(`产品卡片数量应为 2，实际 ${payload.productCards}`);
  if (payload.versionSelects !== 0) problems.push(`无官方来源时不应出现版本下拉框，实际 ${payload.versionSelects} 个`);
  if (String(payload.topbarText ?? "").includes("官方在线来源")) {
    problems.push("首屏顶栏不应出现全局「官方在线来源」提示");
  }
  if (payload.diagnosticsVisible !== false) problems.push("诊断面板默认不应展开");
  if (payload.installPathUi !== "1") problems.push("安装界面未提供目标路径输入（installPathUi 缺失）");
  if (payload.sourcesHeading !== "诊断") problems.push(`诊断面板标题应为“诊断”，实际“${payload.sourcesHeading}”`);
  if (payload.hasConfirmDialog !== true) problems.push("缺少确认弹窗节点");
  if (payload.hasProgressBar !== true) problems.push("缺少进度条节点");
  if (!payload.buildId || payload.buildId === "dev") problems.push("缺少构建标识 buildId（可能测的是旧构建）");
  const pkgVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  if (payload.appVersion !== pkgVersion) problems.push(`应用版本 ${payload.appVersion} 与 package.json ${pkgVersion} 不一致`);
  if (payload.assistedTables !== 0) problems.push(`主界面不应再有辅助启动表格，实际 ${payload.assistedTables} 行`);

  const occupancy = payload.occupancyProbe;
  if (!occupancy || occupancy.ok !== true) {
    problems.push(`占用判定回归失败：${JSON.stringify(occupancy)}`);
  } else {
    if (occupancy.rootStillRejected !== true) problems.push("盘符根目录应仍被拒绝（不能安装到磁盘根）");
    if (occupancy.dDriveProbe && occupancy.dDriveProbe.ok !== true) {
      problems.push(`D:////workbuddyCN 应放行，实际 ${occupancy.dDriveProbe.code}`);
    }
  }

  const sponsor = payload.sponsor;
  if (!sponsor) {
    problems.push("顶栏缺少赞助商链接节点");
  } else {
    if (sponsor.text !== "API赞助商：memefast.cc") {
      problems.push(`赞助商文案应为「API赞助商：memefast.cc」，实际「${sponsor.text}」`);
    }
    if (!String(payload.topbarText ?? "").includes("API赞助商：memefast.cc")) {
      problems.push("首屏顶栏文本未包含赞助商文案");
    }
    if (sponsor.tag !== "BUTTON") problems.push(`赞助商入口应为 button，实际 ${sponsor.tag}`);
    if (sponsor.href !== null || sponsor.target !== null) {
      problems.push("赞助商入口不应使用 <a href>/target 直接导航");
    }
    if (sponsor.focusable !== true) problems.push("赞助商入口应可用键盘聚焦");
    if (!String(sponsor.ariaLabel ?? "").includes("memefast.cc")) {
      problems.push("赞助商入口缺少可读的 aria-label");
    }
    if (sponsor.inTopbar !== true) problems.push("赞助商入口应位于顶栏内");
  }
  if (payload.sponsorApi?.hasOpenSponsor !== true) problems.push("preload 未暴露 openSponsor()");
  const sponsorOpened = Array.isArray(payload.sponsorOpened) ? payload.sponsorOpened : [];
  if (sponsorOpened.length < 2) {
    problems.push(`点击赞助商入口未触发主进程打开固定地址（记录 ${sponsorOpened.length} 条）`);
  }
  for (const url of sponsorOpened) {
    if (url !== "https://memefast.cc/") problems.push(`主进程打开了非白名单地址：${url}`);
  }
  if (payload.sponsorInjected?.ok !== true || payload.sponsorInjected?.url !== "https://memefast.cc/") {
    problems.push(`注入任意 URL 后未回到固定地址：${JSON.stringify(payload.sponsorInjected)}`);
  }

  const overlap = (a, b) =>
    Boolean(a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);
  const narrow = payload.narrowLayout;
  if (!narrow || !narrow.viewport) {
    problems.push("缺少窄窗口布局探针");
  } else {
    if (narrow.viewport.width > 560) problems.push(`窄窗口探针未生效，视口宽 ${narrow.viewport.width}`);
    if (narrow.scrollWidth > narrow.viewport.width + 1) {
      problems.push(`窄窗口出现横向溢出：${narrow.scrollWidth} > ${narrow.viewport.width}`);
    }
    if (!narrow.sponsor) {
      problems.push("窄窗口下赞助商入口消失");
    } else {
      if (narrow.sponsor.right > narrow.viewport.width + 1) problems.push("窄窗口下赞助商入口超出视口");
      if (overlap(narrow.sponsor, narrow.brand)) problems.push("窄窗口下赞助商入口压住品牌区");
      if (overlap(narrow.sponsor, narrow.version)) problems.push("窄窗口下赞助商入口压住版本号");
    }
    if (overlap(narrow.brand, narrow.meta)) problems.push("窄窗口下品牌区与右侧元信息重叠");
  }

  const diag = payload.diagnosticsExport;
  if (!diag || diag.error) {
    problems.push(`未取得导出的诊断报告：${diag?.error ?? "缺失"}`);
  } else {
    if (diag.schemaVersion !== 4) problems.push(`诊断 schemaVersion 应为 4，实际 ${diag.schemaVersion}`);
    if (diag.diagnosticsSchemaVersion !== 4) problems.push(`diagnosticsSchemaVersion 应为 4，实际 ${diag.diagnosticsSchemaVersion}`);
    if (diag.diagnosticsBuildId !== payload.buildId) {
      problems.push(`诊断 buildId ${diag.diagnosticsBuildId} 与运行状态 ${payload.buildId} 不一致`);
    }
    if (diag.hasAvailability !== false) problems.push("诊断不应再包含 availability");
    if (diag.hasAssisted !== false) problems.push("诊断不应再包含 assisted");
    if (diag.hasReadOnlyField !== false) problems.push("诊断的 scan 不应再有 readOnly 字段");
    if (diag.scanMode !== "read-only-scan") problems.push(`scan.mode 应为 read-only-scan，实际 ${diag.scanMode}`);
    if (diag.scanStatus !== "ok") problems.push(`导出时扫描应成功，实际 ${diag.scanStatus}`);
    const deployment = diag.deployment ?? {};
    for (const key of ["install", "update", "uninstall"]) {
      if (deployment[key] !== true) problems.push(`deploymentCapabilities.${key} 应为 true，实际 ${deployment[key]}`);
    }
    if (deployment.signatureGate !== false) problems.push("deploymentCapabilities.signatureGate 应为 false");
    if (typeof diag.managedCount !== "number") problems.push("诊断缺少 managedInstances");
    if (!Array.isArray(diag.correlation)) problems.push("诊断缺少 scanToManaged 关联结果");
    if (!["ok", "no-history"].includes(String(diag.historyState))) {
      problems.push(`historyStatus 异常：${diag.historyState}`);
    }
    if (diag.rawLength < 500) problems.push("诊断报告内容过短，可能未写入完整数据");
  }

  const forbidden = [
    "纳入管理",
    "接纳管理",
    "尚未纳入管理",
    "仅移除跟踪",
    "证据包",
    "辅助启动",
    "只读检测",
    "签名无效的安装包不允许启动",
  ];
  for (const word of forbidden) {
    if (String(payload.bodyText ?? "").includes(word)) problems.push(`主界面不应出现「${word}」`);
  }

  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  if (parts.length !== 2) problems.push(`产品区应有 2 个产品，实际 ${parts.length}`);
  for (const item of parts) {
    if (item.installButtons !== 1) problems.push(`${item.product} 缺少「安装新版本」按钮`);
    if (item.officialButtons !== 1) problems.push(`${item.product} 缺少「官网下载」按钮`);
    const actions = (item.actions ?? []).map((a) => a.action);
    if (!actions.includes("install")) problems.push(`${item.product} 动作列表缺少 install`);
    if (!actions.includes("official")) problems.push(`${item.product} 动作列表缺少 official`);
    if (actions.includes("adopt") || actions.includes("release")) {
      problems.push(`${item.product} 不应再有纳管/移除跟踪按钮`);
    }
    if (item.instanceRows > 0) {
      for (const required of ["launch", "update", "uninstall"]) {
        if (!actions.includes(required)) problems.push(`${item.product} 实例行缺少 ${required} 按钮`);
      }
      if (!String(item.summary ?? "").startsWith("已发现")) {
        problems.push(`${item.product} 汇总应为「已发现 N 个实例」，实际：${item.summary}`);
      }
    } else if (item.status === "absent") {
      if (item.summary !== "未安装") problems.push(`${item.product} 无实例时汇总应为「未安装」，实际：${item.summary}`);
    }
  }
  if (problems.length > 0) {
    console.error("E2E 失败：", problems.join("；"));
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
  console.log("E2E 通过：产品卡片 =", payload.productCards, "｜安装条目 =", payload.installItems);
  console.log("产品状态：", parts.map((p) => `${p.product}=${p.status}/${p.summary}/实例${p.instanceRows}`).join("；"));
  process.exit(0);
});
