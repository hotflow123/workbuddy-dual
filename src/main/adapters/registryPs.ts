import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RegistryEntry, RegistryReadResult, RegistryReader } from "../../core/scanner";

const run = promisify(execFile);

/**
 * 用 .NET 注册表 API 只读卸载登记（不依赖 reg.exe）。
 *
 * 背景：`reg.exe` 在部分受限环境（企业策略 / 沙箱）会被拦截，导致卸载按钮永远不可用。
 * 这里改用 PowerShell 调 `[Microsoft.Win32.RegistryKey]`，限定在三个卸载视图内，
 * 只读 DisplayName / DisplayVersion / InstallLocation / DisplayIcon / UninstallString 等值。
 *
 * 不使用 Get-ItemProperty（依赖 PowerShell 注册表 provider 与模块），只用 .NET 基础类型。
 */

const VIEWS: { name: RegistryEntry["view"]; hive: "LocalMachine" | "CurrentUser"; view: "Registry32" | "Registry64" }[] = [
  { name: "HKLM64", hive: "LocalMachine", view: "Registry64" },
  { name: "HKLM32", hive: "LocalMachine", view: "Registry32" },
  { name: "HKCU", hive: "CurrentUser", view: "Registry64" },
];

const VALUES = [
  "DisplayName",
  "DisplayVersion",
  "Publisher",
  "InstallLocation",
  "DisplayIcon",
  "UninstallString",
  "QuietUninstallString",
  "InstallSource",
  "SystemComponent",
  "WindowsInstaller",
  "EstimatedSize",
] as const;

const SCRIPT = `
$ErrorActionPreference = 'Continue'
$values = @(${VALUES.map((value) => `'${value}'`).join(",")})
$views = @(
  @{ name = 'HKLM64'; hive = 'LocalMachine'; view = 'Registry64' },
  @{ name = 'HKLM32'; hive = 'LocalMachine'; view = 'Registry32' },
  @{ name = 'HKCU';   hive = 'CurrentUser';  view = 'Registry64' }
)
$result = @()
$errors = @()
foreach ($v in $views) {
  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
      [Microsoft.Win32.RegistryHive]::$($v.hive),
      [Microsoft.Win32.RegistryView]::$($v.view))
    $uninstall = $base.OpenSubKey('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')
    if ($null -eq $uninstall) { continue }
    foreach ($name in $uninstall.GetSubKeyNames()) {
      $sub = $uninstall.OpenSubKey($name)
      if ($null -eq $sub) { continue }
      $row = [ordered]@{ view = $v.name; key = $name; values = [ordered]@{} }
      foreach ($valueName in $values) {
        $value = $sub.GetValue($valueName)
        if ($null -ne $value) { $row.values[$valueName] = [string]$value }
      }
      $result += $row
      $sub.Close()
    }
    $uninstall.Close()
    $base.Close()
  } catch {
    $errors += [ordered]@{ view = $v.name; reason = [string]$_.Exception.Message }
  }
}
[ordered]@{ entries = $result; errors = $errors } | ConvertTo-Json -Compress -Depth 6
`;

export interface RawRegistryPayload {
  entries: { view: string; key: string; values: Record<string, string> }[];
  errors: { view: string; reason: string }[];
}

/** 解析 PowerShell 输出的 JSON（容错：单条结果会被序列化成对象而不是数组） */
export function parseRegistryPayload(stdout: string): RawRegistryPayload {
  const text = stdout.trim();
  if (text === "") return { entries: [], errors: [] };
  const parsed = JSON.parse(text) as { entries?: unknown; errors?: unknown };
  const entries = Array.isArray(parsed.entries)
    ? (parsed.entries as RawRegistryPayload["entries"])
    : parsed.entries
      ? [parsed.entries as RawRegistryPayload["entries"][number]]
      : [];
  const errors = Array.isArray(parsed.errors)
    ? (parsed.errors as RawRegistryPayload["errors"])
    : parsed.errors
      ? [parsed.errors as RawRegistryPayload["errors"][number]]
      : [];
  return { entries, errors };
}

/** 把 PowerShell 结果映射成扫描器使用的 RegistryEntry（key 补全为完整登记路径） */
export function toRegistryEntries(payload: RawRegistryPayload): RegistryEntry[] {
  const viewOf = new Map(VIEWS.map((item) => [item.name, item]));
  const entries: RegistryEntry[] = [];
  for (const raw of payload.entries) {
    const view = viewOf.get(raw.view as RegistryEntry["view"]);
    if (!view) continue;
    const hivePath = view.hive === "LocalMachine" ? "HKEY_LOCAL_MACHINE" : "HKEY_CURRENT_USER";
    const viewSuffix = view.view === "Registry32" && view.hive === "LocalMachine" ? "WOW6432Node\\" : "";
    entries.push({
      view: view.name,
      key: `${hivePath}\\SOFTWARE\\${viewSuffix}Microsoft\\Windows\\CurrentVersion\\Uninstall\\${raw.key}`,
      values: raw.values ?? {},
    });
  }
  return entries;
}

export class PowerShellRegistryReader implements RegistryReader {
  constructor(private readonly timeoutMs = 30_000) {}

  async readUninstallEntries(): Promise<RegistryReadResult> {
    if (process.platform !== "win32") {
      return { entries: [], skipped: [{ source: "registry:uninstall", reason: "非 Windows 平台，跳过注册表读取" }] };
    }
    // 受限环境下 spawn 偶发 EPERM（并发子进程配额），重试两次再判定失败
    let stdout = "";
    let lastError: unknown = null;
    const shell = "powershell.exe";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await run(
          shell,
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
          { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: this.timeoutMs },
        );
        stdout = result.stdout;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!/EPERM|EAGAIN|EBUSY/i.test(String(error))) break;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    if (lastError) {
      return {
        entries: [],
        skipped: [
          {
            source: "registry:uninstall",
            reason: `注册表读取失败（.NET 适配器）：${lastError instanceof Error ? lastError.message.split("\n")[0] : "未知错误"}`,
          },
        ],
      };
    }
    try {
      const payload = parseRegistryPayload(stdout);
      return {
        entries: toRegistryEntries(payload),
        skipped: payload.errors.map((item) => ({ source: `registry:${item.view}`, reason: item.reason })),
      };
    } catch (error) {
      return {
        entries: [],
        skipped: [
          {
            source: "registry:uninstall",
            reason: `注册表读取失败（.NET 适配器）：${error instanceof Error ? error.message.split("\n")[0] : "未知错误"}`,
          },
        ],
      };
    }
  }
}

/**
 * 组合读取器：优先 .NET 适配器（不受 reg.exe 拦截影响），
 * 失败时回退 reg.exe。两者都失败才把原因报告给界面。
 */
export class CompositeRegistryReader implements RegistryReader {
  constructor(
    private readonly primary: RegistryReader,
    private readonly fallback: RegistryReader,
  ) {}

  async readUninstallEntries(): Promise<RegistryReadResult> {
    const first = await this.primary.readUninstallEntries();
    if (first.entries.length > 0) return first;
    const second = await this.fallback.readUninstallEntries();
    if (second.entries.length > 0) return second;
    return {
      entries: [],
      skipped: [...first.skipped, ...second.skipped].slice(0, 8),
    };
  }
}
