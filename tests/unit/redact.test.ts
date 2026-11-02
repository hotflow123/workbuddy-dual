import { describe, expect, it } from "vitest";
import { createRedactor, redactForDiagnostics, stripSecretLines } from "../../src/core/redact";

describe("日志脱敏", () => {
  it("替换用户主目录与用户名", () => {
    const redact = createRedactor({ homeDirectory: "C:\\Users\\zhangsan", userName: "zhangsan" });
    const text = "C:\\Users\\zhangsan\\AppData\\Local\\WorkBuddy\\logs";
    expect(redact(text)).toContain("%USERPROFILE%");
    expect(redact(text)).not.toContain("zhangsan");
  });

  it("大小写不敏感替换", () => {
    const redact = createRedactor({ homeDirectory: "C:\\Users\\ZhangSan" });
    expect(redact("c:\\users\\zhangsan\\x")).toContain("%USERPROFILE%");
  });

  it("丢弃包含疑似凭据的行", () => {
    const text = ["正常行", "Authorization: Bearer abcdefghijklmnop", "token=abcdefghijk"].join("\n");
    const stripped = stripSecretLines(text);
    expect(stripped).toBe("正常行");
  });

  it("组合脱敏不残留路径与凭据", () => {
    const output = redactForDiagnostics(
      "C:\\Users\\zhangsan\\pkg.exe\ncookie=abcdefghijklmn",
      { homeDirectory: "C:\\Users\\zhangsan", userName: "zhangsan" },
    );
    expect(output).not.toContain("zhangsan");
    expect(output).not.toContain("abcdefghijklmn");
  });
});
