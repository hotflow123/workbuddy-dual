import type {
  AppState,
  DeployOutcome,
  InstallRecord,
  ManagedInstance,
  ProductDiscovery,
  ProductId,
  ScanReport,
  UninstallOutcome,
} from "../core/contracts";
import type { AutoTrackDecisionSummary } from "../core/contracts";
import type { SettingsPayload, WorkBuddyApi } from "../shared/ipc";

declare global {
  interface Window {
    workbuddy: WorkBuddyApi;
  }
}

const api = window.workbuddy;

const LABELS: Record<ProductId, string> = {
  "workbuddy-cn": "国内版 WorkBuddy",
  "workbuddy-ai": "国际版 WorkBuddy AI",
};

const CLUE_LABELS: Record<string, string> = {
  registry: "卸载登记",
  shortcut: "快捷方式",
  process: "运行中进程",
  "common-location": "常见安装位置",
  "user-root": "指定目录",
  managed: "本工具受管目录",
};

let state: AppState | null = null;
let settings: SettingsPayload | null = null;
let scan: ScanReport | null = null;
let instances: ManagedInstance[] = [];
let autoTrack: AutoTrackDecisionSummary[] = [];
let busy = false;

/* ---------------------------------------------------------------- 工具 */

function q<T extends Element>(selector: string): T {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`缺少节点：${selector}`);
  return node as T;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normPath(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function toast(message: string, isError = false): void {
  const node = q<HTMLDivElement>("#toast");
  node.textContent = message;
  node.classList.toggle("is-error", isError);
  node.hidden = false;
  window.setTimeout(() => {
    node.hidden = true;
  }, isError ? 7000 : 3200);
}

function setBusy(on: boolean): void {
  busy = on;
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("button"))) {
    if (button.id === "modal-cancel") continue;
    button.disabled = on;
  }
  if (!on) renderProducts();
}

/* ---------------------------------------------------------------- 渲染 */

function renderHeader(): void {
  q<HTMLSpanElement>("#app-version").textContent = state
    ? `管理器 v${state.appVersion}${state.portable ? " · 携带版" : ""}`
    : "";
}

function shortSubject(subject: string | null): string {
  if (!subject) return "";
  const first = subject.split(",")[0]?.trim() ?? subject;
  return first.length > 48 ? `${first.slice(0, 48)}…` : first;
}

function productSummary(managed: number): string {
  if (managed > 0) return `已发现 ${managed} 个实例`;
  return "未安装";
}

function renderManagedRow(instance: ManagedInstance): string {
  const adopted = instance.origin === "external";
  return `
    <div class="instance" data-testid="instance-row" data-instance="${esc(instance.instanceId)}" data-origin="${instance.origin}">
      <div class="instance-main">
        <span class="instance-path">${esc(instance.directory)}</span>
        <span class="badge badge-neutral">${esc(instance.version)}</span>
        ${instance.active ? '<span class="badge badge-ok">默认</span>' : ""}
        <span class="badge ${adopted ? "badge-neutral" : "badge-ok"}">${adopted ? "官方安装" : "本工具部署"}</span>
        ${instance.verified ? "" : '<span class="badge badge-warn">未核验</span>'}
      </div>
      <div class="instance-actions">
        <button class="btn" type="button" data-action="launch" data-product="${instance.product}" data-instance-id="${esc(instance.instanceId)}">启动</button>
        <button class="btn" type="button" data-action="update" data-product="${instance.product}" data-instance-id="${esc(instance.instanceId)}">更新</button>
        <button class="btn btn-danger" type="button" data-action="uninstall" data-product="${instance.product}" data-instance-id="${esc(instance.instanceId)}">卸载</button>
      </div>
    </div>`;
}

function renderUnmanageableRow(decision: AutoTrackDecisionSummary): string {
  const reason = decision.blockers.join("；");
  return `
    <div class="instance instance-pending" data-testid="blocked-row" data-directory="${esc(decision.directory)}">
      <div class="instance-main">
        <span class="instance-path">${esc(decision.directory)}</span>
        <span class="badge badge-neutral">${esc(decision.version ?? "版本未知")}</span>
        <span class="badge badge-danger">无法管理</span>
      </div>
      <div class="instance-meta">
        <span class="reason-text">${esc(reason || "未通过校验")}</span>
      </div>
    </div>`;
}

