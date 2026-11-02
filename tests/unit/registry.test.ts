import { describe, expect, it } from "vitest";
import { parseRegQuery } from "../../src/main/adapters/windows";

const FIXTURE = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{1111}

    DisplayName    REG_SZ    WorkBuddy
    DisplayVersion    REG_SZ    5.8.3
    InstallLocation    REG_SZ    C:\\Program Files\\WorkBuddy
    Publisher    REG_SZ    Tencent Technology

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{2222}

    DisplayName    REG_SZ    WorkBuddy AI
    InstallLocation    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\WorkBuddy AI
    UninstallString    REG_SZ    "C:\\Users\\me\\AppData\\Local\\Programs\\WorkBuddy AI\\Uninstall WorkBuddy AI.exe"

`;

describe("parseRegQuery", () => {
  it("解析多个卸载项与值", () => {
    const entries = parseRegQuery(FIXTURE, "HKLM64");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.values["DisplayName"]).toBe("WorkBuddy");
    expect(entries[0]?.values["DisplayVersion"]).toBe("5.8.3");
    expect(entries[0]?.values["InstallLocation"]).toBe("C:\\Program Files\\WorkBuddy");
    expect(entries[1]?.values["UninstallString"]).toContain("Uninstall WorkBuddy AI.exe");
  });

  it("空输出不产生记录", () => {
    expect(parseRegQuery("", "HKCU")).toHaveLength(0);
  });

  it("忽略无法识别的行而不抛错", () => {
    const entries = parseRegQuery("HKEY_CURRENT_USER\\X\n    garbage line\n    DisplayName    REG_SZ    A", "HKCU");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.values["DisplayName"]).toBe("A");
  });

  it("支持空字符串值", () => {
    const entries = parseRegQuery("HKEY_CURRENT_USER\\X\n    InstallLocation    REG_SZ    ", "HKCU");
    expect(entries[0]?.values["InstallLocation"]).toBe("");
  });
});
