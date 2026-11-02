import { constants as fsConstants, promises as nodeFsp } from "node:fs";
import path from "node:path";
import type { FsPort } from "../../core/transaction";
import type { FileProbe } from "../../core/identity";
import { findAsarEntry, parseAsarHeader } from "../../core/asar";

const MAX_ASAR_HEADER_BYTES = 32 * 1024 * 1024;

/**
 * Electron 会把 `*.asar` 当成虚拟目录拦截普通 fs 调用，直接 open 会得到
 * `ENOENT ... not found in app.asar`。读取归档原始字节必须走 `original-fs`。
 * 在纯 Node（单元测试）下没有该模块，自动回退到 node:fs。
 */
let cachedRawFs: typeof nodeFsp | null = null;
function rawFileSystem(): typeof nodeFsp {
  if (cachedRawFs) return cachedRawFs;
  try {
    const mod = require("original-fs") as { promises?: typeof nodeFsp };
    cachedRawFs = mod.promises ?? nodeFsp;
  } catch {
    cachedRawFs = nodeFsp;
  }
  return cachedRawFs;
}

// All file operations must bypass Electron's ASAR-aware fs patch. Otherwise
// fs.cp/stat can treat a client's app.asar as a virtual directory and fail.
const fsp = rawFileSystem();

export class NodeFsPort implements FsPort, FileProbe {
  async ensureDir(target: string): Promise<void> {
    await fsp.mkdir(target, { recursive: true });
  }

  async exists(target: string): Promise<boolean> {
    try {
      await fsp.lstat(target);
      return true;
    } catch {
      return false;
    }
  }

  async copyTree(from: string, to: string): Promise<void> {
    await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: false, dereference: false });
  }

  async removeTree(target: string): Promise<void> {
    await fsp.rm(target, { recursive: true, force: false, maxRetries: 3 });
  }

  async copyFile(from: string, to: string): Promise<void> {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
  }

  async rename(from: string, to: string): Promise<void> {
    // 同一卷内重命名是原子的；跨卷时 node 会抛 EXDEV，由上层转成明确错误，不做复制降级
    await fsp.rename(from, to);
  }

  async writeFile(target: string, data: string): Promise<void> {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}`;
    await fsp.writeFile(temporary, data, "utf8");
    await fsp.rename(temporary, target);
  }

  async readText(target: string): Promise<string | null> {
    try {
      return await fsp.readFile(target, "utf8");
    } catch {
      return null;
    }
  }

  async readTextLimited(target: string, maxBytes: number): Promise<string | null> {
    try {
      const stat = await fsp.stat(target);
      if (!stat.isFile() || stat.size > maxBytes) return null;
      return await fsp.readFile(target, "utf8");
    } catch {
      return null;
    }
  }

  async freeBytes(target: string): Promise<number> {
    try {
      const stat = await fsp.statfs(target);
      return stat.bavail * stat.bsize;
    } catch {
      return 0;
    }
  }

  async isReparsePoint(target: string): Promise<boolean> {
    try {
      const stat = await fsp.lstat(target);
      return stat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async isFile(target: string): Promise<boolean> {
    try {
      const stat = await fsp.stat(target);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * 读取 app.asar 内的文本文件（仅用于读产品元数据）。
   * 只读取头部 JSON 与目标条目的数据区，不整包加载。
   */
  async readAsarText(asarFile: string, entryPath: string, maxBytes: number): Promise<string | null> {
    const raw = rawFileSystem();
    let handle: Awaited<ReturnType<typeof raw.open>> | null = null;
    try {
      handle = await raw.open(asarFile, "r");
      const prefix = Buffer.alloc(16);
      const prefixRead = await handle.read(prefix, 0, 16, 0);
      if (prefixRead.bytesRead < 16) return null;

      const jsonLength = prefix.readUInt32LE(12);
      if (jsonLength === 0 || jsonLength > MAX_ASAR_HEADER_BYTES) return null;

      const jsonBytes = Buffer.alloc(jsonLength);
      const jsonRead = await handle.read(jsonBytes, 0, jsonLength, 16);
      if (jsonRead.bytesRead < jsonLength) return null;

      const header = parseAsarHeader(prefix, jsonBytes);
      if (!header) return null;

      const entry = findAsarEntry(header, entryPath);
      if (!entry || entry.unpacked || entry.size === 0 || entry.size > maxBytes) return null;

      const data = Buffer.alloc(entry.size);
      const dataRead = await handle.read(data, 0, entry.size, header.baseOffset + entry.offset);
      if (dataRead.bytesRead < entry.size) return null;
      return data.toString("utf8");
    } catch {
      return null;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }

  async realpath(target: string): Promise<string> {
    return fsp.realpath(target);
  }

  async isWritable(target: string): Promise<boolean> {
    try {
      await fsp.access(target, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  async listDirectory(directory: string): Promise<string[]> {
    return fsp.readdir(directory);
  }

  async stat(target: string): Promise<{ size: number; isDirectory: boolean } | null> {
    try {
      const stat = await fsp.stat(target);
      return { size: stat.size, isDirectory: stat.isDirectory() };
    } catch {
      return null;
    }
  }
}