function renderProduct(discovery: ProductDiscovery): string {
  const product = discovery.product;
  const managed = instances
    .filter((item) => item.product === product)
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  const managedDirs = new Set(managed.map((item) => normPath(item.directory)));
  const blocked = autoTrack.filter(
    (item) => item.product === product && !item.eligible && !managedDirs.has(normPath(item.directory)),
  );

  const rows = [...managed.map(renderManagedRow), ...blocked.map(renderUnmanageableRow)].join("");
  const body = rows !== "" ? rows : `<div class="empty-line">未检测到该产品的安装。</div>`;

  return `
    <article class="product-card" data-testid="product-card" data-product="${product}" data-status="${managed.length > 0 ? "managed" : blocked.length > 0 ? "blocked" : "absent"}">
      <div class="product-head">
        <div class="product-title">
          <h3>${esc(LABELS[product])}</h3>
          <span class="muted" data-testid="product-summary">${esc(productSummary(managed.length))}</span>
        </div>
      </div>
      <div class="product-body">${body}</div>
      <div class="product-actions">
        <button class="btn" type="button" data-action="install" data-product="${product}">安装新版本…</button>
        <button class="btn" type="button" data-action="official" data-product="${product}">官网下载</button>
        <span class="muted">从本地官方安装包部署到独立目录，不影响其它安装</span>
      </div>
    </article>`;
}

function renderProducts(): void {
  const container = q<HTMLElement>("#products");
  if (!scan) {
    container.innerHTML = `<div class="card muted">尚未扫描。</div>`;
    return;
  }
  container.innerHTML = scan.products.map(renderProduct).join("");
}

function renderDiagnostics(): void {
  // 摘要与导出诊断同一口径：登记实例、扫描发现、关联状态、最近一次失败
  const scannedDirs = (scan?.records ?? []).filter((record) => !record.isManagerSelf && record.installLocation);
  const registered = instances;
  const scannedKeys = new Set(
    scannedDirs.map((record) => (record.installLocation ?? "").replace(/[\\/]+$/, "").toLowerCase()),
  );
  const managedKeys = new Set(registered.map((item) => item.directory.replace(/[\\/]+$/, "").toLowerCase()));
  const matched = [...managedKeys].filter((key) => scannedKeys.has(key)).length;
  const missing = managedKeys.size - matched;
  const unmanaged = [...scannedKeys].filter((key) => !managedKeys.has(key)).length;
  const summary = [
    `管理器登记：${registered.length} 个实例`,
    `扫描发现：${scannedDirs.length} 个安装目录`,
    `关联：匹配 ${matched}｜登记但未找到 ${missing}｜发现但未登记 ${unmanaged}`,
  ];
  q<HTMLElement>("#diag-summary").innerHTML = summary
    .map((line) => `<div class="list-item">${esc(line)}</div>`)
    .join("");

  const sources = (scan?.sources ?? []).filter((source) => source.count > 0);
  q<HTMLElement>("#sources").innerHTML =
    sources.length === 0
      ? `<span class="muted">本次没有读取到线索。</span>`
      : sources
          .map(
            (source) =>
              `<span class="chip">${esc(CLUE_LABELS[source.kind] ?? source.kind)} · ${source.count} 条线索</span>`,
          )
          .join("");

  const allSkipped = scan?.skippedSources ?? [];
  const affecting = allSkipped.filter((item) => item.source !== "shortcuts:unrelated");
  const ignored = allSkipped.filter((item) => item.source === "shortcuts:unrelated");
  const items: { text: string; level: string }[] = [];
  for (const conflict of scan?.conflicts ?? []) items.push({ text: conflict, level: "is-warn" });
  // 进程线索被拒绝时给出可读来源名，避免用户以为这是“已发现实例”
  const SKIP_LABELS: Record<string, string> = {
    "processes:invalid-path": "无效进程路径（已忽略）",
    processes: "进程读取",
    shortcuts: "快捷方式",
  };
  for (const item of affecting) {
    items.push({ text: `${SKIP_LABELS[item.source] ?? item.source}：${item.reason}`, level: "" });
  }
  q<HTMLElement>("#skipped").innerHTML =
    items.length === 0
      ? `<div class="muted">没有影响检测的跳过项。</div>`
      : items.map((i) => `<div class="list-item ${i.level}">${esc(i.text)}</div>`).join("") +
        (ignored.length > 0
          ? `<div class="muted muted-block">${esc(ignored.map((i) => i.reason).join("；"))}</div>`
          : "");
  q<HTMLSpanElement>("#skipped-count").textContent = items.length > 0 ? `（${items.length}）` : "";

  const counted = new Set<string>();
  for (const discovery of scan?.products ?? []) {
    for (const record of [...discovery.installs, ...discovery.pendingPath]) counted.add(record.id);
  }
  const extras = (scan?.records ?? []).filter((record) => !counted.has(record.id));
  q<HTMLElement>("#candidates").innerHTML =
    extras.length === 0
      ? `<div class="muted">没有额外候选。</div>`
      : extras
          .map((record: InstallRecord) => {
            const reason = record.isManagerSelf
              ? "管理器自身的运行/打包目录，不是 WorkBuddy 客户端"
              : record.needsReview
                ? "身份与已知产品不匹配或元数据异常，需人工确认"
                : "未识别为 WorkBuddy 安装";
            return `<div class="list-item"><strong>${esc(record.displayName || "未命名候选")}</strong> · ${esc(record.installLocation ?? "（路径待解析）")}<br /><span class="muted">${esc(reason)}</span></div>`;
          })
          .join("");
  q<HTMLSpanElement>("#candidates-count").textContent = extras.length > 0 ? `（${extras.length}）` : "";

  const roots = settings?.userScanRoots ?? [];
  q<HTMLElement>("#roots").innerHTML =
    roots.length === 0
      ? `<div class="muted">尚未添加补充扫描目录（可选功能）。</div>`
      : roots
          .map(
            (root) =>
              `<div class="list-item">${esc(root)} <button class="btn btn-ghost" type="button" data-remove-root="${esc(root)}">移除</button></div>`,
          )
          .join("");
  q<HTMLSpanElement>("#roots-count").textContent = roots.length > 0 ? `（${roots.length}）` : "";

  q<HTMLSpanElement>("#scan-time").textContent = scan
    ? `最后扫描：${new Date(scan.scannedAt).toLocaleString()}`
    : "";
}

