import { promises as fsp } from "node:fs";
import path from "node:path";
import type { OperationRecord } from "../../core/contracts";
import type { JournalStore } from "../../core/journal";

/**
 * 操作日志落地实现：<stateDir>/operations/<operationId>.json
 * 写入使用“临时文件 + rename”，避免崩溃时留下半个 JSON。
 */
export class FileJournalStore implements JournalStore {
  constructor(private readonly directory: string) {}

  private fileOf(operationId: string): string {
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(operationId)) {
      throw new Error("操作编号格式非法");
    }
    return path.join(this.directory, `${operationId}.json`);
  }

  async read(operationId: string): Promise<OperationRecord | null> {
    try {
      const text = await fsp.readFile(this.fileOf(operationId), "utf8");
      return JSON.parse(text) as OperationRecord;
    } catch {
      return null;
    }
  }

  async write(record: OperationRecord): Promise<void> {
    await fsp.mkdir(this.directory, { recursive: true });
    const target = this.fileOf(record.operationId);
    const temporary = `${target}.tmp-${process.pid}`;
    await fsp.writeFile(temporary, JSON.stringify(record, null, 2), "utf8");
    await fsp.rename(temporary, target);
  }

  async list(): Promise<OperationRecord[]> {
    try {
      const files = await fsp.readdir(this.directory);
      const records: OperationRecord[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const text = await fsp.readFile(path.join(this.directory, file), "utf8");
          records.push(JSON.parse(text) as OperationRecord);
        } catch {
          // 损坏的记录不猜测，直接跳过并在 UI 中以“无记录”呈现
        }
      }
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }
}
