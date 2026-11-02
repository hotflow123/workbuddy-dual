/**
 * 日志脱敏：诊断导出默认对用户名与用户主目录做替换，避免把真实路径写进日志。
 */

export interface RedactorOptions {
  homeDirectory?: string;
  userName?: string;
}

export function createRedactor(options: RedactorOptions): (text: string) => string {
  const replacements: { pattern: RegExp; replacement: string }[] = [];
  if (options.homeDirectory && options.homeDirectory.trim() !== "") {
    const escaped = options.homeDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    replacements.push({ pattern: new RegExp(escaped, "gi"), replacement: "%USERPROFILE%" });
  }
  if (options.userName && options.userName.trim() !== "") {
    const escaped = options.userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    replacements.push({ pattern: new RegExp(`\\\\Users\\\\${escaped}`, "gi"), replacement: "\\\\Users\\\\<user>" });
    replacements.push({ pattern: new RegExp(`/Users/${escaped}`, "gi"), replacement: "/Users/<user>" });
  }
  return (text: string): string => {
    let result = text;
    for (const { pattern, replacement } of replacements) {
      result = result.replace(pattern, replacement);
    }
    return result;
  };
}

/** 粗略识别疑似凭据，命中则整行丢弃，避免误导出。 */
const SECRET_PATTERNS = [/\bBearer\s+[A-Za-z0-9._-]{10,}/i, /\b(token|password|secret|cookie)\s*[=:]\s*\S{8,}/i];

export function stripSecretLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !SECRET_PATTERNS.some((p) => p.test(line)))
    .join("\n");
}

export function redactForDiagnostics(text: string, options: RedactorOptions): string {
  const redact = createRedactor(options);
  return stripSecretLines(redact(text));
}
