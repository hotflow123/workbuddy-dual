import { promises as fsp } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ProductId } from "../core/contracts";
import { maskPath, sanitizeText, type MaskedPath } from "../core/diagnostics";

/**
 * 真实失败日志：每次安装/更新/卸载失败都落盘一个 JSON，
 * 位置固定在数据目录 `state/errors/`（非携带版为 `userData/state/errors`）。
 *
 * 写入前统一脱敏：不含用户名、完整个人路径、令牌或命令行敏感参数。
 */

export interface ErrorEntry {
  /** 操作种类：install / update / uninstall / launch */
  operation: string;
  product: ProductId | null;
  instanceId: string | null;
  /** 失败阶段：校验安装包 / 解包 / 部署 / 替换 / 复扫 / 快捷方式 … */
  stage: string;
  /** 稳定错误码，便于排查 */
  code: string;
  /** 真实错误消息（脱敏后） */
  message: string;
  /** 暂存目录（脱敏为盘符+层级+哈希） */
  stagingDirectory?: string | null;
  /** 是否已回滚 */
  rolledBack: boolean;
  /** 附加细节（不含命令行原文） */
  detail?: Record<string, string | number | boolean | null>;
}

/** 读取出来的日志记录（已解析、已脱敏） */
export interface ErrorLogRecord {
  at: string;
  operation: string;
  product: ProductId | null;
  instanceId: string | null;
  stage: string;
  code: string;
  message: string;
  stagingDirectory: MaskedPath | null;
  rolledBack: boolean;
  detail: Record<string, string | number | boolean | null> | null;
}

export interface ErrorLogReadResult {
  /** 按时间倒序，最多 limit 条 */
  entries: ErrorLogRecord[];
  /** 目录里 JSON 文件总数（含损坏） */
  total: number;
  /** 无法解析或 schema 不符的文件数 */
  corrupted: number;
  /** 目录是否可读（不可读时 entries 为空，但调用方应如实报告） */
  readable: boolean;
}

export interface ErrorLogPort {
  write(entry: ErrorEntry): Promise<string | null>;
  list(): Promise<string[]>;
  /** 读取最近错误（默认 20 条），损坏文件跳过并计数 */
  readRecent(limit?: number): Promise<ErrorLogReadResult>;
  directory: string;
}

const PRODUCTS = new Set(["workbuddy-cn", "workbuddy-ai"]);

function parseRecord(raw: unknown): ErrorLogRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value["schemaVersion"] !== 1) return null;
  for (const key of ["at", "operation", "stage", "code", "message"]) {
    if (typeof value[key] !== "string" || (value[key] as string).length === 0) return null;
  }
  if (typeof value["rolledBack"] !== "boolean") return null;
  const product =
    typeof value["product"] === "string" && PRODUCTS.has(value["product"])
      ? (value["product"] as ProductId)
      : null;
  const staging = value["stagingDirectory"];
  const detail = value["detail"];
  return {
    at: value["at"] as string,
    operation: value["operation"] as string,
    product,
    instanceId: typeof value["instanceId"] === "string" ? value["instanceId"] : null,
    stage: value["stage"] as string,
    code: value["code"] as string,
    message: value["message"] as string,
    stagingDirectory:
      typeof staging === "object" && staging !== null
        ? {
            drive: String((staging as MaskedPath).drive ?? "<unknown>"),
            depth: Number((staging as MaskedPath).depth ?? 0),
            leaf: String((staging as MaskedPath).leaf ?? ""),
            hash: String((staging as MaskedPath).hash ?? ""),
          }
        : null,
    rolledBack: value["rolledBack"] as boolean,
    detail:
      typeof detail === "object" && detail !== null
        ? Object.fromEntries(
            Object.entries(detail as Record<string, unknown>)
              .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item) || item === null)
              .map(([key, item]) => [key, item as string | number | boolean | null]),
          )
        : null,
  };
}

export class FileErrorLog implements ErrorLogPort {
  constructor(
    readonly directory: string,
    private readonly now: () => string,
  ) {}

  async write(entry: ErrorEntry): Promise<string | null> {
    try {
      await fsp.mkdir(this.directory, { recursive: true });
      const at = this.now();
      const stamp = at.replace(/[:.]/g, "-");
      const operation = entry.operation.replace(/[^a-zA-Z0-9-]/g, "-");
      // 同一毫秒同类型操作不能互相覆盖：追加随机短 ID
      const unique = randomBytes(3).toString("hex");
      const file = path.join(this.directory, `${stamp}-${operation}-${unique}.json`);
      const payload = {
        schemaVersion: 1,
        at,
        operation: entry.operation,
        product: entry.product,
        instanceId: entry.instanceId,
        stage: entry.stage,
        code: entry.code,
        message: sanitizeText(entry.message),
        stagingDirectory: maskPath(entry.stagingDirectory ?? null),
        rolledBack: entry.rolledBack,
        detail: entry.detail
          ? Object.fromEntries(
              Object.entries(entry.detail)
                // 原始命令行一律不落盘（可能含令牌或敏感参数）
                .filter(([key]) => !/command|cmd|args|arguments|uninstall/i.test(key))
                .map(([key, value]) => [
                  key,
                  typeof value === "string" ? sanitizeText(value) : value,
                ]),
            )
          : null,
      };
      await fsp.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      return file;
    } catch {
      // 日志写入失败不能覆盖原始错误：调用方仍会返回真实失败原因
      return null;
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await fsp.readdir(this.directory);
      return files.filter((name) => name.endsWith(".json")).sort().reverse();
    } catch {
      return [];
    }
  }

  async readRecent(limit = 20): Promise<ErrorLogReadResult> {
    let files: string[];
    try {
      files = (await fsp.readdir(this.directory)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      // 目录还不存在 = 没有任何失败记录，不算“读取失败”
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { entries: [], total: 0, corrupted: 0, readable: true };
      }
      return { entries: [], total: 0, corrupted: 0, readable: false };
    }
    const ordered = files.sort().reverse();
    const entries: ErrorLogRecord[] = [];
    let corrupted = 0;
    for (const name of ordered) {
      if (entries.length >= limit) break;
      try {
        const text = await fsp.readFile(path.join(this.directory, name), "utf8");
        const parsed = parseRecord(JSON.parse(text));
        if (parsed) entries.push(parsed);
        else corrupted += 1;
      } catch {
        corrupted += 1;
      }
    }
    return { entries, total: files.length, corrupted, readable: true };
  }
}
