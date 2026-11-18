import { beforeAll, describe, expect, it } from "vitest";
import { version } from "../../package.json";
import { demoFs, type TauriMock } from "../helpers/tauri-mock";
import {
  $id,
  $q,
  $qa,
  bootApp,
  click,
  dblClickRow,
  editorContent,
  flush,
  globalKey,
  keydown,
  mouse,
  tabStates,
  until,
  viewFromDom,
  type BootedApp
} from "../helpers/dom";

let app: BootedApp;
let mock: TauriMock;

const bare = (name: string) => name.replace(/^● /, "");
const tab = (name: string) => tabStates().find((t) => bare(t.name) === name);
const tabEl = (name: string): HTMLElement =>
  $qa("#tabbar .tab")[tabStates().findIndex((t) => bare(t.name) === name)];

async function openFile(name: string): Promise<void> {
  dblClickRow(name);
  await until(() => tab(name)?.active === true);
}

/** 命令面板条目用 mousedown 触发，click 不会执行 */
function itemByTitle(title: string): HTMLElement {
  const el = $qa(".palette-item").find((i) => (i.textContent ?? "").includes(title));
  if (!el) throw new Error(`面板缺少 "${title}"`);
  return el;
}

/** 打开命令面板，按查询命中第一项并回车执行 */
async function paletteRun(query: string): Promise<void> {
  globalKey("p", { metaKey: true, shiftKey: true });
  await until(() => !!$q(".palette-overlay .palette-input"));
  const input = $q<HTMLInputElement>(".palette-overlay .palette-input");
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush(10);
  keydown(input, "Enter");
  await flush(30);
}

async function menu(id: string): Promise<void> {
  mock.emit("menu-action", id);
  await flush(30);
}

beforeAll(async () => {
  app = await bootApp({
    fs: demoFs(),
    storage: { "rnp.folders": JSON.stringify(["/demo"]) }
  });
  mock = app.mock;
  await until(() => !!$id("sidebar-tree"));
});

describe("命令面板", () => {
  it("⇧⌘P 打开面板，命令标题与快捷键全中文", async () => {
    globalKey("p", { metaKey: true, shiftKey: true });
    await until(() => !!$q(".palette-overlay"));
    expect($q<HTMLInputElement>(".palette-input").placeholder).toBe("输入命令…");
    const titles = $qa(".palette-item").map((i) => i.querySelector("span")!.textContent ?? "");
    expect(titles).toEqual(expect.arrayContaining([
      "文件: 新建",
      "文件: 保存",
      "文件: 另存为…",
      "查找: 查找/替换",
      "转到: 跳转任意处…",
      "视图: 切换侧边栏",
      "视图: 切换 Markdown 预览",
      "语言: 选择语言…"
    ]));
    expect($qa(".palette-item").length).toBeLessThanOrEqual(50);
    keydown($q<HTMLInputElement>(".palette-input"), "Escape");
    expect($q(".palette-overlay")).toBeNull();
  });

  it("执行“自动保存”命令会切换开关并写入配置文件", async () => {
    await until(() => mock.configJson()?.autoSave === true);
    await paletteRun("自动保存");
    await until(() => mock.configJson()?.autoSave === false);
    const titles = await (async () => {
      globalKey("p", { metaKey: true, shiftKey: true });
      await until(() => !!$q(".palette-overlay"));
      const input = $q<HTMLInputElement>(".palette-overlay .palette-input");
      input.value = "自动保存";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush(10);
      return $qa(".palette-item").map((i) => i.textContent ?? "");
    })();
    expect(titles[0]).toContain("文件: 自动保存（当前关闭）");
    keydown($q<HTMLInputElement>(".palette-overlay .palette-input"), "Escape");
  });

  it("模糊匹配支持中文与英文混排过滤", async () => {
    globalKey("p", { metaKey: true, shiftKey: true });
    await until(() => !!$q(".palette-overlay"));
    const input = $q<HTMLInputElement>(".palette-overlay .palette-input");
    input.value = "minimap";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(10);
    const items = $qa(".palette-item").map((i) => i.querySelector("span")!.textContent ?? "");
    expect(items).toContain("视图: 切换 Minimap");
    input.value = "不存在的命令";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(10);
    expect($q(".palette-empty")?.textContent).toBe("无匹配项");
    keydown(input, "Escape");
  });

  it("“视图: 切换明暗主题”命令改变主题与状态栏", async () => {
    expect(document.body.dataset.theme).toBe("light");
    await paletteRun("切换明暗主题");
    expect(document.body.dataset.theme).toBe("dark");
    expect($id("st-theme").textContent).toBe("暗色");
    await until(() => mock.configJson()?.theme === "dark");
    await paletteRun("切换明暗主题");
    expect(document.body.dataset.theme).toBe("light");
  });
});

