import { afterEach, describe, expect, it, vi } from "vitest";
import { installTauriMock, type TauriMock, type TauriMockOptions } from "../helpers/tauri-mock";
import type { AppConfig } from "../../src/config";

type ConfigModule = typeof import("../../src/config");

let mocks: TauriMock[] = [];

afterEach(() => {
  vi.useRealTimers();
  mocks.forEach((m) => m.uninstall());
  mocks = [];
  localStorage.clear();
});

/**
 * 配置模块内部是单例：每个用例重置模块图，才能拿到一份干净的 cfg。
 */
async function load(options: TauriMockOptions = {}, storage: Record<string, string> = {}) {
  localStorage.clear();
  for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
  vi.resetModules();
  const mock = installTauriMock(options);
  mocks.push(mock);
  const mod: ConfigModule = await import("../../src/config");
  await mod.loadConfig();
  return { mock, mod, cfg: mod.cfg };
}

const DEFAULT_VIEW = {
  theme: "light",
  fontSize: 15,
  fontFamily: "system",
  wrap: true,
  preview: true,
  autoSave: true,
  minimap: true,
  sidebarVisible: true,
  startupLog: false,
  editLimitMB: 64,
  maxFileMB: 256,
  folders: [],
  restoreTabs: [],
  restoreActive: ""
} satisfies AppConfig;

describe("配置默认值", () => {
  it("没有配置文件也没有旧数据时全部取默认，且不写盘", async () => {
    const { cfg, mock } = await load();
    expect(cfg).toEqual(DEFAULT_VIEW);
    expect(mock.invokeLog("write_app_config")).toHaveLength(0);
  });

  it("默认字号是 15px", async () => {
    const { mod } = await load();
    expect(mod.DEFAULT_FONT_SIZE).toBe(15);
    expect(mod.cfg.fontSize).toBe(15);
  });
});

describe("文件大小档位", () => {
  it("默认 64/256 MB，非法值回默认", async () => {
    const { cfg } = await load();
    expect(cfg.editLimitMB).toBe(64);
    expect(cfg.maxFileMB).toBe(256);
    const bad = await load({ config: { editLimitMB: 0, maxFileMB: "x" } });
    expect(bad.cfg.editLimitMB).toBe(64);
    expect(bad.cfg.maxFileMB).toBe(256);
  });

  it("配置文件里的合法档位覆盖默认", async () => {
    const { cfg } = await load({ config: { editLimitMB: 8, maxFileMB: 64 } });
    expect(cfg.editLimitMB).toBe(8);
    expect(cfg.maxFileMB).toBe(64);
  });
});

describe("读取配置文件", () => {
  it("文件里的合法字段覆盖默认值", async () => {
    const { cfg } = await load({
      config: {
        theme: "dark",
        fontSize: 20,
        fontFamily: "Consolas",
        wrap: false,
        preview: false,
        autoSave: false,
        minimap: false,
        sidebarVisible: false,
        startupLog: true,
        folders: ["/demo"],
        restoreTabs: ["/demo/a.md"],
        restoreActive: "/demo/a.md"
      }
    });
    expect(cfg).toEqual({
      theme: "dark",
      fontSize: 20,
      fontFamily: "Consolas",
      wrap: false,
      preview: false,
      autoSave: false,
      minimap: false,
      sidebarVisible: false,
      startupLog: true,
      editLimitMB: 64,
      maxFileMB: 256,
      folders: ["/demo"],
      restoreTabs: ["/demo/a.md"],
      restoreActive: "/demo/a.md"
    });
  });

  it("非法字段逐条丢弃，其余照常生效", async () => {
    const { cfg, mock } = await load({
      config: { theme: "neon", fontSize: "20", wrap: "yes", folders: [1, "/ok"], minimap: false }
    });
    expect(mock.configJson()?.folders).toEqual([1, "/ok"]);
    expect(cfg.theme).toBe("light");
    expect(cfg.fontSize).toBe(15);
    expect(cfg.wrap).toBe(true);
    expect(cfg.folders).toEqual([]);
    expect(cfg.minimap).toBe(false);
  });

  it("内容不是 JSON 对象时按默认值启动", async () => {
    for (const bad of ["{ 半个 json", "[]", "3", "null"]) {
      const { cfg, mock } = await load({ config: bad });
      expect(cfg).toEqual(DEFAULT_VIEW);
      expect(mock.invokeLog("write_app_config")).toHaveLength(0);
    }
  });

  it("后端读失败时按默认值启动，不抛错", async () => {
    localStorage.clear();
    vi.resetModules();
    const mock = installTauriMock({ config: { fontSize: 30 } });
    mocks.push(mock);
    mock.fail("read_app_config", "磁盘损坏");
    const mod: ConfigModule = await import("../../src/config");
    await mod.loadConfig();
    expect(mod.cfg).toEqual(DEFAULT_VIEW);
    expect(mock.configJson()?.fontSize).toBe(30);
  });
});

