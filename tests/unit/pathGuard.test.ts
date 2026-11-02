import { describe, expect, it } from "vitest";
import path from "node:path";
import { PathGuard, isSubPath, validateInstallTarget, versionDirectory } from "../../src/core/pathGuard";

const root = path.resolve("C:/Users/test/AppData/Local/WorkBuddyDualEdition");

describe("PathGuard", () => {
  const guard = new PathGuard({ managementRoot: root });

  it("接受管理根目录之内的子路径", () => {
    const result = guard.check(path.join(root, "WorkBuddy-CN", "versions", "5.8.3"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.relative).toBe(path.join("WorkBuddy-CN", "versions", "5.8.3"));
  });

  it("拒绝磁盘根目录", () => {
    expect(guard.check("C:\\").ok).toBe(false);
  });

  it("拒绝管理根目录本身", () => {
    expect(guard.check(root).ok).toBe(false);
  });

  it("拒绝相对路径", () => {
    expect(guard.check("WorkBuddy-CN\\versions").ok).toBe(false);
  });

  it("拒绝网络共享路径", () => {
    expect(guard.check("\\\\server\\share\\WorkBuddy").ok).toBe(false);
  });

  it("拒绝设备命名空间路径", () => {
    expect(guard.check("\\\\?\\C:\\Windows\\System32").ok).toBe(false);
  });

  it("拒绝 8.3 短名路径绕过", () => {
    const shortPath = path.join(root, "PROGRA~1", "x");
    expect(guard.check(shortPath).ok).toBe(false);
  });

  it("拒绝包含 NUL 的路径", () => {
    expect(guard.check(path.join(root, "a\u0000b")).ok).toBe(false);
  });

  it("拒绝位于管理根之外的目标", () => {
    expect(guard.check("C:\\Windows\\System32\\drivers").ok).toBe(false);
    expect(guard.check(path.resolve(root, "..", "Other")).ok).toBe(false);
  });

  it("拒绝 .. 逃逸（规范化后判定）", () => {
    const escaped = path.join(root, "WorkBuddy-CN", "..", "..", "evil");
    expect(guard.check(escaped).ok).toBe(false);
  });

  it("拒绝用户数据目录等禁写目录", () => {
    const guarded = new PathGuard({
      managementRoot: root,
      forbiddenRoots: [path.join(root, "userdata")],
    });
    expect(guarded.check(path.join(root, "userdata", ".workbuddy")).ok).toBe(false);
  });

  it("大小写不同但同一目录仍视为管理根之内", () => {
    const upper = path.join(root.toUpperCase(), "WorkBuddy-AI");
    expect(guard.check(upper).ok).toBe(true);
  });

  it("经重解析点逃逸时拒绝", async () => {
    const result = await guard.checkWithRealPath(
      path.join(root, "WorkBuddy-CN", "link"),
      async () => "C:\\Windows",
      async () => true,
    );
    expect(result.ok).toBe(false);
  });

  it("真实路径与字面路径不一致时拒绝", async () => {
    const target = path.join(root, "WorkBuddy-CN", "real");
    const result = await guard.checkWithRealPath(
      target,
      async () => path.join(root, "elsewhere"),
      async () => true,
    );
    expect(result.ok).toBe(false);
  });

  it("真实路径一致时通过", async () => {
    const target = path.join(root, "WorkBuddy-CN", "real");
    const result = await guard.checkWithRealPath(target, async () => target, async () => true);
    expect(result.ok).toBe(true);
  });
});

describe("isSubPath", () => {
  it("区分同名前缀目录", () => {
    expect(isSubPath("C:\\root", "C:\\root\\a")).toBe(true);
    expect(isSubPath("C:\\root", "C:\\root2\\a")).toBe(false);
    expect(isSubPath("C:\\root", "C:\\root")).toBe(false);
  });
});

describe("versionDirectory", () => {
  it("按产品生成独立版本目录", () => {
    const cn = versionDirectory("C:\\root", "workbuddy-cn", "5.8.3");
    const ai = versionDirectory("C:\\root", "workbuddy-ai", "5.8.4");
    expect(cn).toBe(path.join("C:\\root", "WorkBuddy-CN", "versions", "5.8.3"));
    expect(ai).toBe(path.join("C:\\root", "WorkBuddy-AI", "versions", "5.8.4"));
    expect(cn).not.toBe(ai);
  });

  it("拒绝非法版本号拼接", () => {
    expect(() => versionDirectory("C:\\root", "workbuddy-cn", "..\\..\\evil")).toThrow();
    expect(() => versionDirectory("C:\\root", "workbuddy-cn", "5.8.3/../x")).toThrow();
  });
});

/* ------------------------------------------------------------------ 用户选择的安装目标 */

describe("validateInstallTarget", () => {
  const self = path.resolve("C:/Users/test/AppData/Local/WorkBuddyDualEdition");
  const system = path.resolve("C:/Windows");
  const occupied = path.resolve("C:/Apps/WorkBuddy-CN");

  function deps(overrides: Partial<Parameters<typeof validateInstallTarget>[1]> = {}) {
    const existing = new Set<string>();
    const writable = new Set<string>();
    return {
      existing,
      writable,
      port: {
        exists: async (target: string) => existing.has(path.resolve(target)),
        isDirectory: async () => true,
        listDirectory: async () => [],
        realpath: async (target: string) => path.resolve(target),
        isWritable: async (target: string) => writable.has(path.resolve(target)),
        ...overrides,
      },
    };
  }

  it("接受尚不存在的本地目录（父目录存在且可写）", async () => {
    const d = deps();
    d.existing.add(path.resolve("C:/Apps"));
    d.writable.add(path.resolve("C:/Apps"));
    const result = await validateInstallTarget({ target: "C:/Apps/WorkBuddy-CN" }, d.port);
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (result.ok) {
      expect(result.value.absolute).toBe(path.resolve("C:/Apps/WorkBuddy-CN"));
      expect(result.value.existing).toBe(false);
    }
  });

  it("接受已存在的空目录", async () => {
    const d = deps();
    d.existing.add(path.resolve("C:/Apps/Empty"));
    d.writable.add(path.resolve("C:/Apps/Empty"));
    const result = await validateInstallTarget({ target: "C:/Apps/Empty" }, d.port);
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (result.ok) expect(result.value.existing).toBe(true);
  });

  it("拒绝已存在的非空目录", async () => {
    const d = deps({ listDirectory: async () => ["WorkBuddy.exe"] });
    d.existing.add(path.resolve("C:/Apps/Used"));
    const result = await validateInstallTarget({ target: "C:/Apps/Used" }, d.port);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("非空");
  });

  it("拒绝空路径、相对路径、UNC 与设备路径", async () => {
    const d = deps();
    for (const target of ["", "   ", "Apps/WorkBuddy", "\\\\server\\share\\WorkBuddy", "\\\\?\\C:\\Apps"]) {
      const result = await validateInstallTarget({ target }, d.port);
      expect(result.ok, target).toBe(false);
    }
  });

  it("拒绝磁盘根目录", async () => {
    const d = deps();
    const result = await validateInstallTarget({ target: "C:\\" }, d.port);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("根目录");
  });

  it("拒绝系统目录与管理器自身目录", async () => {
    const d = deps();
    const systemResult = await validateInstallTarget(
      { target: "C:/Windows/Apps/WorkBuddy", forbiddenRoots: [system] },
      d.port,
    );
    expect(systemResult.ok).toBe(false);
    if (!systemResult.ok) expect(systemResult.error.message).toContain("系统目录");

    const selfResult = await validateInstallTarget(
      { target: "C:/Users/test/AppData/Local/WorkBuddyDualEdition/Managed", selfDirectories: [self] },
      d.port,
    );
    expect(selfResult.ok).toBe(false);
    if (!selfResult.ok) expect(selfResult.error.message).toContain("管理器自身");
  });

  it("拒绝已被现有实例占用的目录，以及包含现有实例的父目录", async () => {
    const d = deps();
    const same = await validateInstallTarget({ target: occupied, occupiedDirectories: [occupied] }, d.port);
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error.message).toContain("占用");

    const parent = await validateInstallTarget(
      { target: "C:/Apps", occupiedDirectories: [occupied] },
      d.port,
    );
    expect(parent.ok).toBe(false);
    if (!parent.ok) expect(parent.error.message).toContain("包含已有");
  });

  it("父目录不存在时给出具体原因", async () => {
    const d = deps();
    const result = await validateInstallTarget({ target: "C:/NoSuchParent/WorkBuddy-CN" }, d.port);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("父目录不存在");
  });

  it("父目录不可写时返回权限错误（不尝试提权）", async () => {
    const d = deps();
    d.existing.add(path.resolve("C:/Locked"));
    const result = await validateInstallTarget({ target: "C:/Locked/WorkBuddy-CN" }, d.port);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PERMISSION");
      expect(result.error.message).toContain("无权");
    }
  });

  it("拒绝重解析点（realpath 与字面路径不一致）", async () => {
    const d = deps({ realpath: async () => path.resolve("D:/Elsewhere") });
    d.existing.add(path.resolve("C:/Apps"));
    d.writable.add(path.resolve("C:/Apps"));
    const result = await validateInstallTarget({ target: "C:/Apps/WorkBuddy-CN" }, d.port);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("重解析点");
  });
});

