import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { closeSearchPanel, openSearchPanel } from "@codemirror/search";
import { NEXT_MATCH_HINT, openReplacePanel, PREV_MATCH_HINT, REPLACE_ALL_HINT, REPLACE_CURRENT_HINT } from "../../src/find";
import { createState, type EditorOptions } from "../../src/editor";

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

function panelOf(view: EditorView): HTMLElement {
  const panel = view.dom.querySelector<HTMLElement>(".rnp-find");
  if (!panel) throw new Error("查找浮窗未挂载");
  return panel;
}

function fields(view: EditorView): HTMLInputElement[] {
  return [...panelOf(view).querySelectorAll<HTMLInputElement>(".rnp-find-input")];
}

function button(view: EditorView, title: string): HTMLButtonElement {
  const btn = [...panelOf(view).querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.title === title
  );
  if (!btn) throw new Error(`浮窗中没有按钮: ${title}`);
  return btn;
}

function counter(view: EditorView): HTMLElement {
  return panelOf(view).querySelector<HTMLElement>(".rnp-find-count")!;
}

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    keyCode: key === "Enter" ? 13 : undefined,
    ...init
  });
  target.dispatchEvent(ev);
  return ev;
}

function openFind(doc = "", options: Partial<EditorOptions> = {}) {
  const view = makeView(doc, options);
  openSearchPanel(view);
  return view;
}

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = "";
});

describe("查找浮窗的结构与文案", () => {
  it("挂载在编辑器顶部且输入框标记为 main-field", () => {
    const view = openFind("abc");
    expect(view.dom.querySelector(".cm-panels-top")).toBeTruthy();
    expect(panelOf(view).className).toContain("rnp-find");
    expect(fields(view)[0].getAttribute("main-field")).toBe("true");
  });

  it("全部按钮与占位符使用中文文案", () => {
    const view = openFind("abc");
    const panel = panelOf(view);
    expect(fields(view)[0].placeholder).toBe("查找");
    expect(fields(view)[1].placeholder).toBe("替换");
    expect(fields(view)[0].getAttribute("aria-label")).toBe("查找");
    const actionTexts = [...panel.querySelectorAll<HTMLButtonElement>(".rnp-find-action")].map(
      (b) => b.textContent
    );
    expect(actionTexts).toEqual(["替换", "全部替换"]);
    const titles = [...panel.querySelectorAll("button")].map((b) => b.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "切换为替换",
        "区分大小写",
        "全字匹配",
        "正则表达式",
        "在选定内容中查找",
        PREV_MATCH_HINT,
        NEXT_MATCH_HINT,
        "关闭",
        "保留大小写",
        REPLACE_CURRENT_HINT,
        REPLACE_ALL_HINT
      ])
    );
    for (const b of [...panel.querySelectorAll("button")]) {
      expect(b.getAttribute("aria-label")).toBe(b.title);
      expect(b.type).toBe("button");
    }
  });

  it("未输入关键词时不显示匹配计数", () => {
    const view = openFind("abc");
    expect(counter(view).textContent).toBe("");
    expect(counter(view).classList.contains("error")).toBe(false);
  });

  it("默认收起替换行，点箭头展开后再收起", () => {
    const view = openFind("abc");
    const row = panelOf(view).querySelector<HTMLElement>(".rnp-find-row:last-child")!;
    const arrow = button(view, "切换为替换");
    expect(row.classList.contains("hidden")).toBe(true);
    arrow.click();
    expect(row.classList.contains("hidden")).toBe(false);
    expect(arrow.classList.contains("open")).toBe(true);
    expect(arrow.title).toBe("收起替换");
    arrow.click();
    expect(row.classList.contains("hidden")).toBe(true);
    expect(arrow.title).toBe("切换为替换");
  });

  it("openReplacePanel 直接展开替换行并聚焦替换输入框", () => {
    const view = makeView("hello");
    openReplacePanel(view);
    expect(panelOf(view).querySelector(".rnp-find-row:last-child")!.className).not.toContain("hidden");
    expect(document.activeElement).toBe(fields(view)[1]);
    // 已存在浮窗时再次调用只展开，不重复创建
    const before = views.length;
    openReplacePanel(view);
    expect(views.length).toBe(before);
    expect(document.querySelectorAll(".rnp-find").length).toBe(1);
  });

  it("关闭按钮移除浮窗", () => {
    const view = openFind("abc");
    closeSearchPanel(view);
    expect(view.dom.querySelector(".rnp-find")).toBeNull();
  });
});