function renderAll(): void {
  renderHeader();
  renderProducts();
  renderDiagnostics();
}

/* ---------------------------------------------------------------- 结果与进度 */

function renderDeployResult(result: DeployOutcome, action: "安装" | "更新"): void {
  const box = q<HTMLElement>("#result");
  box.hidden = false;
  box.innerHTML = `
    <div class="card-head">
      <div>
        <h2>${action}完成</h2>
        <p class="muted">${esc(LABELS[result.instance.product])} ${esc(result.instance.version)}</p>
      </div>
      <span class="badge badge-ok" data-testid="result-outcome">${action}成功</span>
    </div>
    <div class="result-grid">
      <div><span class="muted">安装目录</span><div>${esc(result.instance.directory)}</div></div>
      <div><span class="muted">默认实例</span><div>${result.instance.active ? "是" : "否"}</div></div>
      <div><span class="muted">签名发布者</span><div>${esc(result.instance.signerSubject ?? "未取得")}</div></div>
      <div><span class="muted">包 SHA-256</span><div class="mono">${esc(result.instance.packageSha256.slice(0, 16))}…</div></div>
    </div>
    <ul class="result-notes">${result.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`;
}

function renderUninstallResult(result: UninstallOutcome): void {
  const box = q<HTMLElement>("#result");
  box.hidden = false;
  box.innerHTML = `
    <div class="card-head">
      <div>
        <h2>卸载完成</h2>
        <p class="muted">${esc(LABELS[result.product])} · ${esc(result.directory)}</p>
      </div>
      <span class="badge badge-ok" data-testid="result-outcome">卸载成功</span>
    </div>
    <ul class="result-notes">${result.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`;
}

function renderFailure(message: string): void {
  const box = q<HTMLElement>("#result");
  box.hidden = false;
  box.innerHTML = `
    <div class="card-head">
      <div><h2>操作未完成</h2><p class="muted">${esc(message)}</p></div>
      <span class="badge badge-danger" data-testid="result-outcome">失败</span>
    </div>`;
}

function setProgress(phase: string | null, percent = 0): void {
  const box = q<HTMLElement>("#progress");
  if (phase === null) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  q<HTMLSpanElement>("#progress-phase").textContent = phase;
  q<HTMLDivElement>("#progress-fill").style.width = `${Math.max(0, Math.min(100, percent))}%`;
  q<HTMLSpanElement>("#progress-percent").textContent = `${Math.round(percent)}%`;
}

/* ---------------------------------------------------------------- 确认弹窗 */

let pendingConfirm: (() => Promise<void>) | null = null;

function openModal(title: string, lines: string[], confirmText: string, onConfirm: () => Promise<void>): void {
  openModalHtml(
    title,
    lines.map((line) => `<div class="modal-line">${esc(line)}</div>`).join(""),
    confirmText,
    onConfirm,
  );
}

