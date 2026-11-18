import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { createState, type EditorOptions } from "../../src/editor";
import { installTauriMock, type TauriMock } from "../helpers/tauri-mock";
import { $q, $qa, click, flush, globalKey, until } from "../helpers/dom";
import { closeEditorMenu, showEditorContextMenu, type EditorMenuInfo } from "../../src/editmenu";

const opts = (over: Partial<EditorOptions> = {}): EditorOptions => ({
  theme: "dark",
  fontSize: 13,
  wrap: true,
  ...over
});

const views: EditorView[] = [];
function makeView(doc = "", options: Partial<EditorOptions> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({ state: createState(doc, null, opts(options)), parent: host });
  views.push(view);
  return view;
}

let mock: TauriMock | null = null;
afterEach(() => {
  closeEditorMenu();
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = "";
  mock?.uninstall();
  mock = null;
});

const items = () => $qa(".ctx-menu .ctx-item");
const itemByText = (text: string) => items().find((el) => el.firstElementChild?.textContent === text);
const hintOf = (text: string) => itemByText(text)?.querySelector(".ctx-hint")?.textContent ?? "";
const disabled = (text: string) => itemByText(text)?.classList.contains("disabled") ?? false;

async function openMenu(view: EditorView, info: EditorMenuInfo) {
  await showEditorContextMenu(20, 20, view, info);
  await flush(0);
}
const sqlInfo: EditorMenuInfo = { readOnly: false, langLabel: "SQL" };

describe("编辑区右键菜单构成", () => {
  it("包含撤销/重做/剪切/复制/粘贴/全选与格式化文档", async () => {
    mock = installTauriMock();
    const view = makeView("select 1");
    await openMenu(view, sqlInfo);
    expect($q(".ctx-menu")).toBeTruthy();
    for (const text of ["撤销", "重做", "剪切", "复制", "粘贴", "全选", "格式化文档"]) {
      expect(itemByText(text), text).toBeTruthy();
    }
  });

  it("无选区时剪切/复制禁用，有选区时启用", async () => {
    mock = installTauriMock();
    const view = makeView("hello world");
    await openMenu(view, sqlInfo);
    expect(disabled("剪切")).toBe(true);
    expect(disabled("复制")).toBe(true);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await openMenu(view, sqlInfo);
    expect(disabled("剪切")).toBe(false);
    expect(disabled("复制")).toBe(false);
  });

  it("只读文件禁用格式化与改写类动作，全选仍可用", async () => {
    mock = installTauriMock();
    const view = makeView("select 1", { readOnly: true });
    await openMenu(view, { readOnly: true, langLabel: "SQL" });
    expect(disabled("格式化文档")).toBe(true);
    expect(hintOf("格式化文档")).toBe("只读文件");
    expect(disabled("撤销")).toBe(true);
    expect(disabled("剪切")).toBe(true);
    expect(disabled("粘贴")).toBe(true);
    expect(disabled("全选")).toBe(false);
  });
});

describe("格式化文档项的启用状态与提示", () => {
  it("SQL 启用并标注内置", async () => {
    mock = installTauriMock();
    const view = makeView("select 1");
    await openMenu(view, sqlInfo);
    expect(disabled("格式化文档")).toBe(false);
    expect(hintOf("格式化文档")).toBe("内置");
  });

  it("外部语言装了工具时启用并显示工具名", async () => {
    mock = installTauriMock();
    const view = makeView("fn main(){}");
    await openMenu(view, { readOnly: false, langLabel: "Rust" });
    expect(disabled("格式化文档")).toBe(false);
    expect(hintOf("格式化文档")).toBe("rustfmt");
    await openMenu(view, { readOnly: false, langLabel: "Python" });
    expect(hintOf("格式化文档")).toBe("black");
  });

  it("外部语言缺工具时禁用并提示安装", async () => {
    mock = installTauriMock({ availableFormatters: [] });
    const view = makeView("fn main(){}");
    await openMenu(view, { readOnly: false, langLabel: "Rust" });
    expect(disabled("格式化文档")).toBe(true);
    expect(hintOf("格式化文档")).toBe("未安装 rustfmt");
  });

  it("不支持的语言禁用并提示", async () => {
    mock = installTauriMock();
    const view = makeView("# 标题");
    await openMenu(view, { readOnly: false, langLabel: "Markdown" });
    expect(disabled("格式化文档")).toBe(true);
    expect(hintOf("格式化文档")).toBe("暂不支持该语言");
  });
});