describe("语言模式", () => {
  beforeAll(async () => {
    await openFile("note.md");
  });

  it("状态栏语言项点击后列出全部语言并可手动选择", async () => {
    expect($id("st-lang").textContent).toBe("Markdown");
    click($id("st-lang"));
    await until(() => !!$q(".palette-overlay"));
    const items = $qa(".palette-item").map((i) => i.querySelector("span")!.textContent ?? "");
    expect(items[0]).toBe("语言: 按扩展名自动判断");
    expect(items).toContain("语言: Python");
    mouse(itemByTitle("语言: Python"), "mousedown");
    await flush(30);
    expect($id("st-lang").textContent).toBe("Python");
    expect($id("st-lang").title).toContain("已手动选择 Python");
  });

  it("“按扩展名自动判断”恢复语言推断", async () => {
    click($id("st-lang"));
    await until(() => !!$q(".palette-overlay .palette-input"));
    const input = $q<HTMLInputElement>(".palette-overlay .palette-input");
    input.value = "自动判断";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(10);
    mouse(itemByTitle("语言: 按扩展名自动判断"), "mousedown");
    await flush(30);
    expect($id("st-lang").textContent).toBe("Markdown");
    expect($id("st-lang").title).toBe("点击选择语言模式");
  });
});

describe("跳转面板", () => {
  it("⌘P 打开文件跳转并列出目录树里的文本文件", async () => {
    globalKey("p", { metaKey: true });
    await until(() => !!$q(".palette-overlay"));
    expect($q<HTMLInputElement>(".palette-input").placeholder).toContain("跳转到文件");
    const labels = $qa(".palette-item").map((i) => i.querySelector("span")!.textContent ?? "");
    expect(labels).toEqual(expect.arrayContaining(["note.md", "a.cpp", "Dockerfile"]));
    keydown($q<HTMLInputElement>(".palette-overlay .palette-input"), "Escape");
  });

  it("输入 :行号 跳转到当前文件的指定行", async () => {
    globalKey("p", { metaKey: true });
    await until(() => !!$q(".palette-overlay"));
    const input = $q<HTMLInputElement>(".palette-overlay .palette-input");
    input.value = ":2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(10);
    expect($qa(".palette-item")[0].textContent).toContain("跳转到第 2 行");
    keydown(input, "Enter");
    await until(() => $id("st-pos").textContent === "行 2, 列 1");
  });

  const gotoField = () => $q<HTMLInputElement>('.cm-goto-line input[name="line"]');

  it("Ctrl+G 打开跳转到行浮窗", async () => {
    globalKey("g", { ctrlKey: true });
    await until(() => !!$q(".cm-goto-line"));
    expect($q<HTMLElement>(".cm-goto-line")!.textContent).toContain("跳转到行");
    expect(gotoField()!.value).toMatch(/^\d+$/);
    gotoField()!.value = "3";
    keydown(gotoField()!, "Enter");
    await until(() => $id("st-pos").textContent === "行 3, 列 1");
    await until(() => !$q(".cm-goto-line"));
  });

  it("浮窗关闭按钮放弃跳转且不改变光标", async () => {
    globalKey("g", { ctrlKey: true });
    await until(() => !!$q(".cm-goto-line"));
    const before = $id("st-pos").textContent;
    gotoField()!.value = "9";
    keydown(gotoField()!, "Escape");
    await until(() => !$q(".cm-goto-line"));
    expect($id("st-pos").textContent).toBe(before);
    // 关闭按钮与 Esc 行为一致
    globalKey("g", { ctrlKey: true });
    await until(() => !!$q(".cm-goto-line"));
    mouse($q(".cm-goto-line .cm-dialog-close")!, "click");
    await until(() => !$q(".cm-goto-line"));
    expect($id("st-pos").textContent).toBe(before);
  });

  it("“转到: 跳转到行…”命令同样打开浮窗", async () => {
    await paletteRun("跳转到行");
    await until(() => !!$q(".cm-goto-line"));
    keydown(gotoField()!, "Escape");
    await until(() => !$q(".cm-goto-line"));
  });
});