function openModalHtml(title: string, bodyHtml: string, confirmText: string, onConfirm: () => Promise<void>): void {
  q<HTMLHeadingElement>("#modal-title").textContent = title;
  q<HTMLDivElement>("#modal-body").innerHTML = bodyHtml;
  const confirm = q<HTMLButtonElement>("#modal-confirm");
  confirm.disabled = false;
  confirm.textContent = confirmText;
  pendingConfirm = onConfirm;
  q<HTMLDivElement>("#modal").hidden = false;
}

function closeModal(): void {
  q<HTMLDivElement>("#modal").hidden = true;
  pendingConfirm = null;
}

async function confirmModal(): Promise<void> {
  const action = pendingConfirm;
  if (!action) return;
  pendingConfirm = null;
  const button = q<HTMLButtonElement>("#modal-confirm");
  button.disabled = true;
  button.textContent = "执行中…";
  try {
    await action();
  } finally {
    // action 内部可能打开下一个确认框（例如“打开官网 → 选包 → 确认更新”），此时不要关掉它
    if (pendingConfirm === null) closeModal();
  }
}

/* ---------------------------------------------------------------- 数据刷新 */

async function refresh(): Promise<void> {
  const [stateResult, settingsResult, instanceResult] = await Promise.all([
    api.getState(),
    api.getSettings(),
    api.listInstances(),
  ]);
  if (stateResult.ok) state = stateResult.value;
  if (settingsResult.ok) settings = settingsResult.value;
  if (instanceResult.ok) instances = instanceResult.value;
  else if (state) instances = state.instances;
  autoTrack = state?.autoTrack ?? [];
  if (state?.scan) scan = state.scan;
  renderAll();
}

async function runScan(): Promise<void> {
  const button = q<HTMLButtonElement>("#btn-scan");
  button.disabled = true;
  button.textContent = "扫描中…";
  try {
    const result = await api.scan();
    if (!result.ok) {
      toast(`扫描失败：${result.error.message}`, true);
      return;
    }
    scan = result.value;
    await refresh();
  } finally {
    button.disabled = false;
    button.textContent = "重新扫描";
  }
}

/* ---------------------------------------------------------------- 动作 */

async function pickAndInspect(product: ProductId) {
  const file = await api.pickPackage();
  if (!file) return null;
  const check = await api.inspectPackage(file, product);
  return { file, check };
}

async function showInstallFlow(product: ProductId): Promise<void> {
  const picked = await pickAndInspect(product);
  if (!picked) return;
  if (!picked.check.ok) {
    toast(`安装包校验失败：${picked.check.error.message}`, true);
    return;
  }
  const check = picked.check.value;
  const version = check.productVersion ?? "未读取到";
  const folder = product === "workbuddy-cn" ? "WorkBuddy-CN" : "WorkBuddy-AI";
  const recommended =
    version === "未读取到"
      ? ""
      : [state?.managementRoot ?? "", folder, "versions", version].filter(Boolean).join("\\");

  const infoLines = [
    `来源：本地安装包（官方在线来源未配置）`,
    `安装包：${check.file}`,
    `版本：${version}`,
    `包内产品：${check.productName ?? "未读取到"}`,
    `签名：${check.authenticode?.status ?? "未知"}｜${check.authenticode?.signerSubject ?? "无发布者"}（仅信息，不阻断）`,
    `SHA-256：${check.sha256}`,
  ];
  const body = [
    ...infoLines.map((line) => `<div class="modal-line">${esc(line)}</div>`),
    `<div class="path-field">
      <label for="install-target">安装目录（最终目录，不是扫描目录或管理器数据目录）</label>
      <div class="path-row">
        <input id="install-target" data-testid="install-target" type="text" spellcheck="false"
          value="${esc(recommended)}" placeholder="例如 C:\\Apps\\WorkBuddy-CN" />
        <button id="btn-browse-target" class="btn" type="button">浏览…</button>
      </div>
      <p class="muted">可输入不存在的目录（由管理器创建）；已存在时必须为空目录。选择无写权限的目录会明确报错。</p>
    </div>`,
    `<div class="modal-line">将解包部署到该目录，不执行官方安装器；更新沿用实例原路径。</div>`,
  ].join("");

  openModalHtml(`安装 ${LABELS[product]}`, body, "开始安装", async () => {
    const input = document.getElementById("install-target") as HTMLInputElement | null;
    const targetDirectory = (input?.value ?? "").trim();
    if (targetDirectory === "") {
      toast("请先填写安装目录", true);
      return;
    }
    setBusy(true);
    setProgress("准备安装", 3);
    const result = await api.installManaged({ product, packagePath: picked.file, targetDirectory });
    setProgress(null);
    setBusy(false);
    if (!result.ok) {
      renderFailure(result.error.message);
      toast(`安装未完成：${result.error.message}`, true);
    } else {
      renderDeployResult(result.value, "安装");
      toast("安装完成");
    }
    await refresh();
  });

  // 浏览：选择父目录，再拼上推荐目录名，用户可继续编辑
  const browse = document.getElementById("btn-browse-target") as HTMLButtonElement | null;
  browse?.addEventListener("click", async () => {
    const parent = await api.pickDirectory();
    if (!parent) return;
    const input = document.getElementById("install-target") as HTMLInputElement | null;
    if (input) input.value = [parent.replace(/[\\/]+$/, ""), folder].join("\\");
  });
}

