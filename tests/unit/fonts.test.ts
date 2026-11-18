import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMON_FONTS,
  SYSTEM_FONT,
  SYSTEM_STACK,
  fontLabel,
  fontStack,
  isMonoFont,
  normalizeFamily
} from "../../src/fonts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** 字体清单按平台给，换 userAgent 重新加载模块才能拿到另一套 */
async function fontsFor(userAgent: string) {
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgent });
  return import("../../src/fonts");
}

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

describe("系统默认字体", () => {
  it("默认项解析成所在平台的系统界面字体栈", async () => {
    for (const [ua, expected] of [
      [MAC_UA, "-apple-system"],
      [WIN_UA, "Segoe UI"],
      [LINUX_UA, "system-ui"]
    ] as const) {
      const mod = await fontsFor(ua);
      expect(mod.SYSTEM_FONT).toBe("system");
      expect(mod.fontStack(mod.SYSTEM_FONT)).toBe(mod.SYSTEM_STACK);
      expect(mod.SYSTEM_STACK).toContain(expected);
      expect(mod.COMMON_FONTS[0].id).toBe("system");
      expect(mod.COMMON_FONTS[0].label).toBe("系统默认");
    }
  });

  it("空字体名也退回系统默认，不会渲染成空白", () => {
    expect(fontStack("")).toBe(SYSTEM_STACK);
    expect(fontLabel("")).toBe("系统默认");
  });

  it("中文界面字体在三个平台的清单里都有，不会只给英文字体", async () => {
    for (const [ua, name] of [
      [MAC_UA, "PingFang SC"],
      [WIN_UA, "Microsoft YaHei"],
      [LINUX_UA, "Noto Sans CJK SC"]
    ] as const) {
      const mod = await fontsFor(ua);
      expect(mod.COMMON_FONTS.some((f) => f.id === name)).toBe(true);
    }
  });

  it("各平台都带等宽字体，记事本里要对齐时有的选", async () => {
    for (const ua of [MAC_UA, WIN_UA, LINUX_UA]) {
      const mod = await fontsFor(ua);
      const mono = mod.COMMON_FONTS.filter((f) => f.mono);
      expect(mono.length).toBeGreaterThanOrEqual(3);
      expect(mono.every((f) => f.stack.includes("monospace"))).toBe(true);
    }
  });

  it("Windows 清单里是系统自带的字体，macOS 清单里不混进 Segoe UI", async () => {
    const win = await fontsFor(WIN_UA);
    expect(win.COMMON_FONTS.some((f) => f.id === "Consolas")).toBe(true);
    expect(win.COMMON_FONTS.some((f) => f.id === "SimSun")).toBe(true);
    const mac = await fontsFor(MAC_UA);
    expect(mac.COMMON_FONTS.some((f) => f.id === "Menlo")).toBe(true);
    expect(mac.COMMON_FONTS.some((f) => f.id === "Segoe UI")).toBe(false);
  });
});

describe("字体栈解析", () => {
  it("清单里的每一项都能解析出含自身名字的字体栈", () => {
    for (const f of COMMON_FONTS) {
      const stack = fontStack(f.id);
      expect(stack.length).toBeGreaterThan(0);
      if (f.id !== SYSTEM_FONT) expect(stack).toContain(f.id);
    }
  });

  it("清单 id 不重复，标签也不为空", () => {
    const ids = COMMON_FONTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(COMMON_FONTS.every((f) => f.label.trim().length > 0)).toBe(true);
  });

  it("没收录的名字按自定义字体处理，后面挂系统栈兜底", () => {
    expect(fontStack("JetBrains Mono")).toBe(`"JetBrains Mono", ${SYSTEM_STACK}`);
    expect(fontLabel("JetBrains Mono")).toBe("JetBrains Mono");
    expect(isMonoFont("JetBrains Mono")).toBe(false);
  });

  it("自定义名字里的引号分号花括号被清掉，拼不进别的样式声明", () => {
    expect(normalizeFamily('Foo"; color: red; {')).toBe("Foo color: red");
    expect(normalizeFamily("  A   B  ")).toBe("A B");
    expect(normalizeFamily("<script>")).toBe("script");
    expect(normalizeFamily("x".repeat(200))).toHaveLength(80);
    const stack = fontStack('Bad"; background: url(x); "');
    expect(stack).not.toContain('";');
    expect(stack.endsWith(SYSTEM_STACK)).toBe(true);
  });

  it("全是危险字符的名字退回系统默认", () => {
    expect(fontStack('"";;{}')).toBe(SYSTEM_STACK);
    expect(fontLabel('"";;{}')).toBe("系统默认");
  });

  it("等宽标记只给清单里的等宽字体", () => {
    for (const f of COMMON_FONTS) expect(isMonoFont(f.id)).toBe(f.mono);
  });
});