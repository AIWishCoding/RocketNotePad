import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { createState, type EditorOptions } from "../../src/editor";
import { installTauriMock, type TauriMock } from "../helpers/tauri-mock";
import {
  SQL_LANG,
  formatDocument,
  formatSql,
  isFormatSupported,
  replaceDocument
} from "../../src/format";

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
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = "";
  mock?.uninstall();
  mock = null;
});

describe("格式化语言支持判定", () => {
  it("SQL 与六种外部工具语言受支持", () => {
    for (const label of [SQL_LANG, "Python", "Java", "C", "C++", "Rust", "Go"]) {
      expect(isFormatSupported(label), label).toBe(true);
    }
  });

  it("纯文本/Markdown/JSON/JavaScript 等不在支持列表", () => {
    for (const label of ["纯文本", "Markdown", "JSON", "JavaScript", "TypeScript", "HTML", ""]) {
      expect(isFormatSupported(label), label).toBe(false);
    }
  });
});

describe("SQL 内置格式化", () => {
  it("关键字大写并按子句换行缩进", async () => {
    const out = await formatSql("select a,b from t where x=1 and y=2");
    expect(out).toContain("SELECT");
    expect(out).toContain("FROM");
    expect(out).toContain("WHERE");
    expect(out.split("\n").length).toBeGreaterThan(1);
    expect(out).not.toContain("select ");
  });

  it("多条语句之间留空行", async () => {
    const out = await formatSql("select 1;select 2;");
    expect(out).toContain("SELECT");
    expect(out.match(/SELECT/g)?.length).toBe(2);
  });
});

describe("整篇替换文档", () => {
  it("替换全文并把光标钳制到新长度内", () => {
    const view = makeView("hello world");
    view.dispatch({ selection: { anchor: 11 } });
    replaceDocument(view, "hi");
    expect(view.state.doc.toString()).toBe("hi");
    expect(view.state.selection.main.head).toBe(2);
  });

  it("一次替换是一条可撤销事务", () => {
    const view = makeView("abc");
    replaceDocument(view, "xyz");
    expect(view.state.doc.toString()).toBe("xyz");
    undo(view);
    expect(view.state.doc.toString()).toBe("abc");
  });
});

describe("格式化活动文档编排", () => {
  it("SQL 走内置格式化器，整篇替换并返回 true", async () => {
    mock = installTauriMock();
    const view = makeView("select a from t");
    const changed = await formatDocument(view, SQL_LANG);
    expect(changed).toBe(true);
    expect(view.state.doc.toString()).toContain("SELECT");
    // SQL 不该调用后端
    expect(mock.invokeLog("format_document").length).toBe(0);
  });

  it("外部语言把后端返回的结果整篇替换", async () => {
    mock = installTauriMock({ format: () => "FORMATTED\n" });
    const view = makeView("fn  main(){}");
    const changed = await formatDocument(view, "Rust");
    expect(changed).toBe(true);
    expect(view.state.doc.toString()).toBe("FORMATTED\n");
    expect(mock.lastCall("format_document")?.args).toEqual({ lang: "Rust", content: "fn  main(){}" });
  });

  it("工具带回的 CRLF 归一化为 \\n", async () => {
    mock = installTauriMock({ format: () => "a\r\nb\r\n" });
    const view = makeView("a\nb");
    await formatDocument(view, "Go");
    expect(view.state.doc.toString()).toBe("a\nb\n");
    expect(view.state.doc.toString()).not.toContain("\r");
  });

  it("格式化结果与原文相同则不产生编辑", async () => {
    mock = installTauriMock({ format: (_l, c) => c });
    const view = makeView("already\n");
    const changed = await formatDocument(view, "Rust");
    expect(changed).toBe(false);
    expect(view.state.doc.toString()).toBe("already\n");
    // 没有改动事务，撤销栈应为空
    expect(undo(view)).toBe(false);
  });

  it("空文档直接跳过，不调用后端", async () => {
    mock = installTauriMock();
    const view = makeView("   \n  ");
    const changed = await formatDocument(view, "Rust");
    expect(changed).toBe(false);
    expect(mock.invokeLog("format_document").length).toBe(0);
  });

  it("只读文档不格式化", async () => {
    mock = installTauriMock({ format: () => "X\n" });
    const view = makeView("fn main(){}", { readOnly: true });
    const changed = await formatDocument(view, "Rust");
    expect(changed).toBe(false);
    expect(view.state.doc.toString()).toBe("fn main(){}");
    expect(mock.invokeLog("format_document").length).toBe(0);
  });

  it("工具缺失时把后端错误抛出", async () => {
    mock = installTauriMock({ availableFormatters: [] });
    const view = makeView("fn main(){}");
    await expect(formatDocument(view, "Rust")).rejects.toContain("未找到格式化工具");
    expect(view.state.doc.toString()).toBe("fn main(){}");
  });
});