async function showUpdateFlow(product: ProductId, instanceId: string): Promise<void> {
  const current = instances.find((item) => item.instanceId === instanceId);
  if (!current) {
    toast("找不到该实例，请重新扫描", true);
    return;
  }
  const siteLabel = product === "workbuddy-cn" ? "workbuddy.cn" : "workbuddy.ai";
  openModal(
    `更新 ${LABELS[product]} ${current.version}`,
    [
      `目标实例：${current.directory}（${current.version}）`,
      `下一步会打开官方网站 ${siteLabel}。请下载对应 Windows 安装包，然后回到这里选择该文件。`,
      current.origin === "external"
        ? "管理器会把新版本替换到这个已接管的安装目录（先完整备份，失败自动回滚）。"
        : "管理器会把新版本替换到该实例目录（先完整备份，失败自动回滚），不会另装到别的目录。",
      "不会后台自动下载，也不使用任何猜测的下载地址。",
    ],
    "打开官网并选择安装包",
    async () => {
      const opened = await api.openOfficial({ product });
      if (!opened.ok) {
        toast(`打开官网失败：${opened.error.message}`, true);
        return;
      }
      const picked = await pickAndInspect(product);
      if (!picked) {
        toast("已取消选择安装包");
        return;
      }
      if (!picked.check.ok) {
        toast(`安装包校验失败：${picked.check.error.message}`, true);
        return;
      }
      const check = picked.check.value;
      openModal(
        `确认更新 ${LABELS[product]}：${current.version} → ${check.productVersion ?? "新版本"}`,
        [
          `目标实例：${current.directory}`,
          `安装包：${check.file}`,
          `包内产品：${check.productName ?? "未读取到"}`,
          `签名：${check.authenticode?.status ?? "未知"}｜${check.authenticode?.signerSubject?.split(",")[0] ?? "无发布者"}`,
          `SHA-256：${check.sha256}`,
          "将先完整备份现有程序目录，再做同卷目录替换；失败会自动回滚。",
          "请确认目标客户端已经退出，否则替换会被文件占用阻止。",
        ],
        "开始更新",
        async () => {
          setBusy(true);
          setProgress("准备更新", 3);
          const result = await api.updateManaged({
            product,
            instanceId,
            packagePath: picked.file,
          });
          setProgress(null);
          setBusy(false);
          if (!result.ok) {
            renderFailure(result.error.message);
            toast(`更新未完成：${result.error.message}`, true);
          } else {
            renderDeployResult(result.value, "更新");
            toast("更新完成");
          }
          await refresh();
        },
      );
    },
  );
}

async function openOfficialSite(product: ProductId): Promise<void> {
  const opened = await api.openOfficial({ product });
  if (!opened.ok) toast(`打开官网下载页失败：${opened.error.message}`, true);
}

/** 赞助商入口：只调用无参 IPC，URL 由主进程固定 */
async function openSponsorSite(): Promise<void> {
  const opened = await api.openSponsor();
  if (!opened.ok) toast(`打开赞助商链接失败：${opened.error.message}`, true);
}