describe("原生菜单动作", () => {
  it("menu-action 事件驱动新建、打开、关于", async () => {
    const before = tabStates().length;
    await menu("file.new");
    expect(tabStates()).toHaveLength(before + 1);
    const untitled = tabStates().at(-1)!;
    expect(untitled.name).toMatch(/^未命名 \d+$/);
    expect(untitled.active).toBe(true);
    expect(tabEl(untitled.name).title).toBe("未保存的新文件");
    expect($id("st-size").textContent).toBe("未保存");
    await menu("help.about");
    expect($q(".about-box")).toBeTruthy();
    expect($q(".about-name").textContent).toBe("RocketNotePad");
    expect($q(".about-version").textContent).toBe("v" + version);
    expect($qa(".about-tab").map((t) => t.textContent)).toEqual(["功能", "架构", "运行环境", "快捷键"]);
    keydown(document.body, "Escape");
    await until(() => !$q(".about-box"));
  });

  it("app.quit 走窗口关闭命令", async () => {
    await menu("app.quit");
    expect(mock.calls.some((c) => c.cmd.startsWith("plugin:window"))).toBe(true);
  });

  it("视图类命令切换侧边栏、Minimap、预览与换行", async () => {
    await menu("view.sidebar");
    expect($id("sidebar").classList.contains("hidden")).toBe(true);
    await until(() => mock.configJson()?.sidebarVisible === false);
    await menu("view.sidebar");
    expect($id("sidebar").classList.contains("hidden")).toBe(false);

    await menu("view.minimap");
    expect($id("minimap").style.display).toBe("none");
    await until(() => mock.configJson()?.minimap === false);
    await menu("view.minimap");
    expect($id("minimap").style.display).toBe("block");

    await menu("view.wrap");
    expect($id("st-wrap").textContent).toBe("自动换行: 关");
    await menu("view.wrap");
    expect($id("st-wrap").textContent).toBe("自动换行: 开");

    await openFile("note.md");
    await menu("view.preview");
    expect($id("preview-pane").classList.contains("hidden")).toBe(true);
    await menu("view.preview");
    expect($id("preview-pane").classList.contains("hidden")).toBe(false);
  });

  it("缩放命令更新状态栏并夹在 9–40 之间", async () => {
    for (let i = 0; i < 3; i++) await menu("view.zoom_in");
    expect($id("st-zoom").textContent).toBe("缩放 18px");
    for (let i = 0; i < 30; i++) await menu("view.zoom_out");
    expect($id("st-zoom").textContent).toBe("缩放 9px");
    await menu("view.zoom_reset");
    expect($id("st-zoom").textContent).toBe("缩放 15px");
    await until(() => mock.configJson()?.fontSize === 15);
  });

  it("查找与多选命令作用于活动文档", async () => {
    await openFile("note.md");
    const view = viewFromDom();
    view.dispatch({ selection: { anchor: 0 } });
    await menu("find.open");
    await until(() => !!$q(".rnp-find"));
    await menu("find.next");
    keydown($q<HTMLElement>(".rnp-find")!, "Escape");
    await until(() => !$q(".rnp-find"));
    await menu("select.next_occurrence");
    expect(view.state.selection.ranges.length).toBeGreaterThanOrEqual(1);
  });

  it("view.palette 打开命令面板", async () => {
    await menu("view.palette");
    await until(() => !!$q(".palette-overlay"));
    expect($qa(".palette-item").length).toBeGreaterThan(5);
    keydown($q<HTMLInputElement>(".palette-overlay .palette-input"), "Escape");
  });

  it("未知菜单 id 不产生副作用", async () => {
    const before = mock.messages.length;
    await menu("does.not.exist");
    expect(mock.messages).toHaveLength(before);
  });
});

