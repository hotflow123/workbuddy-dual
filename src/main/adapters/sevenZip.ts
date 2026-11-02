import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ArchiveEntry } from "../../core/archiveSafety";

/**
 * 归档读取端口。实现必须只做「列出」与「解包到指定目录」，
 * 不得执行归档内的任何程序，也不得把路径交给 shell 拼接。
 */
export interface ArchivePort {
  list(archive: string): Promise<string[]>;
  /** 带大小/属性/目录标记的清单，用于解包前的安全校验 */
  listDetailed?(archive: string): Promise<ArchiveEntry[]>;
  extract(archive: string, destination: string): Promise<void>;
}

export interface ArchiveFailure {
  code: number | null;
  message: string;
}

function run(executable: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // 忽略
      }
      reject(new Error(`归档操作超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `归档命令失败（退出码 ${code ?? "未知"}）`));
    });
  });
}

/** 解析 `7za l -slt` 的输出，只取条目路径。 */
export function parseSevenZipListing(stdout: string): string[] {
  const entries: string[] = [];
  let inEntries = false;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("----------")) {
      inEntries = true;
      continue;
    }
    if (!inEntries) continue;
    if (line.startsWith("Path = ")) {
      const value = line.slice("Path = ".length).trim();
      if (value !== "") entries.push(value);
    }
  }
  return entries;
}

/** 解析 `7za l -slt` 的完整条目信息（路径 / 大小 / 属性 / 是否目录）。 */
export function parseSevenZipEntries(stdout: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let current: { path?: string; size?: number; attributes?: string; folder?: boolean } | null = null;
  let inEntries = false;

  const flush = () => {
    if (!current?.path) return;
    entries.push({
      path: current.path,
      size: current.size ?? 0,
      attributes: current.attributes ?? "",
      isDirectory: current.folder === true || (current.attributes ?? "").startsWith("D"),
    });
    current = null;
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("----------")) {
      inEntries = true;
      continue;
    }
    if (!inEntries) continue;
    if (line.startsWith("Path = ")) {
      flush();
      current = { path: line.slice("Path = ".length).trim() };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("Size = ")) {
      const value = Number(line.slice("Size = ".length).trim());
      current.size = Number.isFinite(value) ? value : 0;
    } else if (line.startsWith("Attributes = ")) {
      current.attributes = line.slice("Attributes = ".length).trim();
    } else if (line.startsWith("Folder = ")) {
      current.folder = line.slice("Folder = ".length).trim() === "+";
    }
  }
  flush();
  return entries;
}

export class SevenZipAdapter implements ArchivePort {  constructor(private readonly executable: string) {}

  static resolve(candidates: string[]): SevenZipAdapter | null {
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return new SevenZipAdapter(candidate);
    }
    return null;
  }

  /** 开发态与打包态的候选路径（打包时由 extraResources 放到 resources/ 下）。 */
  static defaultCandidates(appPath: string, resourcesPath: string | null): string[] {
    const resourceRoot = resourcesPath ?? path.join(appPath, "resources");
    return [
      path.join(resourceRoot, "7zip", "7za.exe"),
      "C:\\Program Files\\7-Zip\\7z.exe",
      "C:\\Program Files (x86)\\7-Zip\\7z.exe",
    ];
  }

  get path(): string {
    return this.executable;
  }

  async list(archive: string): Promise<string[]> {
    this.assertReady();
    const { stdout } = await run(this.executable, ["l", "-slt", "--", archive], 60_000);
    return parseSevenZipListing(stdout);
  }

  async listDetailed(archive: string): Promise<ArchiveEntry[]> {
    this.assertReady();
    const { stdout } = await run(this.executable, ["l", "-slt", "--", archive], 60_000);
    return parseSevenZipEntries(stdout);
  }

  async extract(archive: string, destination: string): Promise<void> {
    this.assertReady();
    await run(this.executable, ["x", "-y", `-o${destination}`, "--", archive], 10 * 60_000);
  }

  /** 解包器路径必须是绝对路径：否则 execFile 会抛 ERR_INVALID_ARG_TYPE（参数不合法: file） */
  private assertReady(): void {
    if (typeof this.executable !== "string" || this.executable.trim() === "" || !path.isAbsolute(this.executable)) {
      throw new Error("管理器内置解包组件缺失，请重新下载并解压管理器");
    }
  }

  /** 只解出指定条目（用于读取元数据，避免整包解压）。 */
  async extractEntry(archive: string, entry: string, destination: string): Promise<void> {
    this.assertReady();
    await run(this.executable, ["x", "-y", `-o${destination}`, "--", archive, entry], 10 * 60_000);
  }
}
