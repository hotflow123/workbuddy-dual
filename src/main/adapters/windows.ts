import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AuthenticodeInfo } from "../../core/contracts";
import type { RegistryEntry, RegistryReadResult, RegistryReader } from "../../core/scanner";

const run = promisify(execFile);

const UNINSTALL_KEYS: { view: RegistryEntry["view"]; key: string; reg: "32" | "64" }[] = [
  { view: "HKLM64", key: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", reg: "64" },
  { view: "HKLM32", key: "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", reg: "32" },
  { view: "HKCU", key: "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", reg: "64" },
];

/**
 * 只读读取卸载登记项。使用固定参数调用 reg.exe，不接受任何用户拼接的命令。
 */
export class WindowsRegistryReader implements RegistryReader {
  async readUninstallEntries(): Promise<RegistryReadResult> {
    if (process.platform !== "win32") {
      return { entries: [], skipped: [{ source: "registry:uninstall", reason: "非 Windows 平台，跳过注册表读取" }] };
    }
    const entries: RegistryEntry[] = [];
    const skipped: { source: string; reason: string }[] = [];

    for (const item of UNINSTALL_KEYS) {
      let stdout: string;
      try {
        const result = await run("reg.exe", ["query", item.key, "/s", `/reg:${item.reg}`], {
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          timeout: 20000,
        });
        stdout = result.stdout;
      } catch (error) {
        skipped.push({
          source: `registry:${item.view}`,
          reason: error instanceof Error ? error.message.split("\n")[0] ?? "读取失败" : "读取失败",
        });
        continue;
      }
      entries.push(...parseRegQuery(stdout, item.view));
    }
    return { entries, skipped };
  }
}

export function parseRegQuery(stdout: string, view: RegistryEntry["view"]): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  let current: RegistryEntry | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "") continue;
    if (/^HKEY_/i.test(line)) {
      if (current) entries.push(current);
      current = { view, key: line, values: {} };
      continue;
    }
    if (!current) continue;
    const match = /^\s{2,}([^\s]+)\s+(REG_[A-Z_]+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const name = match[1];
    const data = match[3] ?? "";
    if (!name) continue;
    current.values[name] = data;
  }
  if (current) entries.push(current);
  return entries;
}

export interface WindowsFileInfo {
  authenticode: AuthenticodeInfo | null;
  versionInfo: { productName: string | null; fileDescription: string | null; fileVersion: string | null } | null;
}

const FILE_INFO_SCRIPT = `
$ErrorActionPreference = 'Continue'
# Electron 子进程环境下 PSModulePath 可能缺失，Get-AuthenticodeSignature 需要该模块
try { Import-Module Microsoft.PowerShell.Security -ErrorAction Stop } catch { }
$p = $env:WB_INSPECT_FILE
$sig = $null
try { $sig = Get-AuthenticodeSignature -LiteralPath $p } catch { $sig = $null }
$vi = $null
try { $vi = (Get-Item -LiteralPath $p).VersionInfo } catch { $vi = $null }

# 回退：直接用 .NET 读取签名证书并做离线链校验（不依赖 PowerShell 安全模块与网络吊销）
$status = if ($sig) { [string]$sig.Status } else { $null }
$subject = if ($sig -and $sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { $null }
$thumbprint = if ($sig -and $sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { $null }
$notAfter = if ($sig -and $sig.SignerCertificate) { [string]$sig.SignerCertificate.NotAfter.ToString('o') } else { $null }
if (-not $sig) {
  try {
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($p)
    if ($cert) {
      $cert2 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $cert
      $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
      $chain.ChainPolicy.RevocationMode = 'NoCheck'
      $built = $chain.Build($cert2)
      $status = if ($built) { 'Valid' } else { 'UnknownError' }
      $subject = [string]$cert2.Subject
      $thumbprint = [string]$cert2.Thumbprint
      $notAfter = [string]$cert2.NotAfter.ToString('o')
    }
  } catch {
    $status = $null
  }
}

$out = [ordered]@{
  status = $status
  subject = $subject
  thumbprint = $thumbprint
  notAfter = $notAfter
  chainOk = ($status -eq 'Valid')
  productName = if ($vi) { [string]$vi.ProductName } else { $null }
  fileDescription = if ($vi) { [string]$vi.FileDescription } else { $null }
  fileVersion = if ($vi) { [string]$vi.FileVersion } else { $null }
}
$out | ConvertTo-Json -Compress
`;

/**
 * 读取 Authenticode 与版本资源。路径通过环境变量传入，避免命令行注入。
 */
export async function inspectWindowsFile(file: string): Promise<WindowsFileInfo> {
  if (process.platform !== "win32") return { authenticode: null, versionInfo: null };
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", FILE_INFO_SCRIPT], {
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, WB_INSPECT_FILE: file },
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim()) as Record<string, string | boolean | null>;
    const status = typeof parsed["status"] === "string" ? parsed["status"] : null;
    const authenticode: AuthenticodeInfo | null = status
      ? {
          status,
          signerSubject: typeof parsed["subject"] === "string" ? parsed["subject"] : null,
          signerThumbprint: typeof parsed["thumbprint"] === "string" ? parsed["thumbprint"] : null,
          notAfter: typeof parsed["notAfter"] === "string" ? parsed["notAfter"] : null,
          chainOk: parsed["chainOk"] === true,
        }
      : null;
    return {
      authenticode,
      versionInfo: {
        productName: typeof parsed["productName"] === "string" && parsed["productName"] !== "" ? parsed["productName"] : null,
        fileDescription:
          typeof parsed["fileDescription"] === "string" && parsed["fileDescription"] !== "" ? parsed["fileDescription"] : null,
        fileVersion: typeof parsed["fileVersion"] === "string" && parsed["fileVersion"] !== "" ? parsed["fileVersion"] : null,
      },
    };
  } catch {
    return { authenticode: null, versionInfo: null };
  }
}
