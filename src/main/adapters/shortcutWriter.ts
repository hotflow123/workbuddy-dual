import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ShortcutSpec } from "../../core/shortcutSpec";

const run = promisify(execFile);

export interface ShortcutPort {
  /** 桌面目录（尊重 OneDrive/重定向，不硬编码路径） */
  desktopDirectory(): Promise<string | null>;
  create(spec: ShortcutSpec): Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
  remove(file: string): Promise<{ ok: boolean; reason?: string }>;
}

/** 用 PowerShell 的 WScript.Shell 创建 .lnk，避免引入额外依赖。 */
function encodeCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function powershell(script: string): Promise<{ stdout: string; stderr: string }> {
  const result = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand(script)],
    { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
  );
  return { stdout: result.stdout, stderr: result.stderr };
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class WindowsShortcutWriter implements ShortcutPort {
  async desktopDirectory(): Promise<string | null> {
    if (process.platform !== "win32") return null;
    try {
      const { stdout } = await powershell(`[Environment]::GetFolderPath('Desktop')`);
      const value = stdout.trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  async create(spec: ShortcutSpec): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    if (process.platform !== "win32") return { ok: false, reason: "仅支持 Windows" };
    const desktop = await this.desktopDirectory();
    if (!desktop) return { ok: false, reason: "无法获取桌面目录" };
    const file = path.join(desktop, spec.name);

    const iconLine = spec.icon ? `$s.IconLocation = ${psQuote(spec.icon)}` : "";
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ws = New-Object -ComObject WScript.Shell",
      `$s = $ws.CreateShortcut(${psQuote(file)})`,
      `$s.TargetPath = ${psQuote(spec.target)}`,
      `$s.WorkingDirectory = ${psQuote(spec.workingDirectory)}`,
      iconLine,
      "$s.Save()",
      "Write-Output 'OK'",
    ]
      .filter((line) => line !== "")
      .join("\n");

    try {
      await powershell(script);
      const exists = await fsp
        .stat(file)
        .then((stat) => stat.isFile())
        .catch(() => false);
      if (!exists) return { ok: false, reason: "快捷方式文件未生成" };
      return { ok: true, path: file };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async remove(file: string): Promise<{ ok: boolean; reason?: string }> {
    if (process.platform !== "win32") return { ok: false, reason: "仅支持 Windows" };
    try {
      await fsp.unlink(file);
      return { ok: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: true };
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
