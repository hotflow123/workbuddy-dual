import { describe, expect, it } from "vitest";
import { parseShortcutTarget } from "../../src/core/shortcut";

const CLSID = Buffer.from("0114020000000000c000000000000046", "hex");

interface LnkOptions {
  withIdList?: boolean;
  withLinkInfo?: boolean;
  relativePath?: string;
}

/** 构造一个最小可解析的 .lnk（仅 Header + 可选 IDList + LinkInfo） */
function buildLnk(target: string, options: LnkOptions = {}): Buffer {
  const pathBytes = Buffer.from(`${target}\0`, "latin1");
  const suffix = Buffer.from("\0", "latin1");
  const volumeId = Buffer.alloc(17);
  volumeId.writeUInt32LE(17, 0);
  volumeId.writeUInt32LE(3, 4);
  volumeId.writeUInt32LE(0x12345678, 8);
  volumeId.writeUInt32LE(0x10, 12);
  volumeId[16] = 0;

  const linkInfoHeaderSize = 0x1c;
  const volumeOffset = linkInfoHeaderSize;
  const localBaseOffset = volumeOffset + volumeId.length;
  const suffixOffset = localBaseOffset + pathBytes.length;
  const linkInfoSize = suffixOffset + suffix.length;

  const linkInfo = Buffer.alloc(linkInfoSize);
  linkInfo.writeUInt32LE(linkInfoSize, 0);
  linkInfo.writeUInt32LE(linkInfoHeaderSize, 4);
  linkInfo.writeUInt32LE(1, 8);
  linkInfo.writeUInt32LE(volumeOffset, 12);
  linkInfo.writeUInt32LE(localBaseOffset, 16);
  linkInfo.writeUInt32LE(0, 20);
  linkInfo.writeUInt32LE(suffixOffset, 24);
  volumeId.copy(linkInfo, volumeOffset);
  pathBytes.copy(linkInfo, localBaseOffset);
  suffix.copy(linkInfo, suffixOffset);

  const header = Buffer.alloc(0x4c);
  header.writeUInt32LE(0x4c, 0);
  CLSID.copy(header, 4);
  let flags = 0;
  if (options.withIdList) flags |= 0x01;
  if (options.withLinkInfo !== false) flags |= 0x02;
  header.writeUInt32LE(flags, 20);

  const idList = options.withIdList ? Buffer.alloc(2) : Buffer.alloc(0);
  if (options.withIdList) idList.writeUInt16LE(0, 0);

  return Buffer.concat([header, idList, options.withLinkInfo === false ? Buffer.alloc(0) : linkInfo]);
}

describe("parseShortcutTarget", () => {
  it("解析本地目标路径", () => {
    const lnk = buildLnk("C:\\Program Files\\WorkBuddy\\WorkBuddy.exe");
    expect(parseShortcutTarget(lnk)).toBe("C:\\Program Files\\WorkBuddy\\WorkBuddy.exe");
  });

  it("跳过 LinkTargetIDList 后仍能解析", () => {
    const lnk = buildLnk("C:\\Apps\\WorkBuddy AI\\WorkBuddy AI.exe", { withIdList: true });
    expect(parseShortcutTarget(lnk)).toBe("C:\\Apps\\WorkBuddy AI\\WorkBuddy AI.exe");
  });

  it("没有 LinkInfo 时返回 null（不猜测）", () => {
    const lnk = buildLnk("C:\\x\\a.exe", { withLinkInfo: false });
    expect(parseShortcutTarget(lnk)).toBeNull();
  });

  it("头部魔数不对时返回 null", () => {
    const lnk = buildLnk("C:\\x\\a.exe");
    lnk.writeUInt32LE(0x50, 0);
    expect(parseShortcutTarget(lnk)).toBeNull();
  });

  it("CLSID 不对时返回 null", () => {
    const lnk = buildLnk("C:\\x\\a.exe");
    lnk[4] = 0xff;
    expect(parseShortcutTarget(lnk)).toBeNull();
  });

  it("过短的缓冲区返回 null", () => {
    expect(parseShortcutTarget(Buffer.alloc(10))).toBeNull();
  });

  it("相对路径不被当作本地绝对路径", () => {
    const lnk = buildLnk("WorkBuddy.exe");
    expect(parseShortcutTarget(lnk)).toBeNull();
  });

  it("越界的 LinkInfo 偏移不会崩溃", () => {
    const lnk = buildLnk("C:\\x\\a.exe");
    lnk.writeUInt32LE(0xffffff, 0x4c);
    expect(parseShortcutTarget(lnk)).toBeNull();
  });
});