describe("字体配置", () => {
  it("默认跟随系统，而不是写死某一款字体", async () => {
    const { cfg } = await load();
    expect(cfg.fontFamily).toBe("system");
  });

  it("选定的字体落盘后下次启动还在", async () => {
    const { cfg, mod, mock } = await load();
    cfg.fontFamily = "Menlo";
    await mod.saveConfigNow();
    expect(mock.configJson()?.fontFamily).toBe("Menlo");
    const again = await load({ config: mock.configJson()! });
    expect(again.cfg.fontFamily).toBe("Menlo");
  });

  it("空串、非字符串和超长值都按默认档处理", async () => {
    for (const bad of ["", "   ", 12, null, [], "x".repeat(81)]) {
      const { cfg } = await load({ config: { fontFamily: bad } });
      expect(cfg.fontFamily).toBe("system");
    }
  });

  it("旧版 localStorage 里的字体也能搬过来", async () => {
    const { cfg } = await load({}, { "rnp.fontFamily": "Consolas" });
    expect(cfg.fontFamily).toBe("Consolas");
  });
});

describe("启动日志开关", () => {
  it("默认关闭：没有这个字段时不会往目录里写日志", async () => {
    const { cfg } = await load({ config: { theme: "light" } });
    expect(cfg.startupLog).toBe(false);
  });

  it("文件里开着就记着，改回去也能落盘", async () => {
    const { cfg, mod, mock } = await load({ config: { startupLog: true } });
    expect(cfg.startupLog).toBe(true);
    cfg.startupLog = false;
    await mod.saveConfigNow();
    expect(mock.configJson()?.startupLog).toBe(false);
  });

  it("坏值按默认档处理，不能让应用起不来", async () => {
    for (const bad of ["yes", 1, null, []]) {
      const { cfg } = await load({ config: { startupLog: bad } });
      expect(cfg.startupLog).toBe(false);
    }
  });
});

describe("从旧版 localStorage 迁移", () => {
  const legacy = {
    "rnp.theme": "dark",
    "rnp.fontSize": "18",
    "rnp.wrap": "0",
    "rnp.preview": "0",
    "rnp.autoSave": "0",
    "rnp.minimap": "0",
    "rnp.sidebar": "0",
    "rnp.folders": JSON.stringify(["/demo"]),
    "rnp.restoreTabs": JSON.stringify(["/demo/note.md"]),
    "rnp.activePath": "/demo/note.md"
  };

  it("没有配置文件时把旧的 rnp.* 搬进文件", async () => {
    const { cfg, mock } = await load({}, legacy);
    expect(cfg).toEqual({
      theme: "dark",
      fontSize: 18,
      fontFamily: "system",
      wrap: false,
      preview: false,
      autoSave: false,
      minimap: false,
      sidebarVisible: false,
      startupLog: false,
      editLimitMB: 64,
      maxFileMB: 256,
      folders: ["/demo"],
      restoreTabs: ["/demo/note.md"],
      restoreActive: "/demo/note.md"
    });
    expect(mock.configJson()).toEqual(cfg);
    expect(mock.invokeLog("write_app_config")).toHaveLength(1);
  });

  it("配置文件已存在时不再看旧数据", async () => {
    const { cfg } = await load({ config: { fontSize: 30 } }, { "rnp.fontSize": "11" });
    expect(cfg.fontSize).toBe(30);
  });

  it("旧值解析不出来就跳过，且不产生写入", async () => {
    const { cfg, mock } = await load({}, { "rnp.folders": "不是数组", "rnp.fontSize": "abc" });
    expect(cfg.folders).toEqual([]);
    expect(cfg.fontSize).toBe(15);
    expect(mock.invokeLog("write_app_config")).toHaveLength(0);
  });

  it("只迁移出现过的键，缺省键保持默认", async () => {
    const { cfg } = await load({}, { "rnp.theme": "dark", "rnp.minimap": "0" });
    expect(cfg.theme).toBe("dark");
    expect(cfg.minimap).toBe(false);
    expect(cfg.sidebarVisible).toBe(true);
    expect(cfg.autoSave).toBe(true);
  });
});

describe("写入配置文件", () => {
  it("改动防抖合并：连点两次只落一次盘", async () => {
    const { cfg, mod, mock } = await load({ config: { fontSize: 15 } });
    vi.useFakeTimers();
    cfg.fontSize = 16;
    mod.saveConfig();
    cfg.fontSize = 17;
    mod.saveConfig();
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    expect(mock.invokeLog("write_app_config")).toHaveLength(1);
    expect(mock.configJson()?.fontSize).toBe(17);
  });

  it("退出前的立即落盘会取消挂起的防抖", async () => {
    const { cfg, mod, mock } = await load({ config: { fontSize: 15 } });
    cfg.fontSize = 22;
    mod.saveConfig();
    await mod.saveConfigNow();
    expect(mock.invokeLog("write_app_config")).toHaveLength(1);
    expect(mock.configJson()?.fontSize).toBe(22);
  });

  it("加载完成前不写盘，避免默认值盖掉真实配置", async () => {
    localStorage.clear();
    vi.resetModules();
    const mock = installTauriMock({ config: { fontSize: 22 } });
    mocks.push(mock);
    const mod: ConfigModule = await import("../../src/config");
    mod.cfg.fontSize = 15;
    mod.saveConfig();
    await mod.saveConfigNow();
    expect(mock.invokeLog("write_app_config")).toHaveLength(0);
    expect(mock.configJson()?.fontSize).toBe(22);
    await mod.loadConfig();
    expect(mod.cfg.fontSize).toBe(22);
  });

  it("写不进去时静默失败，内存里的设置仍然生效", async () => {
    const { cfg, mod, mock } = await load();
    mock.fail("write_app_config", "只读目录");
    cfg.fontSize = 24;
    await mod.saveConfigNow();
    expect(cfg.fontSize).toBe(24);
    expect(mock.configJson()).toBeNull();
  });
});
