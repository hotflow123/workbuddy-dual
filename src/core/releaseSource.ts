import path from "node:path";
import { z } from "zod";
import { fail, ok, type ProductId, type ReleaseInfo, type Result } from "./contracts";

/**
 * 官方发布来源。配置与代码分离，只接受已审阅的精确 HTTPS 主机；
 * 重定向到非白名单主机、格式变化、缺失关键字段一律 fail-closed。
 *
 * 注意：仓库内随包的默认配置是“空”的（没有任何已验证端点），
 * 因此 listVerifiedReleases 会返回阻断原因，而不是去猜一个 URL。
 */

export const releaseConfigSchema = z.object({
  schemaVersion: z.literal(1),
  products: z.record(
    z.enum(["workbuddy-cn", "workbuddy-ai"]),
    z.object({
      /** 已审阅的精确主机名（不含协议与路径） */
      hosts: z.array(z.string().min(1)),
      /** 版本清单端点；null 表示尚未核实 */
      endpoint: z.string().url().nullable(),
      /** 已实测的响应 schema 版本；"unverified" 表示不允许解析 */
      schema: z.enum(["unverified", "workbuddy-releases-v1"]),
      channel: z.string().min(1),
    }),
  ),
});

export type ReleaseConfig = z.infer<typeof releaseConfigSchema>;

export const DEFAULT_RELEASE_CONFIG: ReleaseConfig = {
  schemaVersion: 1,
  products: {
    "workbuddy-cn": { hosts: [], endpoint: null, schema: "unverified", channel: "stable" },
    "workbuddy-ai": { hosts: [], endpoint: null, schema: "unverified", channel: "stable" },
  },
};