function showUninstallFlow(product: ProductId, instanceId: string): void {
  const target = instances.find((item) => item.instanceId === instanceId);
  if (!target) {
    toast("找不到该实例，请重新扫描", true);
    return;
  }
  const adopted = target.origin === "external";
  openModal(
    `卸载 ${LABELS[product]} ${target.version}`,
    adopted
      ? [
          `安装目录：${target.directory}`,
          "将调用与该目录精确匹配的官方卸载程序（注册表中登记的 UninstallString）",
          "官方卸载器可能有它自己的确认步骤，请按提示完成",
          "本工具不删除目录、不清理用户数据；官方卸载器是否保留数据取决于它自身",
          "不会影响另一产品的任何安装",
        ]
      : [
          `安装目录：${target.directory}`,
          "将删除：本工具部署的程序文件（删除前自动备份到管理根目录的 backups 下）",
          "将保留：用户数据（配置、登录态、聊天记录），本工具从不访问这些目录",
          "不会影响另一产品的任何安装",
        ],
    adopted ? "运行官方卸载程序" : "确认卸载",
    async () => {
      setBusy(true);
      setProgress("移除程序目录", 10);
      const result = await api.uninstallManaged({ product, instanceId, confirmed: true });
      setProgress(null);
      setBusy(false);
      if (!result.ok) {
        renderFailure(result.error.message);
        toast(`卸载未完成：${result.error.message}`, true);
      } else {
        renderUninstallResult(result.value);
        toast("卸载完成，用户数据已保留");
      }
      await refresh();
    },
  );
}

async function launch(product: ProductId, instanceId: string): Promise<void> {
  const result = await api.launchInstance({ product, instanceId });
  toast(result.ok ? "已启动" : `启动失败：${result.error.message}`, !result.ok);
}

async function addRoot(): Promise<void> {
  const directory = await api.pickDirectory();
  if (!directory) return;
  const existing = settings?.userScanRoots ?? [];
  if (existing.includes(directory)) {
    toast("该目录已在补扫列表中");
    return;
  }
  const result = await api.updateSettings({ userScanRoots: [...existing, directory] });
  if (!result.ok) {
    toast(`添加失败：${result.error.message}`, true);
    return;
  }
  settings = result.value;
  await runScan();
}

async function removeRoot(directory: string): Promise<void> {
  const existing = settings?.userScanRoots ?? [];
  const result = await api.updateSettings({ userScanRoots: existing.filter((r) => r !== directory) });
  if (!result.ok) {
    toast(`移除失败：${result.error.message}`, true);
    return;
  }
  settings = result.value;
  await runScan();
}

/* ---------------------------------------------------------------- 绑定 */

function bindEvents(): void {
  q<HTMLButtonElement>("#btn-scan").addEventListener("click", () => void runScan());
  q<HTMLButtonElement>("#btn-add-root").addEventListener("click", () => void addRoot());
  q<HTMLButtonElement>("#btn-diagnostics").addEventListener("click", () => {
    renderDiagnostics();
    q<HTMLDivElement>("#diag").hidden = false;
  });
  q<HTMLButtonElement>("#diag-close").addEventListener("click", () => {
    q<HTMLDivElement>("#diag").hidden = true;
  });
  q<HTMLButtonElement>("#btn-export").addEventListener("click", async () => {
    const result = await api.exportDiagnostics();
    toast(result.ok ? `已导出：${result.value}` : `导出失败：${result.error.message}`, !result.ok);
  });
  q<HTMLButtonElement>("#modal-cancel").addEventListener("click", () => closeModal());
  q<HTMLButtonElement>("#modal-confirm").addEventListener("click", () => void confirmModal());
  q<HTMLButtonElement>("#sponsor-link").addEventListener("click", () => void openSponsorSite());

  document.body.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const removeButton = target.closest<HTMLElement>("[data-remove-root]");
    if (removeButton?.dataset["removeRoot"]) {
      void removeRoot(removeButton.dataset["removeRoot"]);
      return;
    }

    const action = target.closest<HTMLElement>("[data-action]");
    if (!action || busy) return;
    const kind = action.dataset["action"];
    const product = action.dataset["product"] as ProductId | undefined;
    const instanceId = action.dataset["instanceId"];
    if (!product) return;
    if (kind === "install") void showInstallFlow(product);
    else if (kind === "official") void openOfficialSite(product);
    else if (kind === "update" && instanceId) void showUpdateFlow(product, instanceId);
    else if (kind === "uninstall" && instanceId) showUninstallFlow(product, instanceId);
    else if (kind === "launch" && instanceId) void launch(product, instanceId);

  });

  api.onProgress((payload) => {
    if (payload.phase === undefined) return;
    setProgress(payload.phase, payload.percent ?? 0);
  });
}

async function main(): Promise<void> {
  document.body.dataset["installPathUi"] = "1";
  bindEvents();
  await refresh();
  await runScan();
}

void main();