describe("菜单动作", () => {
  it("点击格式化文档对 SQL 真实生效并关闭菜单", async () => {
    mock = installTauriMock();
    const view = makeView("select a from t");
    await openMenu(view, sqlInfo);
    click(itemByText("格式化文档")!);
    await until(() => view.state.doc.toString().includes("SELECT"));
    expect($q(".ctx-menu")).toBeNull();
  });

  it("点击格式化文档对外部语言用后端结果整篇替换", async () => {
    mock = installTauriMock({ format: () => "FMT\n" });
    const view = makeView("x");
    await openMenu(view, { readOnly: false, langLabel: "Rust" });
    click(itemByText("格式化文档")!);
    await until(() => view.state.doc.toString() === "FMT\n");
  });

  it("格式化失败弹出中文错误且文档不变", async () => {
    mock = installTauriMock();
    mock.fail("format_document", "工具崩了");
    const view = makeView("fn main(){}");
    await openMenu(view, { readOnly: false, langLabel: "Rust" });
    click(itemByText("格式化文档")!);
    await until(() => mock!.messages.some((m) => m.title === "格式化失败"));
    expect(mock.messages.some((m) => m.message.includes("工具崩了"))).toBe(true);
    expect(view.state.doc.toString()).toBe("fn main(){}");
  });

  it("全选覆盖整篇文档", async () => {
    mock = installTauriMock();
    const view = makeView("a\nb\nc");
    await openMenu(view, sqlInfo);
    click(itemByText("全选")!);
    await flush(0);
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(view.state.doc.length);
  });

  it("复制把选区写入剪贴板", async () => {
    mock = installTauriMock();
    const view = makeView("hello world");
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await openMenu(view, sqlInfo);
    click(itemByText("复制")!);
    await until(() => mock!.clipboardText() === "hello");
  });

  it("粘贴在光标处插入剪贴板文本", async () => {
    mock = installTauriMock({ clipboard: "XYZ" });
    const view = makeView("ab");
    view.dispatch({ selection: { anchor: 1 } });
    await openMenu(view, sqlInfo);
    click(itemByText("粘贴")!);
    await until(() => view.state.doc.toString() === "aXYZb");
  });

  it("剪切删除选区并写入剪贴板", async () => {
    mock = installTauriMock();
    const view = makeView("hello world");
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await openMenu(view, sqlInfo);
    click(itemByText("剪切")!);
    await until(() => view.state.doc.toString() === " world" && mock!.clipboardText() === "hello");
  });

  it("撤销与重做作用于编辑器", async () => {
    mock = installTauriMock();
    const view = makeView("abc");
    view.dispatch({ changes: { from: 3, insert: "d" } });
    expect(view.state.doc.toString()).toBe("abcd");
    await openMenu(view, sqlInfo);
    click(itemByText("撤销")!);
    await until(() => view.state.doc.toString() === "abc");
    await openMenu(view, sqlInfo);
    click(itemByText("重做")!);
    await until(() => view.state.doc.toString() === "abcd");
  });
});

describe("菜单关闭", () => {
  it("菜单外左键点击关闭", async () => {
    mock = installTauriMock();
    const view = makeView("select 1");
    await openMenu(view, sqlInfo);
    expect($q(".ctx-menu")).toBeTruthy();
    click(document.body);
    expect($q(".ctx-menu")).toBeNull();
  });

  it("Esc 关闭", async () => {
    mock = installTauriMock();
    const view = makeView("select 1");
    await openMenu(view, sqlInfo);
    globalKey("Escape");
    expect($q(".ctx-menu")).toBeNull();
  });
});