describe("打开对话框", () => {
  it("⌘O 选择文件后打开，取消则不变", async () => {
    const before = tabStates().length;
    mock.dialogs.open.length = 0;
    mock.dialogs.open.push("/demo/Zeta/readme.md");
    globalKey("o", { metaKey: true });
    await until(() => tab("readme.md")?.active === true);
    expect(tabStates()).toHaveLength(before + 1);
    expect(editorContent()).toContain("zeta");

    mock.dialogs.open.length = 0;
    mock.dialogs.open.push(null);
    globalKey("o", { metaKey: true });
    await flush(30);
    expect(tabStates()).toHaveLength(before + 1);
  });

  it("菜单 file.open_folder 会把文件夹加入侧边栏", async () => {
    const before = mock.invokeLog("list_folder_tree").length;
    mock.dialogs.open.length = 0;
    mock.dialogs.open.push("/demo");
    await menu("file.open_folder");
    await until(() => mock.invokeLog("list_folder_tree").length > before);
    await until(() => (mock.configJson()?.folders as string[])?.includes("/demo") ?? false);
    // openFolder 还会后台把目录里全部文本文件逐个开成标签（按 list_text_files 顺序，
    // 新标签只到 Two.TXT，后面仅剩对已存在 readme.md 的同任务切换）。不等它跑完，
    // 残余的 switchTab 会切走活动标签，把后续测试刚打开的查找面板连状态一起冲掉。
    await until(() => !!tab("Two.TXT"));
  });

  it("打开不存在的文件时提示“打开失败”", async () => {
    mock.dialogs.open.length = 0;
    mock.dialogs.open.push("/demo/gone.md");
    const before = mock.messages.length;
    globalKey("o", { metaKey: true });
    await until(() => mock.messages.length === before + 1);
    expect(mock.messages.at(-1)).toMatchObject({ title: "打开失败", kind: "error" });
  });

  it("查找浮窗默认收起替换行，⌥⌘E 展开并可换行导航", async () => {
    await openFile("note.md");
    await menu("find.open");
    await until(() => !!$q(".rnp-find"), 10000, 10, () =>
      [
        `tabs=${JSON.stringify(tabStates())}`,
        `editors=${$qa(".cm-editor").length}`,
        `panels=${$qa(".cm-panels").length}:${$qa(".cm-panel").length}`,
        `panelCls=${$qa(".cm-panel").map((p) => p.className).join("+")}`,
        `active=${document.activeElement?.tagName}.${document.activeElement?.className ?? ""}`,
        `msgs=${JSON.stringify(mock.messages.slice(-2))}`,
        `cmds=${JSON.stringify(mock.calls.slice(-6).map((c) => c.cmd))}`
      ].join(" | ")
    );
    const find = $q<HTMLInputElement>(".rnp-find-input")!;
    expect(find.placeholder).toBe("查找");
    expect($q(".rnp-find-row.hidden")).toBeTruthy();
    // 面板内 ⌥⌘E 展开替换行并把焦点交给替换框
    keydown(find, "e", { altKey: true, metaKey: true });
    await flush(20);
    expect($q(".rnp-find-row.hidden")).toBeNull();
    expect($qa<HTMLInputElement>(".rnp-find-input").map((i) => i.placeholder)).toEqual(["查找", "替换"]);
    keydown($q<HTMLInputElement>(".rnp-find-input")!, "Escape");
    await until(() => !$q(".rnp-find"));
  });

  it("替换命令直接展开替换行，关闭按钮收起浮窗", async () => {
    await menu("find.replace");
    await until(() => !!$q(".rnp-find"));
    expect($q(".rnp-find-row.hidden")).toBeNull();
    mouse($q(".rnp-find-close")!, "click");
    await until(() => !$q(".rnp-find"));
  });

  it("未保存的新标签参与标签计数，关闭后归位", async () => {
    const before = tabStates().length;
    await menu("file.new");
    expect(tabStates()).toHaveLength(before + 1);
    await menu("file.close_tab");
    await until(() => tabStates().length === before);
  });
});

describe("启动日志设置", () => {
  it("默认关闭，且正常启动不会去改后端档位", () => {
    // 档位由后端读配置文件决定，前端不该在启动时再补一刀把它关掉
    expect(mock.invokeLog("set_startup_log")).toHaveLength(0);
    expect(mock.startupLogEnabled()).toBe(false);
  });

  it("面板里打开后写进配置文件，并告诉用户日志落在哪", async () => {
    await paletteRun("启动日志");
    await until(() => mock.configJson()?.startupLog === true);
    expect(mock.lastCall("set_startup_log")?.args).toEqual({ enabled: true });
    expect(mock.startupLogEnabled()).toBe(true);
    expect(mock.messages.at(-1)?.title).toBe("RocketNotePad 启动日志");
    expect(mock.messages.at(-1)?.message).toContain("rocketnotepad.startup.log");
  });

  it("再执行一次恢复默认档", async () => {
    await paletteRun("启动日志");
    await until(() => mock.configJson()?.startupLog === false);
    expect(mock.lastCall("set_startup_log")?.args).toEqual({ enabled: false });
    expect(mock.startupLogEnabled()).toBe(false);
    expect(mock.messages.at(-1)?.message).toContain("正常启动不再产生日志文件");
  });

  it("面板标题跟着当前档位变", async () => {
    globalKey("p", { metaKey: true, shiftKey: true });
    await until(() => !!$q(".palette-overlay .palette-input"));
    const titles = $qa(".palette-item").map((i) => i.textContent ?? "");
    expect(titles.some((t) => t.includes("设置: 启动日志（当前只在出问题时写）"))).toBe(true);
    keydown($q<HTMLInputElement>(".palette-overlay .palette-input")!, "Escape");
    await until(() => !$q(".palette-overlay"));
  });
});
