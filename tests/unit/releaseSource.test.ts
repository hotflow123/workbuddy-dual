import { describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { HttpReleaseSource, type FetchLike, type ReleaseConfig } from "../../src/core/releaseSource";
import { makeTempRoot } from "../helpers/fixtures";

const config: ReleaseConfig = {
  schemaVersion: 1,
  products: {
    "workbuddy-cn": {
      hosts: ["download.example.com"],
      endpoint: "https://download.example.com/releases.json",
      schema: "workbuddy-releases-v1",
      channel: "stable",
    },
    "workbuddy-ai": {
      hosts: ["download.example.com"],
      endpoint: null,
      schema: "unverified",
      channel: "stable",
    },
  },
};

function response(body: string, status = 200, headers: Record<string, string> = {}): ReturnType<FetchLike> {
  return Promise.resolve({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  });
}

const validPayload = JSON.stringify({
  releases: [
    { version: "5.8.3", url: "https://download.example.com/cn-5.8.3.exe", sha256: "a".repeat(64), publishedAt: "2026-09-01", platform: "win32", arch: "x64", channel: "stable" },
    { version: "5.8.2", url: "https://download.example.com/cn-5.8.2.exe", sha256: null, publishedAt: null, platform: "win32", arch: "x64", channel: "stable" },
    { version: "6.0.0-beta", url: "https://download.example.com/cn-beta.exe", sha256: null, publishedAt: null, platform: "win32", arch: "x64", channel: "insider" },
  ],
});

describe("HttpReleaseSource", () => {
  it("没有已核实端点时不发请求", async () => {
    let called = false;
    const source = new HttpReleaseSource({
      config,
      fetch: async () => {
        called = true;
        return response("{}");
      },
      now: () => "t",
    });
    const result = await source.listVerifiedReleases("workbuddy-ai");
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("解析成功时只返回白名单主机 + 匹配渠道的版本", async () => {
    const source = new HttpReleaseSource({ config, fetch: async () => response(validPayload), now: () => "t" });
    const result = await source.listVerifiedReleases("workbuddy-cn");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((r) => r.version)).toEqual(["5.8.3", "5.8.2"]);
      expect(result.value[0]?.sourceHost).toBe("download.example.com");
    }
  });

  it("响应出现未知关键字段时失败关闭", async () => {
    const payload = JSON.stringify({ releases: [], extra: "unknown" });
    const source = new HttpReleaseSource({ config, fetch: async () => response(payload), now: () => "t" });
    const result = await source.listVerifiedReleases("workbuddy-cn");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_REMOTE_SCHEMA");
  });

  it("字段缺失或格式不符时失败关闭", async () => {
    const payload = JSON.stringify({ releases: [{ version: "not-a-version", url: "https://download.example.com/x.exe" }] });
    const source = new HttpReleaseSource({ config, fetch: async () => response(payload), now: () => "t" });
    const result = await source.listVerifiedReleases("workbuddy-cn");
    expect(result.ok).toBe(false);
  });

  it("端点重定向时不跟随", async () => {
    const source = new HttpReleaseSource({
      config,
      fetch: async () => response("", 302, { location: "https://evil.example.com/x" }),
      now: () => "t",
    });
    const result = await source.listVerifiedReleases("workbuddy-cn");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_HOST_NOT_ALLOWED");
  });

  it("下载到非白名单主机时拒绝", async () => {
    const source = new HttpReleaseSource({ config, fetch: async () => response("x"), now: () => "t" });
    const result = await source.download(
      { product: "workbuddy-cn", version: "5.8.3", url: "https://evil.example.com/a.exe", sha256: null, publishedAt: null, sourceHost: "evil.example.com" },
      path.join("C:\\tmp"),
      () => undefined,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_HOST_NOT_ALLOWED");
  });

  it("哈希不一致时拒绝写入", async () => {
    const source = new HttpReleaseSource({ config, fetch: async () => response("payload"), now: () => "t" });
    const staging = await makeTempRoot();
    const result = await source.download(
      {
        product: "workbuddy-cn",
        version: "5.8.3",
        url: "https://download.example.com/a.exe",
        sha256: "b".repeat(64),
        publishedAt: null,
        sourceHost: "download.example.com",
      },
      staging,
      () => undefined,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_SIGNATURE_INVALID");
    const files = await fsp.readdir(staging);
    expect(files).toHaveLength(0);
    await fsp.rm(staging, { recursive: true, force: true });
  });

  it("超过体积上限时拒绝", async () => {
    const source = new HttpReleaseSource({
      config,
      fetch: async () => response("x".repeat(2048), 200, { "content-length": "2048" }),
      now: () => "t",
      maxBytes: 1024,
    });
    const staging = await makeTempRoot();
    const result = await source.download(
      { product: "workbuddy-cn", version: "5.8.3", url: "https://download.example.com/a.exe", sha256: null, publishedAt: null, sourceHost: "download.example.com" },
      staging,
      () => undefined,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    await fsp.rm(staging, { recursive: true, force: true });
  });

  it("下载成功时写入暂存目录并返回哈希", async () => {
    const body = "installer-bytes";
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(Buffer.from(body)).digest("hex");
    const source = new HttpReleaseSource({ config, fetch: async () => response(body), now: () => "t" });
    const staging = await makeTempRoot();
    const result = await source.download(
      { product: "workbuddy-cn", version: "5.8.3", url: "https://download.example.com/a.exe", sha256, publishedAt: null, sourceHost: "download.example.com" },
      staging,
      () => undefined,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sha256).toBe(sha256);
      expect(await fsp.readFile(result.value.file, "utf8")).toBe(body);
    }
    await fsp.rm(staging, { recursive: true, force: true });
  });

  it("取消时返回 E_CANCELLED", async () => {
    const source = new HttpReleaseSource({
      config,
      fetch: async (_url, init) => {
        if (init.signal?.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
        return response("x");
      },
      now: () => "t",
    });
    const controller = new AbortController();
    controller.abort();
    const staging = await makeTempRoot();
    const result = await source.download(
      { product: "workbuddy-cn", version: "5.8.3", url: "https://download.example.com/a.exe", sha256: null, publishedAt: null, sourceHost: "download.example.com" },
      staging,
      () => undefined,
      controller.signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_CANCELLED");
    await fsp.rm(staging, { recursive: true, force: true });
  });
});