describe("查找匹配与计数", () => {
  it("统计当前匹配序号与总数，无匹配时提示无匹配", () => {
    const view = openFind("one two one three one");
    type(fields(view)[0], "one");
    expect(counter(view).textContent).toBe("1 / 3");
    view.dispatch({ selection: { anchor: 8, head: 11 } });
    expect(counter(view).textContent).toBe("2 / 3");
    view.dispatch({ selection: { anchor: 18, head: 21 } });
    expect(counter(view).textContent).toBe("3 / 3");
    type(fields(view)[0], "zzz");
    expect(counter(view).textContent).toBe("无匹配");
  });

  it("高亮随输入生效，选区变化后仍保持", () => {
    const view = openFind("abc abc");
    type(fields(view)[0], "abc");
    expect(view.contentDOM.querySelectorAll(".cm-searchMatch").length).toBe(2);
    view.dispatch({ selection: { anchor: 4 } });
    expect(view.contentDOM.querySelectorAll(".cm-searchMatch").length).toBe(2);
  });

  it("大小写/全字/正则开关改变匹配结果", () => {
    const view = openFind("Aa aa aab AA");
    const [find] = fields(view);
    type(find, "aa");
    expect(counter(view).textContent).toBe("1 / 4");

    button(view, "区分大小写").click();
    expect(counter(view).textContent).toBe("1 / 2");
    expect(button(view, "区分大小写").classList.contains("active")).toBe(true);

    button(view, "全字匹配").click();
    expect(counter(view).textContent).toBe("1 / 1");

    button(view, "区分大小写").click();
    expect(counter(view).textContent).toBe("1 / 3");

    button(view, "全字匹配").click();
    button(view, "正则表达式").click();
    type(find, "a+");
    expect(counter(view).textContent).toBe("1 / 4");
  });

  it("非法正则给出中文错误提示且不抛异常", () => {
    const view = openFind("abc");
    button(view, "正则表达式").click();
    type(fields(view)[0], "((");
    expect(counter(view).textContent).toBe("正则有误");
    expect(counter(view).classList.contains("error")).toBe(true);
    type(fields(view)[0], "(a)");
    expect(counter(view).classList.contains("error")).toBe(false);
    expect(counter(view).textContent).toBe("1 / 1");
  });

  it("匹配数超过上限时显示 2000+", () => {
    const doc = "x ".repeat(2100);
    const view = openFind(doc);
    type(fields(view)[0], "x");
    expect(counter(view).textContent).toBe(`1 / 2000+`);
  });

  it("在选定内容中查找只统计选区内的匹配", () => {
    const view = openFind("one\ntwo\none\none");
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    type(fields(view)[0], "one");
    expect(counter(view).textContent).toBe("1 / 3");
    button(view, "在选定内容中查找").click();
    expect(button(view, "在选定内容中查找").classList.contains("active")).toBe(true);
    expect(counter(view).textContent).toBe("1 / 1");
    button(view, "在选定内容中查找").click();
    expect(counter(view).textContent).toBe("1 / 3");
  });

  it("没有选区时按下“在选定内容中查找”退化为全文查找", () => {
    const view = openFind("one two one");
    view.dispatch({ selection: { anchor: 0 } });
    type(fields(view)[0], "one");
    button(view, "在选定内容中查找").click();
    expect(counter(view).textContent).toBe("1 / 2");
  });

  it("文档变化后自动清空“选定范围内查找”状态并重新计数", () => {
    const view = openFind("one\ntwo\none");
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    type(fields(view)[0], "one");
    button(view, "在选定内容中查找").click();
    expect(counter(view).textContent).toBe("1 / 1");
    view.dispatch({ changes: { from: 8, insert: " one" } });
    expect(button(view, "在选定内容中查找").classList.contains("active")).toBe(false);
    expect(counter(view).textContent).toBe("1 / 3");
  });
});

