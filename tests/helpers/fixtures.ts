import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

export async function makeTempRoot(prefix = "wb-dual-"): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, "utf8");
  }
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, "utf8")) as T;
}

export function productMetadata(applicationName: string, version: string, dataFolderName: string): string {
  return JSON.stringify({ name: applicationName, applicationName, version, dataFolderName }, null, 2);
}
