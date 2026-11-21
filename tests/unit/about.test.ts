import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import conf from "../../src-tauri/tauri.conf.json";
import { APP_VERSION, diagnosticsText, openAbout } from "../../src/about";
import { cfg } from "../../src/config";
import { SYSTEM_FONT } from "../../src/fonts";
import { $q, $qa, click, flush, keydown, mouse } from "../helpers/dom";
import {
  APP_CONFIG_PATH,
  APP_DIR,
  APP_EXE_PATH,
  installTauriMock,
  type TauriMock
} from "../helpers/tauri-mock";

let mock: TauriMock;
let paletteCalls = 0;
let closeCalls = 0;

function open(tabs = 3) {
  openAbout({ tabs, onPalette: () => paletteCalls++, onClose: () => closeCalls++ });
}

const box = () => $q(".about-box");
const tabs = () => $qa<HTMLButtonElement>(".about-tab");
const activeTab = () => $q(".about-tab.active").textContent;
const panel = (id: string) => $q(`#about-panel-${id}`);
const visiblePanel = () => $qa(".about-slot").find((s) => !s.hidden)!;
const btn = (text: string) =>
  $qa<HTMLButtonElement>(".about-btn").find((b) => b.textContent === text)!;
const envValue = (key: string) =>
  $qa(".about-env-row").find((r) => r.querySelector(".about-env-key")?.textContent === key)
    ?.querySelector(".about-env-value")?.textContent;

beforeEach(() => {
  document.body.innerHTML = "";
  paletteCalls = 0;
  closeCalls = 0;
  cfg.theme = "light";
  cfg.fontFamily = SYSTEM_FONT;
  cfg.fontSize = 15;
  cfg.wrap = true;
  cfg.autoSave = true;
  cfg.minimap = true;
  cfg.preview = true;
  cfg.startupLog = false;
  cfg.folders = ["/demo"];
  mock = installTauriMock({ config: { theme: "light" } });
});

afterEach(() => {
  keydown(document.body, "Escape");
  mock.uninstall();
  document.body.innerHTML = "";
});

describe("版本号", () => {
  it("前端与打包配置同版本，Rust crate 那份由后端测试守住", () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(conf.version).toBe(pkg.version);
    expect(pkg.version).toBe("0.2.9");
  });
});