describe("查找导航", () => {
  it("上下按钮在匹配之间循环移动选区", () => {
    const view = openFind("ab cd ab cd");
    type(fields(view)[0], "ab");
    button(view, NEXT_MATCH_HINT).click();
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("ab");
    expect(view.state.selection.main.from).toBe(0);
    button(view, NEXT_MATCH_HINT).click();
    expect(view.state.selection.main.from).toBe(6);
    button(view, PREV_MATCH_HINT).click();
    expect(view.state.selection.main.from).toBe(0);
  });

  it("输入框回车导航，Shift 回车反向，Alt 回车选中全部匹配", () => {
    const view = openFind("aa aa aa");
    const [find] = fields(view);
    type(find, "aa");
    press(find, "Enter");
    expect(view.state.selection.ranges).toHaveLength(1);
    expect(view.state.selection.main.from).toBe(0);
    press(find, "Enter", { shiftKey: true });
    expect(view.state.selection.main.from).toBe(6);
    press(find, "Enter", { altKey: true });
    expect(view.state.selection.ranges.length).toBe(3);
  });

  it("导航后输入框保持焦点且光标不被全选", () => {
    const view = openFind("aa aa aa");
    const [find] = fields(view);
    type(find, "aa");
    find.focus();
    press(find, "Enter");
    expect(document.activeElement).toBe(find);
    expect(find.selectionStart).toBe(find.value.length);
    expect(find.selectionEnd).toBe(find.value.length);
  });

  it("Esc 通过 search-panel 作用域关闭浮窗", () => {
    const view = openFind("abc");
    press(panelOf(view), "Escape");
    expect(view.dom.querySelector(".rnp-find")).toBeNull();
  });
});

describe("替换", () => {
  it("替换按钮先定位当前匹配再替换，逐个推进", () => {
    const view = openFind("cat cat cat");
    const [find, repl] = fields(view);
    type(find, "cat");
    button(view, "切换为替换").click();
    type(repl, "dog");
    // 选区还不在匹配上：第一次点击等价于“查找下一个”
    button(view, REPLACE_CURRENT_HINT).click();
    expect(view.state.doc.toString()).toBe("cat cat cat");
    expect(view.state.selection.main.from).toBe(0);
    button(view, REPLACE_CURRENT_HINT).click();
    expect(view.state.doc.toString()).toBe("dog cat cat");
    button(view, REPLACE_ALL_HINT).click();
    expect(view.state.doc.toString()).toBe("dog dog dog");
  });

  it("全部替换一次改完所有匹配", () => {
    const view = openFind("cat cat cat");
    const [find, repl] = fields(view);
    type(find, "cat");
    type(repl, "dog");
    button(view, REPLACE_ALL_HINT).click();
    expect(view.state.doc.toString()).toBe("dog dog dog");
    expect(counter(view).textContent).toBe("无匹配");
  });

  it("替换输入框回车替换当前，⌘/Ctrl/Alt 回车全部替换", () => {
    const view = openFind("x x x");
    const [find, repl] = fields(view);
    type(find, "x");
    type(repl, "y");
    press(find, "Enter");
    press(repl, "Enter");
    expect(view.state.doc.toString()).toBe("y x x");
    press(repl, "Enter", { metaKey: true });
    expect(view.state.doc.toString()).toBe("y y y");
  });

  it("正则替换支持 $1 分组引用", () => {
    const view = openFind("张三 李四");
    const [find, repl] = fields(view);
    button(view, "正则表达式").click();
    type(find, "(\\S+) (\\S+)");
    type(repl, "$2-$1");
    button(view, REPLACE_ALL_HINT).click();
    expect(view.state.doc.toString()).toBe("李四-张三");
  });

  it("保留大小写按被匹配文本的风格改写结果", () => {
    const view = openFind("hello world\nHELLO THERE\nHello Again");
    const [find, repl] = fields(view);
    const preserve = button(view, "保留大小写");
    preserve.click();
    expect(preserve.classList.contains("active")).toBe(true);
    type(find, "hello");
    type(repl, "bye");
    expect(counter(view).textContent).toBe("1 / 3");
    button(view, REPLACE_CURRENT_HINT).click();
    expect(view.state.doc.toString()).toBe("bye world\nHELLO THERE\nHello Again");
    button(view, REPLACE_CURRENT_HINT).click();
    expect(view.state.doc.toString()).toBe("bye world\nBYE THERE\nHello Again");
    button(view, REPLACE_CURRENT_HINT).click();
    expect(view.state.doc.toString()).toBe("bye world\nBYE THERE\nBye Again");
  });

  it("保留大小写下全部替换并反转分组", () => {
    const view = openFind("AB cd\nEF gh");
    const [find, repl] = fields(view);
    button(view, "正则表达式").click();
    button(view, "保留大小写").click();
    type(find, "([A-Za-z]+) ([a-z]+)");
    type(repl, "$2 $1");
    button(view, REPLACE_ALL_HINT).click();
    expect(view.state.doc.toString()).toBe("cd AB\ngh EF");
  });

  it("替换内容里的 \\n 转义会展开成真实换行", () => {
    const view = openFind("ab");
    const [find, repl] = fields(view);
    button(view, "保留大小写").click();
    type(find, "a");
    type(repl, "x\\ny");
    button(view, REPLACE_CURRENT_HINT).click();
    expect(view.state.doc.toString()).toBe("x\nyb");
  });

  it("空匹配词时替换按钮不误改文档", () => {
    const view = openFind("abc");
    button(view, REPLACE_CURRENT_HINT).click();
    button(view, REPLACE_ALL_HINT).click();
    expect(view.state.doc.toString()).toBe("abc");
  });
});

