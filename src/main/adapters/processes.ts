import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { ProcessProvider } from "../../core/scanner";
import {
  parseProcessOutput,
  resolveProcessCandidate,
  type ProcessReject,
  type ProcessRow,
} from "../../core/processPath";

const run = promisify(execFile);

/**
 * 只读读取运行中进程的可执行文件路径。
 * 用固定脚本 + WMI 过滤，只取名字含 workbuddy 的进程，不导出整张进程表。
 *
 * 这里只负责“取到路径”，是否构成安装线索由 `resolveProcessCandidate` 判定：
 * 盘符根、目录路径、卸载器/修复器、临时解包目录都会被拒绝并给出原因。
 */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$items = Get-CimInstance Win32_Process -Filter "Name LIKE '%workbuddy%'" |
  Select-Object Name, ExecutablePath
$items | ConvertTo-Json -Compress
`;

export interface ProcessListResult {
  accepted: ProcessRow[];
  rejected: ProcessReject[];
}

export class WindowsProcessReader implements ProcessProvider {
  constructor(private readonly tempDirectories: string[] = [os.tmpdir()]) {}

  async listDetailed(): Promise<ProcessListResult> {
    if (process.platform !== "win32") return { accepted: [], rejected: [] };
    let stdout: string;
    try {
      const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch {
      return { accepted: [], rejected: [] };
    }

    const rows = parseProcessOutput(stdout);
    const accepted: ProcessRow[] = [];
    const rejected: ProcessReject[] = [];
    for (const row of rows) {
      const resolution = resolveProcessCandidate(row, { tempDirectories: this.tempDirectories });
      if (resolution.ok) accepted.push({ path: resolution.value.path, name: resolution.value.name });
      else rejected.push(resolution.reject);
    }
    return { accepted, rejected };
  }

  async list(): Promise<ProcessRow[]> {
    const result = await this.listDetailed();
    return result.accepted;
  }
}