describe("关于面板", () => {
  it("打开即展示名称、版本与四个分页，默认停在功能页", () => {
    open();
    expect(box().getAttribute("role")).toBe("dialog");
    expect(box().getAttribute("aria-modal")).toBe("true");
    expect($q(".about-name").textContent).toBe("RocketNotePad");
    expect($q(".about-version").textContent).toBe("v" + APP_VERSION);
    expect(tabs().map((t) => t.textContent)).toEqual(["功能", "架构", "运行环境", "快捷键"]);
    expect(activeTab()).toBe("功能");
    expect(visiblePanel().id).toBe("about-panel-features");
    // 焦点落在分页条上，打开就能用左右键翻
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it("功能页把整体能力讲清楚，语言数量跟着实际列表走", async () => {
    const { LANGUAGES } = await import("../../src/languages");
    open();
    const text = panel("features").textContent ?? "";
    for (const keyword of [
      "多标签编辑",
      "停顿即存",
      "查找与替换",
      "格式化文档",
      "文件夹式工作流",
      "删除进回收站",
      "编码与换行",
      "大文件保护",
      `${LANGUAGES.length} 种语言高亮`,
      "Markdown 实时预览",
      "Minimap 缩略图",
      "跳转任意处",
      "明暗双主题",
      "字体自由",
      "会话恢复",
      "启动可观测"
    ]) {
      expect(text).toContain(keyword);
    }
    expect($qa("#about-panel-features .about-card")).toHaveLength(17);
    expect($qa("#about-panel-features .about-group-title")).toHaveLength(4);
  });

  it("架构页画出三层与各自模块，并说明关键取舍", () => {
    open();
    click(tabs()[1]);
    expect(activeTab()).toBe("架构");
    expect(visiblePanel().id).toBe("about-panel-arch");
    expect($qa(".about-layer").map((l) => l.querySelector(".about-layer-name")?.textContent)).toEqual([
      "前端 · TypeScript",
      "桥 · Tauri 2 IPC",
      "后端 · Rust 原生进程"
    ]);
    const chips = $qa(".about-chip-name").map((c) => c.textContent);
    for (const mod of ["main.ts", "editor.ts", "config.ts", "files.rs", "startup.rs", "menu.rs", "paths.rs"]) {
      expect(chips).toContain(mod);
    }
    const notes = panel("arch").textContent ?? "";
    expect(notes).toContain("为什么是 Tauri");
    expect(notes).toContain("Compartment");
    expect(notes).toContain("DOMPurify");
    expect(notes).toContain("交付形态");
  });

  it("左右键与 Home/End 在分页间移动，选中项跟着走", () => {
    open();
    keydown(tabs()[0], "ArrowRight");
    expect(activeTab()).toBe("架构");
    expect(document.activeElement).toBe(tabs()[1]);
    keydown(tabs()[1], "ArrowLeft");
    expect(activeTab()).toBe("功能");
    keydown(tabs()[0], "End");
    expect(activeTab()).toBe("快捷键");
    expect(document.activeElement).toBe(tabs()[3]);
    keydown(tabs()[3], "Home");
    expect(activeTab()).toBe("功能");
    // 循环：第一项再往左回到最后一项
    keydown(tabs()[0], "ArrowLeft");
    expect(activeTab()).toBe("快捷键");
  });

  it("运行环境页报的是后端给的真实路径与当前设置", async () => {
    cfg.theme = "dark";
    cfg.fontSize = 18;
    cfg.startupLog = true;
    open(5);
    click(tabs()[2]);
    await flush();
    expect(envValue("版本")).toBe(APP_VERSION);
    expect(envValue("运行平台")).toBe("macOS · aarch64");
    expect(envValue("网页引擎")).toContain("WKWebView");
    expect(envValue("配置文件")).toBe(APP_CONFIG_PATH);
    expect(envValue("应用目录")).toBe(APP_DIR);
    expect(envValue("可执行文件")).toBe(APP_EXE_PATH);
    expect(envValue("当前外观")).toBe("暗色 · 系统默认 · 18px · 自动换行开");
    expect(envValue("启动日志")).toBe("全程记录每次启动");
    expect(envValue("本次会话")).toBe("5 个标签 · 1 个文件夹");
    expect($q(".about-foot-note").textContent).toContain("~/.rocketnote");
  });

  it("后端信息拿不到时给出可读的占位，不留空白行", async () => {
    mock.fail("app_info", "命令不可用");
    open();
    click(tabs()[2]);
    await flush();
    expect(envValue("配置文件")).toBe("不可用");
    expect(envValue("运行平台")).toBe("不可用");
    expect(btn("打开配置文件夹").disabled).toBe(true);
  });

  it("复制诊断信息把版本、路径与设置整段写进剪贴板", async () => {
    open(2);
    await flush();
    click(btn("复制诊断信息"));
    await flush();
    const text = String(mock.lastCall("plugin:clipboard-manager|write_text")?.args.text);
    expect(text).toContain("RocketNotePad " + APP_VERSION);
    expect(text).toContain("配置文件：" + APP_CONFIG_PATH);
    expect(text).toContain("本次会话：2 个标签 · 1 个文件夹");
    expect(btn("已复制")).toBeTruthy();
    expect(diagnosticsText(null, 2)).toContain("读取中…");
  });

  it("复制失败时就地提示，不弹系统对话框", async () => {
    mock.fail("plugin:clipboard-manager|write_text", "剪贴板被占用");
    open();
    await flush();
    click(btn("复制诊断信息"));
    await flush();
    expect(btn("复制失败")).toBeTruthy();
    expect(mock.messages).toHaveLength(0);
  });

  it("打开配置文件夹定位到真实的配置文件", async () => {
    open();
    await flush();
    expect(btn("打开配置文件夹").disabled).toBe(false);
    click(btn("打开配置文件夹"));
    await flush();
    expect(mock.lastCall("reveal_in_file_manager")?.args.path).toBe(APP_CONFIG_PATH);
  });

  it("配置还没生成时退而打开应用目录", async () => {
    mock.uninstall();
    mock = installTauriMock();
    open();
    await flush();
    click(btn("打开配置文件夹"));
    await flush();
    expect(mock.lastCall("reveal_in_file_manager")?.args.path).toBe(APP_DIR);
  });

  it("目录也打不开时把路径念给用户", async () => {
    mock.fail("reveal_in_file_manager", "路径不存在");
    open();
    await flush();
    click(btn("打开配置文件夹"));
    await flush();
    expect(mock.messages.at(-1)?.title).toBe("配置文件位置");
    expect(mock.messages.at(-1)?.message).toContain(APP_DIR);
  });

  it("命令面板按钮先关掉关于再打开面板", () => {
    open();
    click(btn("命令面板"));
    expect(box()).toBeFalsy();
    expect(paletteCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });

  it("Esc、关闭按钮与点遮罩都能关闭，且只回调一次", () => {
    open();
    keydown(document.body, "Escape");
    expect(box()).toBeFalsy();
    expect(closeCalls).toBe(1);

    open();
    click($q(".about-close"));
    expect(box()).toBeFalsy();
    expect(closeCalls).toBe(2);

    open();
    mouse($q(".about-overlay"), "mousedown");
    expect(box()).toBeFalsy();
    expect(closeCalls).toBe(3);
    // 关闭后再按 Esc 不该重复回调
    keydown(document.body, "Escape");
    expect(closeCalls).toBe(3);
  });

  it("点面板内部不会误关", () => {
    open();
    mouse($q(".about-head"), "mousedown");
    expect(box()).toBeTruthy();
    expect(closeCalls).toBe(0);
  });

  it("重复打开只留一个面板", () => {
    open();
    open();
    expect($qa(".about-overlay")).toHaveLength(1);
    expect(closeCalls).toBe(0);
  });

  it("模态期间按键不落到背后的编辑器，Tab 焦点始终在面板内", () => {
    const behind = document.createElement("div");
    behind.contentEditable = "true";
    const seen = vi.fn();
    behind.addEventListener("keydown", seen);
    document.body.appendChild(behind);
    behind.focus();
    open();
    keydown(behind, "a");
    keydown(behind, "p", { metaKey: true });
    expect(seen).not.toHaveBeenCalled();

    const focusable = () =>
      $qa<HTMLElement>('.about-box button:not([disabled]):not([tabindex="-1"]), .about-box [tabindex="0"]');
    for (let i = 0; i < focusable().length + 2; i++) {
      keydown(document.activeElement ?? document.body, "Tab");
      expect(box().contains(document.activeElement)).toBe(true);
    }
    keydown(document.activeElement ?? document.body, "Tab", { shiftKey: true });
    expect(box().contains(document.activeElement)).toBe(true);
    behind.remove();
  });

  it("快捷键页按当前系统渲染，覆盖文件、查找、导航与资源管理器", () => {
    open();
    click(tabs()[3]);
    const text = panel("keys").textContent ?? "";
    for (const group of ["文件", "编辑", "查找与替换", "导航", "视图", "资源管理器"]) {
      expect(text).toContain(group);
    }
    expect($qa("#about-panel-keys .about-key-row").length).toBeGreaterThan(20);
    expect(text).toContain("F2");
    expect(text).toContain("Delete");
    // jsdom 的 userAgent 不是 macOS，应当显示 Ctrl 而不是 ⌘
    expect(text).toContain("Ctrl+S");
    expect(text).not.toContain("⌘");
  });

  it("关闭后清掉文档级监听，不干扰后续浮窗", () => {
    const spy = vi.spyOn(document, "removeEventListener");
    open();
    keydown(document.body, "Escape");
    expect(spy.mock.calls.some((c) => c[0] === "keydown" && c[2] === true)).toBe(true);
  });
});