describe("浮窗与外部状态同步", () => {
  it("外部 setSearchQuery 会回填输入框与开关", async () => {
    const { SearchQuery, setSearchQuery } = await import("@codemirror/search");
    const view = openFind("abc abc");
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: "abc", caseSensitive: true, replace: "zz" }))
    });
    const [find, repl] = fields(view);
    expect(find.value).toBe("abc");
    expect(repl.value).toBe("zz");
    expect(button(view, "区分大小写").classList.contains("active")).toBe(true);
    expect(counter(view).textContent).toBe("1 / 2");
  });

  it("重复输入相同关键词不会破坏计数", () => {
    const view = openFind("abc");
    const [find] = fields(view);
    type(find, "abc");
    type(find, "abc");
    expect(counter(view).textContent).toBe("1 / 1");
  });
});

describe("只读文档的替换入口", () => {
  it("只读时替换按钮与输入框被禁用并给出中文提示", () => {
    const view = openFind("cat cat cat", { readOnly: true });
    const [find, repl] = fields(view);
    type(find, "cat");
    expect(repl.disabled).toBe(true);
    expect(button(view, "文件为只读，不能替换").textContent).toBe("替换");
    expect(button(view, "切换为替换")).toBeTruthy();
  });

  it("只读时点击替换与全部替换都不改动文档", () => {
    const view = openFind("cat cat cat", { readOnly: true });
    const [find, repl] = fields(view);
    type(find, "cat");
    repl.value = "dog";
    button(view, "切换为替换").click();
    for (const btn of [...panelOf(view).querySelectorAll<HTMLButtonElement>(".rnp-find-action")]) {
      btn.click();
    }
    expect(view.state.doc.toString()).toBe("cat cat cat");
  });

  it("只读时替换输入框回车同样不生效", () => {
    const view = openFind("x x x", { readOnly: true });
    const [find, repl] = fields(view);
    type(find, "x");
    repl.value = "y";
    press(repl, "Enter");
    press(repl, "Enter", { metaKey: true });
    expect(view.state.doc.toString()).toBe("x x x");
  });

  it("对照组：可编辑文档仍能替换", () => {
    const view = openFind("cat cat cat");
    const [find, repl] = fields(view);
    type(find, "cat");
    type(repl, "dog");
    button(view, REPLACE_ALL_HINT).click();
    expect(view.state.doc.toString()).toBe("dog dog dog");
  });
});
