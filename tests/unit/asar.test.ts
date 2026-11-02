import { describe, expect, it } from "vitest";
import { findAsarEntry, parseAsarHeader } from "../../src/core/asar";

/** 构造一个只含若干文件的最小 asar 缓冲区 */
function buildAsar(files: Record<string, string>): Buffer {
  const entries: Record<string, unknown> = {};
  const dataParts: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content, "utf8");
    entries[name] = { size: bytes.length, offset: String(offset) };
    dataParts.push(bytes);
    offset += bytes.length;
  }
  const headerJson = Buffer.from(JSON.stringify({ files: entries }), "utf8");
  // 真实 asar 的头部 pickle 大小 = JSON 长度 + 11（长度字段 + 终止符 + 4 字节对齐）
  const headerPickleSize = headerJson.length + 11;
  const padding = Buffer.alloc(headerPickleSize - 8 - headerJson.length);
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerPickleSize, 4);
  prefix.writeUInt32LE(4, 8);
  prefix.writeUInt32LE(headerJson.length, 12);
  return Buffer.concat([prefix, headerJson, padding, ...dataParts]);
}

describe("asar 解析", () => {
  it("解析扁平文件表", () => {
    const content = '{"productName":"WorkBuddy"}';
    const buffer = buildAsar({ "package.json": content, "main/index.js": "x" });
    const header = parseAsarHeader(buffer.subarray(0, 16), buffer.subarray(16));
    expect(header).not.toBeNull();
    const entry = findAsarEntry(header!, "package.json");
    expect(entry?.size).toBe(Buffer.byteLength(content, "utf8"));
    const start = header!.baseOffset + (entry?.offset ?? 0);
    expect(buffer.subarray(start, start + (entry?.size ?? 0)).toString("utf8")).toBe(content);
  });

  it("支持嵌套目录", () => {
    const buffer = buildAsar({});
    const headerJson = Buffer.from(
      JSON.stringify({ files: { resources: { files: { "product.json": { size: 2, offset: "0" } } } } }),
      "utf8",
    );
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(4 + headerJson.length, 4);
    prefix.writeUInt32LE(4, 8);
    prefix.writeUInt32LE(headerJson.length, 12);
    void buffer;
    const header = parseAsarHeader(prefix, headerJson);
    expect(findAsarEntry(header!, "resources/product.json")?.size).toBe(2);
  });

  it("头部 JSON 损坏时返回 null", () => {
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(100, 4);
    prefix.writeUInt32LE(4, 8);
    prefix.writeUInt32LE(9, 12);
    expect(parseAsarHeader(prefix, Buffer.from("not json!", "utf8"))).toBeNull();
  });

  it("前缀过短时返回 null", () => {
    expect(parseAsarHeader(Buffer.alloc(8), Buffer.from("{}"))).toBeNull();
  });

  it("未声明的条目返回 null", () => {
    const buffer = buildAsar({ "package.json": "{}" });
    const header = parseAsarHeader(buffer.subarray(0, 16), buffer.subarray(16));
    expect(findAsarEntry(header!, "product.json")).toBeNull();
  });
});
