import { describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileErrorLog } from "../../src/main/errorLog";

async function tempRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "wb-errlog-"));
}

describe("FileErrorLog", () => {
  it("把失败写入 state/errors，并包含阶段、错误码与回滚状态", async () => {
    const root = await tempRoot();
    const log = new FileErrorLog(path.join(root, "errors"), () => "2026-10-19T10:00:00.000Z");
    const file = await log.write({
      operation: "install",
      product: "workbuddy-cn",
      instanceId: null,
      stage: "deploy",
      code: "E_PACKAGE_INVALID",
      message: "解包失败：缺少 resources/app.asar",
      stagingDirectory: "C:\\Users\\zhangsan\\AppData\\Local\\WorkBuddyDualEdition\\state\\.staging\\install-1",
      rolledBack: true,
    });
    expect(file).not.toBeNull();
    const text = await fsp.readFile(file!, "utf8");
    const payload = JSON.parse(text);
    expect(payload.operation).toBe("install");
    expect(payload.stage).toBe("deploy");
    expect(payload.code).toBe("E_PACKAGE_INVALID");
    expect(payload.rolledBack).toBe(true);
    expect(payload.message).toContain("resources/app.asar");
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("写入前脱敏用户名、完整路径与令牌", async () => {
    const root = await tempRoot();
    const log = new FileErrorLog(path.join(root, "errors"), () => "2026-10-19T10:00:01.000Z");
    const file = await log.write({
      operation: "update",
      product: "workbuddy-ai",
      instanceId: "wb-ai-1",
      stage: "replace",
      code: "E_IO",
      message: "复制失败：C:\\Users\\zhangsan\\AppData\\Roaming\\x  token=abcdef123456",
      stagingDirectory: "C:\\Users\\zhangsan\\AppData\\Local\\Temp\\stage",
      rolledBack: true,
      detail: { command: "setup.exe /S /token=abcdef123456", target: "C:\\Users\\zhangsan\\AppData" },
    });
    expect(file).not.toBeNull();
    const text = await fsp.readFile(file!, "utf8");
    expect(text).not.toContain("zhangsan");
    expect(text).not.toContain("abcdef123456");
    expect(text).not.toContain("setup.exe");
    expect(JSON.parse(text).stagingDirectory).toMatchObject({ drive: "C:\\" });
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("按时间倒序列出日志", async () => {
    const root = await tempRoot();
    let clock = 0;
    const log = new FileErrorLog(path.join(root, "errors"), () => `2026-10-19T10:00:0${clock++}.000Z`);
    await log.write({ operation: "install", product: "workbuddy-cn", instanceId: null, stage: "deploy", code: "E_1", message: "a", rolledBack: true });
    await log.write({ operation: "install", product: "workbuddy-cn", instanceId: null, stage: "deploy", code: "E_2", message: "b", rolledBack: true });
    const files = await log.list();
    expect(files).toHaveLength(2);
    expect(files[0]! > files[1]!).toBe(true);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("目录不可写时返回 null，不抛出", async () => {
    const root = await tempRoot();
    const file = path.join(root, "blocked");
    await fsp.writeFile(file, "x", "utf8");
    const log = new FileErrorLog(file, () => "2026-10-19T10:00:00.000Z");
    const result = await log.write({
      operation: "install",
      product: null,
      instanceId: null,
      stage: "deploy",
      code: "E_IO",
      message: "x",
      rolledBack: false,
    });
    expect(result).toBeNull();
    await fsp.rm(root, { recursive: true, force: true });
  });
});

describe("FileErrorLog.readRecent", () => {
  async function seed(log: FileErrorLog, count: number, base = 0): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await log.write({
        operation: "install",
        product: "workbuddy-cn",
        instanceId: null,
        stage: "deploy",
        code: "E_" + (base + index),
        message: "失败 " + (base + index),
        rolledBack: true,
      });
    }
  }

  it("读取最近错误，按时间倒序并解析为结构化记录", async () => {
    const root = await tempRoot();
    let clock = 0;
    const log = new FileErrorLog(path.join(root, "errors"), () => "2026-10-19T10:00:0" + clock++ + ".000Z");
    await seed(log, 3);
    const result = await log.readRecent(20);
    expect(result.readable).toBe(true);
    expect(result.total).toBe(3);
    expect(result.corrupted).toBe(0);
    expect(result.entries.map((entry) => entry.code)).toEqual(["E_2", "E_1", "E_0"]);
    expect(result.entries[0]).toMatchObject({ operation: "install", stage: "deploy", rolledBack: true });
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("最多读取 20 条", async () => {
    const root = await tempRoot();
    let clock = 0;
    const log = new FileErrorLog(
      path.join(root, "errors"),
      () => "2026-10-19T10:00:" + String(clock++).padStart(2, "0") + ".000Z",
    );
    await seed(log, 25);
    const result = await log.readRecent(20);
    expect(result.entries).toHaveLength(20);
    expect(result.total).toBe(25);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("损坏文件跳过并计数，不阻断其余记录", async () => {
    const root = await tempRoot();
    const dir = path.join(root, "errors");
    const log = new FileErrorLog(dir, () => "2026-10-19T10:00:00.000Z");
    await seed(log, 2);
    await fsp.writeFile(path.join(dir, "2099-01-01-broken.json"), "{not json", "utf8");
    await fsp.writeFile(path.join(dir, "2099-01-02-schema.json"), JSON.stringify({ schemaVersion: 99 }), "utf8");

    const result = await log.readRecent(20);
    expect(result.corrupted).toBe(2);
    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(4);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("目录不存在 = 没有失败记录（可读），不是读取失败", async () => {
    const root = await tempRoot();
    const log = new FileErrorLog(path.join(root, "missing"), () => "2026-10-19T10:00:00.000Z");
    const result = await log.readRecent();
    expect(result.readable).toBe(true);
    expect(result.total).toBe(0);
    expect(result.entries).toEqual([]);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("路径不是目录（ENOTDIR）时如实返回 readable=false", async () => {
    const root = await tempRoot();
    const file = path.join(root, "not-a-dir");
    await fsp.writeFile(file, "x", "utf8");
    const log = new FileErrorLog(file, () => "2026-10-19T10:00:00.000Z");
    const result = await log.readRecent();
    expect(result.readable).toBe(false);
    expect(result.entries).toEqual([]);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("同一毫秒的同类错误不会互相覆盖", async () => {
    const root = await tempRoot();
    const dir = path.join(root, "errors");
    const log = new FileErrorLog(dir, () => "2026-10-19T10:00:00.000Z");
    await log.write({ operation: "install", product: "workbuddy-cn", instanceId: null, stage: "a", code: "E_A", message: "a", rolledBack: true });
    await log.write({ operation: "install", product: "workbuddy-cn", instanceId: null, stage: "b", code: "E_B", message: "b", rolledBack: true });
    const files = (await fsp.readdir(dir)).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(2);
    const result = await log.readRecent();
    expect(result.entries.map((entry) => entry.code).sort()).toEqual(["E_A", "E_B"]);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("读取结果不含完整路径、用户名或令牌", async () => {
    const root = await tempRoot();
    const log = new FileErrorLog(path.join(root, "errors"), () => "2026-10-19T10:00:00.000Z");
    await log.write({
      operation: "install",
      product: "workbuddy-cn",
      instanceId: null,
      stage: "deploy",
      code: "E_IO",
      message: "写入失败：C:\\Users\\zhangsan\\AppData\\x token=abcdef123456",
      stagingDirectory: "C:\\Users\\zhangsan\\AppData\\Local\\Temp\\stage",
      rolledBack: true,
    });
    const result = await log.readRecent();
    const text = JSON.stringify(result);
    expect(text).not.toContain("zhangsan");
    expect(text).not.toContain("abcdef123456");
    expect(result.entries[0]?.stagingDirectory).toMatchObject({ drive: "C:\\" });
    await fsp.rm(root, { recursive: true, force: true });
  });
});
