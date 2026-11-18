import { beforeAll, describe, expect, it } from "vitest";
import { demoFs, type TauriMock } from "../helpers/tauri-mock";
import {
  $id,
  $q,
  $qa,
  bootApp,
  click,
  clickRow,
  dblClickRow,
  editorContent,
  flush,
  globalKey,
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
const activeTab = (name: string) => tab(name)?.active === true;
const previewPane = () => $id("preview-pane");

/** 命令/语言面板条目用 mousedown 触发 */
function itemByTitle(title: string): HTMLElement {
  const el = $qa(".palette-item").find((i) => (i.textContent ?? "").includes(title));
  if (!el) throw new Error(`面板缺少 "${title}"`);
  return el;
}

async function menu(id: string): Promise<void> {
  mock.emit("menu-action", id);
  await flush(30);
}

/**
 * 启动时恢复上次的标签与偏好：note.md + a.cpp，亮色 16px、关闭自动换行、开启预览。
 * 这样视图类开关的测试可以从已保存的状态出发，而不必反复重启应用。
 */
beforeAll(async () => {
  app = await bootApp({
    fs: {
      ...demoFs(),
      "/demo/big.txt": "x".repeat(2048),
      "/demo/win.txt": "line1\r\nline2\r\n",
      "/demo/mac.txt": "line1\rline2\r"
    },
    config: {
      folders: ["/demo"],
      theme: "light",
      fontSize: 16,
      wrap: false,
      preview: true,
      autoSave: false,
      restoreTabs: ["/demo/note.md", "/demo/a.cpp"]
    }
  });
  mock = app.mock;
  await until(() => tabStates().length === 2);
});

describe("启动时恢复视图偏好", () => {
  it("按保存的标签顺序恢复，活动标签是最后一个", () => {
    expect(tabStates().map((t) => t.name)).toEqual(["note.md", "a.cpp"]);
    expect(tab("a.cpp")!.active).toBe(true);
    expect($id("welcome").classList.contains("hidden")).toBe(true);
    expect(editorContent()).toContain("int main");
  });

  it("主题、字号、换行偏好来自保存值", () => {
    expect(document.body.dataset.theme).toBe("light");
    expect($id("st-theme").textContent).toBe("亮色");
    expect($id("st-zoom").textContent).toBe("缩放 16px");
    expect($id("st-wrap").textContent).toBe("自动换行: 关");
    expect($q(".cm-content")!.classList.contains("cm-lineWrapping")).toBe(false);
  });

  it("非 Markdown 文档不显示预览面板", () => {
    expect(previewPane().classList.contains("hidden")).toBe(true);
    expect($id("editor-wrap").classList.contains("previewing")).toBe(false);
  });
});

describe("Markdown 预览面板", () => {
  it("切到 Markdown 标签后渲染预览并标记 previewing", async () => {
    click($qa("#tabbar .tab")[0]);
    await until(() => previewPane().classList.contains("hidden") === false);
    expect($id("editor-wrap").classList.contains("previewing")).toBe(true);
    await until(() => !!previewPane().querySelector("h1"));
    expect(previewPane().querySelector("h1")!.textContent).toBe("标题");
    expect(previewPane().textContent).toContain("正文 one two three");
  });

  it("编辑 Markdown 后预览按防抖刷新", async () => {
    viewFromDom().dispatch({ changes: { from: 0, insert: "## 新章节\n\n" } });
    await until(() => !!previewPane().querySelector("h2"));
    expect(previewPane().querySelector("h2")!.textContent).toBe("新章节");
    expect(tab("note.md")).toMatchObject({ dirty: true });
  });

  it("手动切换语言后预览按语言标签收起", async () => {
    click($id("st-lang"));
    await until(() => !!$q(".palette-overlay .palette-input"));
    const input = $q<HTMLInputElement>(".palette-overlay .palette-input");
    input.value = "Python";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(10);
    mouse(itemByTitle("语言: Python"), "mousedown");
    await until(() => previewPane().classList.contains("hidden"));
    expect($id("st-lang").textContent).toBe("Python");
    expect($id("editor-wrap").classList.contains("previewing")).toBe(false);
  });

  it("恢复自动判断后预览重新出现", async () => {
    click($id("st-lang"));
    await until(() => !!$q(".palette-overlay .palette-input"));
    const input = $q<HTMLInputElement>(".palette-overlay .palette-input");
    input.value = "自动判断";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(10);
    mouse($qa(".palette-item")[0], "mousedown");
    await until(() => previewPane().classList.contains("hidden") === false);
    expect($id("st-lang").textContent).toBe("Markdown");
  });

  it("关闭预览开关后即使 Markdown 也不显示，并写入配置文件", async () => {
    await menu("view.preview");
    expect(previewPane().classList.contains("hidden")).toBe(true);
    await until(() => mock.configJson()?.preview === false);
    await menu("view.preview");
    expect(previewPane().classList.contains("hidden")).toBe(false);
    await until(() => mock.configJson()?.preview === true);
  });
});

describe("缩放与换行", () => {
  it("⌘+ / ⌘- / ⌘0 调整字号并持久化", async () => {
    expect(mock.configJson()?.fontSize).toBe(16);
    globalKey("=", { metaKey: true });
    await until(() => $id("st-zoom").textContent === "缩放 17px");
    globalKey("-", { metaKey: true });
    await until(() => $id("st-zoom").textContent === "缩放 16px");
    globalKey("0", { metaKey: true });
    await until(() => $id("st-zoom").textContent === "缩放 15px");
    await until(() => mock.configJson()?.fontSize === 15);
  });

  it("切换自动换行会重配置编辑器", async () => {
    expect($q(".cm-content")!.classList.contains("cm-lineWrapping")).toBe(false);
    await menu("view.wrap");
    await until(() => $id("st-wrap").textContent === "自动换行: 开");
    expect($q(".cm-content")!.classList.contains("cm-lineWrapping")).toBe(true);
    await until(() => mock.configJson()?.wrap === true);
    // 文档内容与光标不受重配置影响
    expect(editorContent()).toContain("新章节");
  });

  it("字号上下限夹在 9 到 40", async () => {
    for (let i = 0; i < 35; i++) mock.emit("menu-action", "view.zoom_in");
    await flush(40);
    expect($id("st-zoom").textContent).toBe("缩放 40px");
    for (let i = 0; i < 40; i++) mock.emit("menu-action", "view.zoom_out");
    await flush(40);
    expect($id("st-zoom").textContent).toBe("缩放 9px");
  });
});

describe("侧边栏与 Minimap 可见性", () => {
  it("⌘\\ 折叠侧边栏并记住偏好", async () => {
    expect($id("sidebar").classList.contains("hidden")).toBe(false);
    globalKey("\\", { metaKey: true });
    await until(() => $id("sidebar").classList.contains("hidden"));
    await until(() => mock.configJson()?.sidebarVisible === false);
    globalKey("\\", { metaKey: true });
    await until(() => !$id("sidebar").classList.contains("hidden"));
    await until(() => mock.configJson()?.sidebarVisible === true);
  });

  it("Minimap 关闭后隐藏画布，重新打开恢复", async () => {
    expect($id("minimap").style.display).not.toBe("none");
    await menu("view.minimap");
    expect($id("minimap").style.display).toBe("none");
    await until(() => mock.configJson()?.minimap === false);
    await menu("view.minimap");
    expect($id("minimap").style.display).toBe("block");
  });
});

describe("状态栏文件信息", () => {
  it("字节数按 B / KB 展示，换行符标签跟随文件", async () => {
    clickRow("a.cpp");
    await until(() => activeTab("a.cpp"));
    expect($id("st-size").textContent).toBe("25 B");
    expect($id("st-enc").textContent).toBe("UTF-8 · LF");
    dblClickRow("big.txt");
    await until(() => activeTab("big.txt"));
    expect($id("st-size").textContent).toBe("2.0 KB");
    dblClickRow("Dockerfile");
    await until(() => activeTab("Dockerfile"));
    expect($id("st-lang").textContent).toBe("Dockerfile");
  });

  it("打开 CRLF 文件后状态栏显示 CRLF", async () => {
    dblClickRow("win.txt");
    await until(() => activeTab("win.txt"));
    expect($id("st-enc").textContent).toBe("UTF-8 · CRLF");
    expect(editorContent()).toContain("line1");
    expect(editorContent()).not.toContain("\r");
  });

  it("打开纯 CR（旧 Mac）文件后状态栏显示 CR", async () => {
    dblClickRow("mac.txt");
    await until(() => activeTab("mac.txt"));
    expect($id("st-enc").textContent).toBe("UTF-8 · CR");
    expect(editorContent()).toContain("line1");
    expect(editorContent()).not.toContain("\r");
  });

  it("选中区域后状态栏报告字符数，行列跟随光标（head）", async () => {
    const view = viewFromDom();
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await until(() => $id("st-sel").textContent.includes("5 字符"));
    expect($id("st-pos").textContent).toBe("行 1, 列 6");
  });
});