describe("盘符根占用：不得拦住同盘其它目录", () => {
  function deps(overrides: Partial<Parameters<typeof validateInstallTarget>[1]> = {}) {
    const existing = new Set<string>();
    const writable = new Set<string>();
    return {
      existing,
      writable,
      port: {
        exists: async (target: string) => existing.has(path.resolve(target)),
        isDirectory: async () => true,
        listDirectory: async () => [],
        realpath: async (target: string) => path.resolve(target),
        isWritable: async (target: string) => writable.has(path.resolve(target)),
        ...overrides,
      },
    };
  }

  function allowPath(d: ReturnType<typeof deps>, target: string): void {
    d.existing.add(path.resolve(path.dirname(target)));
    d.writable.add(path.resolve(path.dirname(target)));
  }

  it("occupiedDirectories 含 D:\\ 时，D:\\workbuddyCN 仍可安装", async () => {
    const d = deps();
    allowPath(d, "D:\\workbuddyCN");
    const result = await validateInstallTarget(
      { target: "D:\\workbuddyCN", occupiedDirectories: ["D:\\"] },
      d.port,
    );
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
  });

  it("空值、相对路径、非绝对路径的占用记录被忽略", async () => {
    const d = deps();
    allowPath(d, "D:\\workbuddyCN");
    const result = await validateInstallTarget(
      { target: "D:\\workbuddyCN", occupiedDirectories: ["", "   ", "workbuddyCN", "D:"] },
      d.port,
    );
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
  });

  it("盘符根本身仍被“不能安装到磁盘根目录”拒绝", async () => {
    const d = deps();
    const result = await validateInstallTarget({ target: "D:\\", occupiedDirectories: ["D:\\"] }, d.port);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("根目录");
  });

  it("并列目录允许，同路径与父目录仍拒绝", async () => {
    const d = deps();
    allowPath(d, "D:\\workbuddyCN");
    const sibling = await validateInstallTarget(
      { target: "D:\\workbuddyCN", occupiedDirectories: ["D:\\Apps\\WorkBuddy"] },
      d.port,
    );
    expect(sibling.ok, sibling.ok ? "" : sibling.error.message).toBe(true);

    const same = await validateInstallTarget(
      { target: "D:\\Apps\\WorkBuddy", occupiedDirectories: ["D:\\Apps\\WorkBuddy"] },
      d.port,
    );
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error.code).toBe("E_CONFLICT");

    const parent = await validateInstallTarget(
      { target: "D:\\Apps", occupiedDirectories: ["D:\\Apps\\WorkBuddy"] },
      d.port,
    );
    expect(parent.ok).toBe(false);
    if (!parent.ok) expect(parent.error.message).toContain("包含已有");
  });
});
