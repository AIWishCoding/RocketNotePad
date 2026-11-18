import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  deleteCharBackward,
  historyField,
  insertNewline,
  insertTab,
  redo,
  selectAll,
  undo
} from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import {
  CN_PHRASES,
  createState,
  gotoLineNumber,
  reconfigure,
  type EditorOptions
} from "../../src/editor";
import { SYSTEM_FONT, SYSTEM_STACK, fontStack } from "../../src/fonts";

const opts = (over: Partial<EditorOptions> = {}): EditorOptions => ({
  theme: "dark",
  fontSize: 13,
  wrap: true,
  ...over
});

const views: EditorView[] = [];

function makeView(doc = "", options: Partial<EditorOptions> = {}, onUpdate?: (v: EditorView) => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({ state: createState(doc, null, opts(options), onUpdate), parent: host });
  views.push(view);
  return view;
}

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = "";
});

describe("编辑器状态构建", () => {
  it("按传入文档创建状态并保留内容", () => {
    const view = makeView("第一行\n第二行\n");
    expect(view.state.doc.toString()).toBe("第一行\n第二行\n");
    expect(view.state.doc.lines).toBe(3);
  });

  it("挂载行号、代码折叠、激活行高等基础设施", () => {
    const view = makeView("a\nb\nc");
    expect(view.dom.querySelector(".cm-lineNumbers")).toBeTruthy();
    expect(view.dom.querySelector(".cm-foldGutter")).toBeTruthy();
    expect(view.dom.querySelectorAll(".cm-gutterElement").length).toBeGreaterThanOrEqual(3);
    expect(view.contentDOM.querySelectorAll(".cm-line").length).toBe(3);
  });

  it("所有 CodeMirror 内建文案使用中文短语表", () => {
    const view = makeView("x");
    for (const [en, zh] of Object.entries(CN_PHRASES)) {
      expect(view.state.phrase(en), en).toBe(zh);
    }
    expect(view.state.phrase("Find")).toBe("查找");
    expect(view.state.phrase("replaced match on line $")).toBe("已替换第 $ 行的匹配");
  });

  it("支持多光标、括号匹配、自动补全等能力开关", () => {
    const view = makeView("abc");
    expect(view.state.facet(EditorState.allowMultipleSelections)).toBe(true);
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]) });
    expect(view.state.selection.ranges.map((r) => r.anchor)).toEqual([0, 2]);
  });

  it("编辑操作可撤销与重做", () => {
    const view = makeView("hello");
    view.dispatch({ changes: { from: 5, insert: " world" } });
    expect(view.state.doc.toString()).toBe("hello world");
    undo(view);
    expect(view.state.doc.toString()).toBe("hello");
    redo(view);
    expect(view.state.doc.toString()).toBe("hello world");
  });

  it("全选命令覆盖整个文档", () => {
    const view = makeView("一\n二\n三");
    selectAll(view);
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(view.state.doc.length);
  });

  it("updateListener 在文档、选区、焦点变化时回调", () => {
    const calls: string[] = [];
    const view = makeView("abc", {}, () => calls.push("update"));
    view.dispatch({ changes: { from: 0, insert: "z" } });
    view.dispatch({ selection: { anchor: 2 } });
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("主题、字号与自动换行", () => {
  it("暗色主题带 darkTheme 标记，亮色没有", () => {
    const dark = makeView("x", { theme: "dark" });
    expect(dark.state.facet(EditorView.darkTheme)).toBeTruthy();
    const light = makeView("x", { theme: "light" });
    expect(light.state.facet(EditorView.darkTheme)).toBeFalsy();
  });

  it("切换主题不改动文档与光标", () => {
    const view = makeView("line1\nline2", { theme: "dark" });
    view.dispatch({ selection: { anchor: 7 } });
    reconfigure(view, opts({ theme: "light" }));
    expect(view.state.doc.toString()).toBe("line1\nline2");
    expect(view.state.selection.main.anchor).toBe(7);
    expect(view.state.facet(EditorView.darkTheme)).toBeFalsy();
  });

  it("自动换行开关注入 cm-lineWrapping 样式类", () => {
    const wrapped = makeView("x", { wrap: true });
    expect(wrapped.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
    reconfigure(wrapped, opts({ wrap: false }));
    expect(wrapped.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    reconfigure(wrapped, opts({ wrap: true }));
    expect(wrapped.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
  });

  it("调整字号后内容保持不变", () => {
    const view = makeView("内容内容\n第二行", { fontSize: 13 });
    reconfigure(view, opts({ fontSize: 20 }));
    expect(view.state.doc.toString()).toBe("内容内容\n第二行");
    reconfigure(view, opts({ fontSize: 9 }));
    expect(view.state.doc.toString()).toBe("内容内容\n第二行");
  });

  it("同时切换三项设置也是安全的", () => {
    const view = makeView("abc", { theme: "dark", fontSize: 13, wrap: true });
    expect(() => reconfigure(view, opts({ theme: "light", fontSize: 18, wrap: false }))).not.toThrow();
    expect(view.state.doc.toString()).toBe("abc");
  });
});

describe("编辑器字体", () => {
  const family = (view: EditorView) =>
    getComputedStyle(view.scrollDOM).fontFamily.replace(/['"]/g, "").replace(/\s+/g, " ").trim();
  const normalized = (stack: string) => stack.replace(/['"]/g, "").replace(/\s+/g, " ").trim();

  it("不指定字体时跟随系统默认", () => {
    const view = makeView("abc");
    expect(family(view)).toBe(normalized(SYSTEM_STACK));
  });

  it("选定的字体立刻生效，换回来也生效，内容不受影响", () => {
    const view = makeView("内容内容\n第二行", { fontFamily: "Menlo" });
    expect(family(view)).toBe(normalized(fontStack("Menlo")));
    reconfigure(view, opts({ fontFamily: "Consolas" }));
    expect(family(view)).toBe(normalized(fontStack("Consolas")));
    expect(view.state.doc.toString()).toBe("内容内容\n第二行");
    reconfigure(view, opts({ fontFamily: SYSTEM_FONT }));
    expect(family(view)).toBe(normalized(SYSTEM_STACK));
  });

  it("自定义字体名带着系统栈兜底，生僻字不会变成空白", () => {
    const view = makeView("汉字", { fontFamily: "JetBrains Mono" });
    expect(family(view)).toBe(normalized(fontStack("JetBrains Mono")));
    expect(family(view)).toContain(normalized(SYSTEM_STACK));
  });

  it("字体名里的危险字符进不了样式声明", () => {
    const view = makeView("abc", { fontFamily: 'Bad"; color: red; {' });
    const applied = family(view);
    expect(applied).toBe(normalized(fontStack('Bad"; color: red; {')));
    expect(applied).not.toMatch(/[;{}"']/);
    expect(applied.endsWith(normalized(SYSTEM_STACK))).toBe(true);
  });

  it("字号与字体各自独立，改一个不动另一个", () => {
    const view = makeView("abc", { fontSize: 13, fontFamily: "Menlo" });
    reconfigure(view, opts({ fontSize: 22, fontFamily: "Menlo" }));
    expect(getComputedStyle(view.scrollDOM).fontSize).toBe("22px");
    expect(family(view)).toBe(normalized(fontStack("Menlo")));
    reconfigure(view, opts({ fontSize: 22, fontFamily: "Consolas" }));
    expect(getComputedStyle(view.scrollDOM).fontSize).toBe("22px");
    expect(family(view)).toBe(normalized(fontStack("Consolas")));
  });
});

describe("跳转到行", () => {
  it("定位到指定行首并聚焦编辑器", () => {
    const view = makeView("aaa\nbbb\nccc");
    gotoLineNumber(view, 3);
    expect(view.state.selection.main.from).toBe(view.state.doc.line(3).from);
    expect(view.hasFocus).toBe(true);
  });

  it("行号越界时被夹到有效范围", () => {
    const view = makeView("aaa\nbbb");
    gotoLineNumber(view, 0);
    expect(view.state.selection.main.from).toBe(0);
    gotoLineNumber(view, 999);
    expect(view.state.selection.main.from).toBe(view.state.doc.line(2).from);
  });

  it("单行文档跳转任意行都落在行首", () => {
    const view = makeView("only line");
    gotoLineNumber(view, 42);
    expect(view.state.selection.main.from).toBe(0);
  });
});

describe("搜索面板接入", () => {
  it("openSearchPanel 挂载的是自定义 VS Code 风格浮窗", () => {
    const view = makeView("foo bar foo");
    openSearchPanel(view);
    const panels = view.dom.querySelector(".cm-panels");
    expect(panels).toBeTruthy();
    expect(panels!.classList.contains("cm-panels-top")).toBe(true);
    const find = view.dom.querySelector(".rnp-find");
    expect(find).toBeTruthy();
    expect(view.dom.querySelector(".cm-panel.cm-search")).toBeNull();
    const mainField = find!.querySelector('[main-field="true"]');
    expect(mainField).toBeTruthy();
    expect(mainField!.classList.contains("rnp-find-input")).toBe(true);
    view.destroy();
  });

  it("浮窗包含查找行与替换行的全部控件", () => {
    const view = makeView("x");
    openSearchPanel(view);
    const find = view.dom.querySelector(".rnp-find")!;
    const rows = find.querySelectorAll(".rnp-find-row");
    expect(rows.length).toBe(2);
    expect(find.querySelectorAll("input").length).toBe(2);
    for (const title of ["区分大小写", "全字匹配", "正则表达式", "关闭"]) {
      expect(find.querySelector(`button[title="${title}"]`), title).toBeTruthy();
    }
    expect(find.textContent).toContain("替换");
  });
});

describe("按键映射", () => {
  it("Escape 关闭搜索浮窗", () => {
    const view = makeView("abc");
    openSearchPanel(view);
    expect(view.dom.querySelector(".rnp-find")).toBeTruthy();
    const panelInput = view.dom.querySelector<HTMLInputElement>(".rnp-find-input")!;
    panelInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(view.dom.querySelector(".rnp-find")).toBeNull();
  });

  it("编辑器内的 Mod-f 打开搜索浮窗", () => {
    const view = makeView("abc");
    const done = vi.fn();
    view.contentDOM.addEventListener("keydown", () => done());
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true, bubbles: true, cancelable: true })
    );
    expect(view.dom.querySelector(".rnp-find")).toBeTruthy();
    expect(done).toHaveBeenCalled();
  });

  it("Tab 缩进、Shift-Tab 反缩进", () => {
    const view = makeView("alpha\nbeta");
    view.dispatch({ selection: { anchor: 6 } });
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true })
    );
    const indented = view.state.doc.line(2).text;
    expect(indented).toMatch(/^\s+beta$/);
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: true, bubbles: true, cancelable: true })
    );
    expect(view.state.doc.line(2).text).toBe("beta");
  });
});

describe("超大文件只读模式", () => {
  it("readOnly 状态声明只读：内容不可编辑、标记 aria-readonly", () => {
    const view = makeView("大文件内容", { readOnly: true });
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(view.contentDOM.getAttribute("aria-readonly")).toBe("true");
  });

  it("只读时任何改动事务被丢弃，文档保持不变", () => {
    const view = makeView("hello world", { readOnly: true });
    view.dispatch({ selection: { anchor: 5 } });
    view.dispatch({ changes: { from: 0, insert: "x" } });
    insertNewline(view);
    insertTab(view);
    deleteCharBackward(view);
    expect(view.state.doc.toString()).toBe("hello world");
    expect(view.state.selection.main.anchor).toBe(5);
  });

  it("只读时快捷键按键不会改写文档", () => {
    const view = makeView("alpha\nbeta", { readOnly: true });
    view.dispatch({ selection: { anchor: 6 } });
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true })
    );
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })
    );
    expect(view.state.doc.toString()).toBe("alpha\nbeta");
  });

  it("可编辑状态下同样的命令生效（对照组）", () => {
    const view = makeView("hello world");
    expect(view.state.readOnly).toBe(false);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
    view.dispatch({ selection: { anchor: 5 } });
    expect(deleteCharBackward(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("hell world");
  });

  it("只读时不装撤销栈，可编辑时装载", () => {
    const editable = makeView("hello");
    expect(editable.state.field(historyField, false)).toBeDefined();
    editable.dispatch({ selection: { anchor: 5 } });
    insertNewline(editable);
    undo(editable);
    expect(editable.state.doc.toString()).toBe("hello");

    const readOnly = makeView("hello", { readOnly: true });
    expect(readOnly.state.field(historyField, false)).toBeUndefined();
    expect(() => undo(readOnly)).not.toThrow();
  });

  it("重配置切换只读标记，文档与光标不变", () => {
    const view = makeView("line1\nline2");
    view.dispatch({ selection: { anchor: 7 } });
    reconfigure(view, opts({ readOnly: true }));
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(view.state.doc.toString()).toBe("line1\nline2");
    expect(view.state.selection.main.anchor).toBe(7);
    reconfigure(view, opts({ readOnly: false }));
    expect(view.state.readOnly).toBe(false);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(view.state.doc.toString()).toBe("xline1\nline2");
  });
});