/** 官方清单响应（仅当 schema 已实测为 workbuddy-releases-v1 时才解析） */
const releaseResponseSchema = z
  .object({
    releases: z.array(
      z
        .object({
          version: z.string().regex(/^\d+\.\d+\.\d+([.-][0-9A-Za-z.]+)?$/),
          url: z.string().url(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
          publishedAt: z.string().nullable().optional(),
          platform: z.literal("win32"),
          arch: z.literal("x64"),
          channel: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string, init: { signal?: AbortSignal; redirect: "manual" }) => Promise<HttpResponseLike>;

export interface ReleaseSourceDeps {
  config: ReleaseConfig;
  fetch: FetchLike;
  now: () => string;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface DownloadedPackage {
  file: string;
  sha256: string;
  sizeBytes: number;
  host: string;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function hostAllowed(url: string, hosts: string[]): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return hosts.some((allowed) => allowed.toLowerCase() === host);
}

export class HttpReleaseSource {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ReleaseSourceDeps) {
    this.maxBytes = deps.maxBytes ?? 512 * 1024 * 1024;
    this.timeoutMs = deps.timeoutMs ?? 30000;
  }

  async listVerifiedReleases(product: ProductId): Promise<Result<ReleaseInfo[]>> {
    const entry = this.deps.config.products[product];
    if (!entry) return fail("E_HOST_NOT_ALLOWED", "该产品没有已审阅的发布来源配置");
    if (entry.schema === "unverified" || !entry.endpoint) {
      return fail("E_REMOTE_SCHEMA", "官方版本清单端点与响应格式尚未核实，不进行任何请求", { product });
    }
    if (!entry.endpoint.startsWith("https://")) {
      return fail("E_HOST_NOT_ALLOWED", "版本清单端点必须是 HTTPS");
    }
    if (!hostAllowed(entry.endpoint, entry.hosts)) {
      return fail("E_HOST_NOT_ALLOWED", "版本清单端点不在允许的主机清单内", { host: hostOf(entry.endpoint) });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.deps.fetch(entry.endpoint, { signal: controller.signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        return fail("E_HOST_NOT_ALLOWED", "版本清单端点发生重定向，MVP 不允许跟随", { status: response.status });
      }
      if (response.status !== 200) {
        return fail("E_REMOTE_SCHEMA", `版本清单端点返回 ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 1024 * 1024) {
        return fail("E_REMOTE_SCHEMA", "版本清单响应过大，已拒绝解析");
      }
      const text = new TextDecoder().decode(buffer);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return fail("E_REMOTE_SCHEMA", "版本清单不是合法 JSON");
      }
      const parsed = releaseResponseSchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return fail("E_REMOTE_SCHEMA", "版本清单字段与已实测 schema 不符，已停止解析", {
          path: issue?.path.join(".") ?? "root",
        });
      }
      const releases: ReleaseInfo[] = [];
      for (const item of parsed.data.releases) {
        if (item.channel !== entry.channel) continue;
        if (!hostAllowed(item.url, entry.hosts)) continue;
        releases.push({
          product,
          version: item.version,
          url: item.url,
          sha256: item.sha256 ?? null,
          publishedAt: item.publishedAt ?? null,
          sourceHost: hostOf(item.url) ?? "",
        });
      }
      return ok(releases);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return fail("E_CANCELLED", "获取版本清单超时");
      }
      return fail("E_REMOTE_SCHEMA", "获取版本清单失败", {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async download(
    release: ReleaseInfo,
    stagingDirectory: string,
    onProgress: (received: number, total?: number) => void,
    signal: AbortSignal,
  ): Promise<Result<DownloadedPackage>> {
    const entry = this.deps.config.products[release.product];
    if (!entry) return fail("E_HOST_NOT_ALLOWED", "该产品没有已审阅的发布来源配置");
    if (signal.aborted) return fail("E_CANCELLED", "下载已被取消");
    if (!hostAllowed(release.url, entry.hosts)) {
      return fail("E_HOST_NOT_ALLOWED", "下载地址不在允许的主机清单内", { host: hostOf(release.url) });
    }
    if (!release.url.startsWith("https://")) {
      return fail("E_HOST_NOT_ALLOWED", "下载地址必须是 HTTPS");
    }
    const safeName = `package-${release.version.replace(/[^0-9A-Za-z._-]/g, "_")}.exe`;
    const destination = path.join(stagingDirectory, safeName);
    if (!path.resolve(destination).startsWith(path.resolve(stagingDirectory) + path.sep)) {
      return fail("E_PATH_REJECTED", "下载目标路径逃逸出暂存目录");
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs * 10);

    try {
      const response = await this.deps.fetch(release.url, { signal: controller.signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        return fail("E_HOST_NOT_ALLOWED", "下载地址发生重定向，MVP 不跟随", { location: location ?? "unknown" });
      }
      if (response.status !== 200) {
        return fail("E_REMOTE_SCHEMA", `下载失败，HTTP ${response.status}`);
      }
      const lengthHeader = response.headers.get("content-length");
      const total = lengthHeader ? Number(lengthHeader) : undefined;
      if (total !== undefined && Number.isFinite(total) && total > this.maxBytes) {
        return fail("E_REMOTE_SCHEMA", "安装包体积超过上限，已拒绝下载", { total, max: this.maxBytes });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > this.maxBytes) {
        return fail("E_REMOTE_SCHEMA", "安装包体积超过上限，已丢弃");
      }
      onProgress(buffer.byteLength, total);
      const { createHash } = await import("node:crypto");
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      if (release.sha256 && release.sha256.toLowerCase() !== sha256) {
        return fail("E_SIGNATURE_INVALID", "下载文件哈希与官方元数据不一致");
      }
      const { promises: fsp } = await import("node:fs");
      await fsp.mkdir(stagingDirectory, { recursive: true });
      await fsp.writeFile(destination, buffer);
      return ok({ file: destination, sha256, sizeBytes: buffer.byteLength, host: hostOf(release.url) ?? "" });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return fail("E_CANCELLED", "下载已取消或超时");
      }
      return fail("E_IO", "下载写入失败", { reason: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
