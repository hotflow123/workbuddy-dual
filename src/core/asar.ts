/**
 * 最小化的 asar 读取：只解析头部 JSON 与单个文件的偏移，用于读取
 * `resources/app.asar` 内的 `product.json` / `package.json`。
 *
 * asar 结构：
 *   0..3   uint32 = 4（pickle 长度字段）
 *   4..7   uint32 = 头部 pickle 大小
 *   8..11  uint32 = 4（字符串长度字段）
 *   12..15 uint32 = JSON 字节数
 *   16..   JSON 头部
 *   数据区起点 = 8 + 头部 pickle 大小
 */

export interface AsarEntry {
  size: number;
  /** 相对数据区起点的偏移（asar 以字符串存储） */
  offset: number;
  unpacked: boolean;
}

export interface AsarHeader {
  baseOffset: number;
  /** 扁平化后的路径 → 条目 */
  entries: Map<string, AsarEntry>;
}

const MAX_HEADER_BYTES = 32 * 1024 * 1024;

export function parseAsarHeader(prefix: Buffer, jsonBytes: Buffer): AsarHeader | null {
  if (prefix.length < 16) return null;
  const headerPickleSize = prefix.readUInt32LE(4);
  const jsonLength = prefix.readUInt32LE(12);
  if (jsonLength === 0 || jsonLength > MAX_HEADER_BYTES) return null;
  if (jsonBytes.length < jsonLength) return null;

  let root: unknown;
  try {
    root = JSON.parse(jsonBytes.subarray(0, jsonLength).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof root !== "object" || root === null) return null;

  const entries = new Map<string, AsarEntry>();
  const walk = (node: unknown, prefixPath: string, depth: number): void => {
    if (depth > 24 || typeof node !== "object" || node === null) return;
    const files = (node as { files?: Record<string, unknown> }).files;
    if (!files || typeof files !== "object") return;
    for (const [name, value] of Object.entries(files)) {
      if (typeof value !== "object" || value === null) continue;
      const child = value as Record<string, unknown>;
      const childPath = prefixPath === "" ? name : `${prefixPath}/${name}`;
      if (typeof child["files"] === "object" && child["files"] !== null) {
        walk(child, childPath, depth + 1);
        continue;
      }
      if (typeof child["size"] !== "number") continue;
      const offsetRaw = child["offset"];
      const offset = typeof offsetRaw === "string" ? Number.parseInt(offsetRaw, 10) : Number(offsetRaw);
      if (!Number.isFinite(offset) || offset < 0) continue;
      entries.set(childPath, {
        size: child["size"] as number,
        offset,
        unpacked: child["unpacked"] === true,
      });
    }
  };
  walk(root, "", 0);

  return { baseOffset: 8 + headerPickleSize, entries };
}

export function findAsarEntry(header: AsarHeader, entryPath: string): AsarEntry | null {
  const normalized = entryPath.replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return header.entries.get(normalized) ?? null;
}
