import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppService } from "../../src/main/services/appService";
import { NodeFsPort } from "../../src/main/adapters/fsPort";
import { SPONSOR_SITE } from "../../src/core/knownProducts";
import { IPC, sponsorInputSchema } from "../../src/shared/ipc";
import type { JournalStore } from "../../src/core/journal";
import type { ScanReport } from "../../src/core/contracts";

function memoryJournal(): JournalStore {
  const store = new Map<string, import("../../src/core/contracts").OperationRecord>();
  return {
    read: async (id) => store.get(id) ?? null,
    write: async (record) => {
      store.set(record.operationId, record);
    },
    list: async () => [...store.values()],
  };
}

function emptyReport(): ScanReport {
  return {
    scannedAt: "2026-11-02T00:00:00.000Z",
    readOnly: true,
    records: [],
    skippedSources: [],
    conflicts: [],
    products: [
      { product: "workbuddy-cn", installs: [], pendingPath: [], state: "not-found", copyCount: 0 },
      { product: "workbuddy-ai", installs: [], pendingPath: [], state: "not-found", copyCount: 0 },
    ],
    sources: [],
  };
}

async function makeService(openExternal?: (url: string) => Promise<void>): Promise<AppService> {
  const service = new AppService({
    appVersion: "test",
    stateDir: await fsp.mkdtemp(path.join(os.tmpdir(), "wb-sponsor-")),
    managementRoot: await fsp.mkdtemp(path.join(os.tmpdir(), "wb-sponsor-m-")),
    isWindows: true,
    portable: false,
    selfDirectories: [],
    fs: new NodeFsPort(),
    registry: { readUninstallEntries: async () => ({ entries: [], skipped: [] }) },
    journal: memoryJournal(),
    now: () => "2026-11-02T00:00:00.000Z",
    bundledEvidenceFile: path.join(os.tmpdir(), "missing.json"),
    configDirectory: os.tmpdir(),
    env: {},
    scanImplementation: async () => emptyReport(),
    ...(openExternal ? { openExternal } : {}),
  });
  await service.init();
  return service;
}

describe("赞助商入口：固定地址", () => {
  it("地址与文案固定，是 HTTPS 首页且不含参数/直链", () => {
    expect(SPONSOR_SITE.url).toBe("https://memefast.cc/");
    expect(SPONSOR_SITE.label).toBe("API赞助商：memefast.cc");
    expect(SPONSOR_SITE.url.startsWith("https://")).toBe(true);
    expect(SPONSOR_SITE.url).not.toContain("?");
    expect(SPONSOR_SITE.url).not.toMatch(/\.(exe|msi|7z|zip)$/i);
  });

  it("占用独立 IPC 通道，不与官网入口复用", () => {
    expect(IPC.openSponsor).toBe("sponsor:open");
    expect(IPC.openSponsor).not.toBe(IPC.openOfficial);
    expect(new Set(Object.values(IPC)).size).toBe(Object.values(IPC).length);
  });

  it("openSponsorSite 只打开主进程常量里的地址", async () => {
    const opened: string[] = [];
    const service = await makeService(async (url) => {
      opened.push(url);
    });
    const result = await service.openSponsorSite();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.url).toBe("https://memefast.cc/");
    expect(opened).toEqual(["https://memefast.cc/"]);
  });

  it("没有 openExternal 时如实报错，不静默失败", async () => {
    const service = await makeService();
    const result = await service.openSponsorSite();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_INTERNAL");
  });

  it("openExternal 抛错时收敛成 Result，不把堆栈抛给界面", async () => {
    const service = await makeService(async () => {
      throw new Error("no browser");
    });
    const result = await service.openSponsorSite();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("打开赞助商链接失败");
  });
});

describe("赞助商入口：入参只能是空对象", () => {
  it("接受空对象（preload 不传任何参数）", () => {
    expect(sponsorInputSchema.safeParse({}).success).toBe(true);
  });

  it("拒绝任何 URL / host / scheme 字段", () => {
    const injections = [
      { url: "https://evil.example/" },
      { url: "javascript:alert(1)" },
      { host: "evil.example" },
      { scheme: "file" },
      { product: "workbuddy-cn" },
    ];
    for (const input of injections) {
      expect(sponsorInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it("拒绝非对象入参（字符串 URL 不能被当成参数传进来）", () => {
    for (const input of ["https://evil.example/", "javascript:alert(1)", 42, true, []]) {
      expect(sponsorInputSchema.safeParse(input).success, String(input)).toBe(false);
    }
  });
});
