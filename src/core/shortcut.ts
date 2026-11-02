/**
 * 最小化的 Windows 快捷方式（.lnk）目标解析。
 *
 * 只读取 Shell Link 头部与 LinkInfo 中的本地路径字段，不执行任何代码、
 * 不解析图标、不读取扩展数据块。任何结构不符合预期都返回 null，绝不猜测。
 *
 * 参考结构（MS-SHLLINK）：
 *   ShellLinkHeader(0x4C) → [LinkTargetIDList] → [LinkInfo] → ...
 */

const HEADER_SIZE = 0x4c;
const SHELL_LINK_CLSID = Buffer.from("0114020000000000c000000000000046", "hex");
const FLAG_HAS_LINK_TARGET_ID_LIST = 0x00000001;
const FLAG_HAS_LINK_INFO = 0x00000002;
const LINK_INFO_FLAG_VOLUME_AND_LOCAL_BASE_PATH = 0x00000001;

function readAnsiZ(buffer: Buffer, start: number, end: number): string | null {
  if (start < 0 || start >= end || end > buffer.length) return null;
  let cursor = start;
  while (cursor < end && buffer[cursor] !== 0) cursor += 1;
  if (cursor === start) return null;
  // 路径为本地 ANSI 代码页；latin1 保证字节不丢失，不做有损转换
  return buffer.subarray(start, cursor).toString("latin1");
}

function readUtf16Z(buffer: Buffer, start: number, end: number): string | null {
  if (start < 0 || start >= end || end > buffer.length) return null;
  let cursor = start;
  while (cursor + 1 < end && !(buffer[cursor] === 0 && buffer[cursor + 1] === 0)) cursor += 2;
  if (cursor === start) return null;
  return buffer.subarray(start, cursor).toString("utf16le");
}

/** 返回 .lnk 指向的本地绝对路径；无本地路径（网络/仅 IDList）时返回 null。 */
export function parseShortcutTarget(buffer: Buffer): string | null {
  if (buffer.length < HEADER_SIZE) return null;
  if (buffer.readUInt32LE(0) !== HEADER_SIZE) return null;
  if (!buffer.subarray(4, 20).equals(SHELL_LINK_CLSID)) return null;

  const flags = buffer.readUInt32LE(20);
  let offset = HEADER_SIZE;

  if ((flags & FLAG_HAS_LINK_TARGET_ID_LIST) !== 0) {
    if (offset + 2 > buffer.length) return null;
    const idListSize = buffer.readUInt16LE(offset);
    offset += 2 + idListSize;
  }

  if ((flags & FLAG_HAS_LINK_INFO) === 0) return null;
  if (offset + 0x1c > buffer.length) return null;

  const linkInfoSize = buffer.readUInt32LE(offset);
  const linkInfoHeaderSize = buffer.readUInt32LE(offset + 4);
  const linkInfoFlags = buffer.readUInt32LE(offset + 8);
  const localBasePathOffset = buffer.readUInt32LE(offset + 16);
  const commonPathSuffixOffset = buffer.readUInt32LE(offset + 24);
  const linkInfoEnd = offset + linkInfoSize;
  if (linkInfoSize < 0x1c || linkInfoEnd > buffer.length) return null;
  if ((linkInfoFlags & LINK_INFO_FLAG_VOLUME_AND_LOCAL_BASE_PATH) === 0) return null;

  let basePath: string | null = null;
  let suffix: string | null = null;

  if (linkInfoHeaderSize >= 0x24 && offset + 0x24 <= linkInfoEnd) {
    const unicodeBaseOffset = buffer.readUInt32LE(offset + 28);
    if (unicodeBaseOffset > 0) basePath = readUtf16Z(buffer, offset + unicodeBaseOffset, linkInfoEnd);
    const unicodeSuffixOffset = buffer.readUInt32LE(offset + 32);
    if (unicodeSuffixOffset > 0) suffix = readUtf16Z(buffer, offset + unicodeSuffixOffset, linkInfoEnd);
  }
  if (!basePath && localBasePathOffset > 0) {
    basePath = readAnsiZ(buffer, offset + localBasePathOffset, linkInfoEnd);
  }
  if (!suffix && commonPathSuffixOffset > 0) {
    suffix = readAnsiZ(buffer, offset + commonPathSuffixOffset, linkInfoEnd);
  }
  if (!basePath) return null;

  const combined = `${basePath}${suffix ?? ""}`.trim();
  if (!/^[a-zA-Z]:\\/.test(combined)) return null;
  return combined;
}
