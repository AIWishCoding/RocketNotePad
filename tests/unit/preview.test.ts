import { afterEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { EditorView } from "@codemirror/view";
import { createState, type EditorOptions } from "../../src/editor";
import { MarkdownPreview, isMarkdown } from "../../src/preview";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}"><text>图表</text></svg>` }))
  }
}));

const opts: EditorOptions = { theme: "dark", fontSize: 13, wrap: true };
let view: EditorView | undefined;
let host: HTMLElement | undefined;

function setup(doc: string, theme: "light" | "dark" = "dark") {
  host = document.createElement("div");
  document.body.appendChild(host);
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  view = new EditorView({ state: createState(doc, null, { ...opts, theme }), parent: host });
  const preview = new MarkdownPreview(pane, view, theme);
  return { pane, preview, editor: view };
}

async function render(doc: string, theme: "light" | "dark" = "dark") {
  const ctx = setup(doc, theme);
  ctx.preview.setActive(true);
  await new Promise((r) => setTimeout(r, 0));
  return ctx;
}

afterEach(() => {
  view?.destroy();
  view = undefined;
  host?.remove();
  document.body.innerHTML = "";
  vi.mocked(mermaid.render).mockReset();
  vi.mocked(mermaid.render).mockImplementation(async (id: string) => ({
    svg: `<svg id="${id}"><text>图表</text></svg>`,
    diagramType: "flowchart"
  }));
});

describe("Markdown 语法渲染", () => {
  it("标题、段落、粗斜体与行内代码", async () => {
    const { pane } = await render(
      "# 一级\n\n## 二级\n\n普通段落 **加粗** *斜体* `code()`\n"
    );
    expect(pane.querySelector("h1")?.textContent).toBe("一级");
    expect(pane.querySelector("h2")?.textContent).toBe("二级");
    expect(pane.querySelector("strong")?.textContent).toBe("加粗");
    expect(pane.querySelector("em")?.textContent).toBe("斜体");
    expect(pane.querySelector("code")?.textContent).toBe("code()");
  });

  it("有序/无序/任务列表", async () => {
    const { pane } = await render("- [ ] 待办\n- [x] 已完成\n\n1. 第一\n2. 第二\n");
    const boxes = pane.querySelectorAll("input[type=checkbox]");
    expect(boxes.length).toBe(2);
    expect(boxes[1].hasAttribute("checked")).toBe(true);
    expect(pane.querySelectorAll("ol li").length).toBe(2);
  });

  it("GFM 表格与删除线", async () => {
    const { pane } = await render("| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n\n文本 ~~废案~~\n");
    expect(pane.querySelectorAll("th").length).toBe(2);
    expect(pane.querySelector("td")?.textContent).toBe("苹果");
    expect(pane.querySelector("del")?.textContent).toBe("废案");
  });

  it("代码块保留语言类名并转义 HTML", async () => {
    const { pane } = await render("```python\nprint('<b>hi</b>')\n```\n");
    const code = pane.querySelector("pre code");
    expect(code?.className).toContain("language-python");
    expect(code?.textContent).toContain("print('<b>hi</b>')");
    expect(pane.querySelector("pre b")).toBeNull();
  });

  it("链接、图片与引用", async () => {
    const { pane } = await render("[官网](https://example.com)\n\n![图](https://example.com/a.png)\n\n> 引用\n");
    expect(pane.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(pane.querySelector("img")?.getAttribute("src")).toBe("https://example.com/a.png");
    expect(pane.querySelector("blockquote")?.textContent).toContain("引用");
  });

  it("单换行不转成 <br>（breaks: false）", async () => {
    const { pane } = await render("第一行\n第二行\n");
    expect(pane.querySelector("p br")).toBeNull();
    expect(pane.querySelector("p")?.textContent).toContain("第一行");
  });

  it("水平分隔线与长文本", async () => {
    const { pane } = await render("上\n\n---\n\n下\n");
    expect(pane.querySelector("hr")).toBeTruthy();
  });
});

describe("渲染安全", () => {
  it("剔除 script 标签与内联事件", async () => {
    const { pane } = await render(
      '<script>alert("xss")</script>\n\n<img src=x onerror="alert(1)">\n\n<div onclick="evil()">点我</div>\n'
    );
    expect(pane.querySelector("script")).toBeNull();
    expect(pane.innerHTML).not.toContain("alert(\"xss\")");
    const img = pane.querySelector("img");
    expect(img?.hasAttribute("onerror")).toBe(false);
    const div = pane.querySelector("div");
    expect(div?.hasAttribute("onclick")).toBe(false);
  });

  it("危险协议的链接被中和", async () => {
    const { pane } = await render("[坏链接](javascript:alert(1))\n\n[数据](data:text/html;base64,PHNjcmlwdD4=)\n");
    for (const a of [...pane.querySelectorAll("a")]) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^ *(javascript|data):/i);
    }
  });

  it("原文中的 HTML 实体不会被二次解析", async () => {
    const { pane } = await render("文本 &lt;script&gt; 与 &amp;\n");
    expect(pane.textContent).toContain("<script>");
    expect(pane.querySelector("script")).toBeNull();
  });
});

describe("mermaid 图表", () => {
  it("mermaid 代码块被渲染为 SVG", async () => {
    const { pane } = await render("```mermaid\ngraph TD;A-->B;\n```\n");
    const mark = pane.querySelector<HTMLElement>("[data-mmd-id]");
    expect(mark).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(mark?.querySelector("svg")).toBeTruthy();
    expect(mark?.classList.contains("failed")).toBe(false);
    expect(mermaid.initialize).toHaveBeenCalled();
  });

  it("语法错误时保留源码并给出中文提示", async () => {
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error("parse error"));
    const { pane } = await render("```mermaid\n不是合法图\n```\n");
    await new Promise((r) => setTimeout(r, 20));
    const mark = pane.querySelector<HTMLElement>("[data-mmd-id]");
    expect(mark?.classList.contains("failed")).toBe(true);
    expect(mark?.textContent).toContain("图表语法有误");
    expect(mark?.querySelector("pre")).toBeTruthy();
  });

  it("相同主题下重复图表复用缓存", async () => {
    const doc = "```mermaid\ngraph TD;A-->B;\n```\n";
    const { pane, preview, editor } = setup(doc);
    preview.setActive(true);
    await new Promise((r) => setTimeout(r, 20));
    const first = vi.mocked(mermaid.render).mock.calls.length;
    editor.dispatch({
      changes: { from: editor.state.doc.length, insert: "\n段落\n" + doc }
    });
    preview.update(editor.state.doc.toString(), true);
    await new Promise((r) => setTimeout(r, 20));
    // 第二段同样内容命中缓存：渲染次数不随图表数量线性增长
    expect(vi.mocked(mermaid.render).mock.calls.length - first).toBeLessThanOrEqual(1);
    expect(pane.querySelectorAll("[data-mmd-id] svg").length).toBe(2);
  });

  it("切换主题会清空缓存并重绘", async () => {
    const { preview } = await render("```mermaid\ngraph TD;A-->B;\n```\n");
    const before = vi.mocked(mermaid.render).mock.calls.length;
    preview.setTheme("light");
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(mermaid.render).mock.calls.length).toBeGreaterThan(before);
  });
});

describe("预览面板开关与联动", () => {
  it("setActive(false) 隐藏面板且不再响应文档更新", async () => {
    const { pane, preview, editor } = setup("# 初始\n");
    preview.setActive(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(pane.classList.contains("hidden")).toBe(false);
    preview.setActive(false);
    expect(pane.classList.contains("hidden")).toBe(true);
    pane.innerHTML = "";
    editor.dispatch({ changes: { from: 0, insert: "新内容\n" } });
    preview.update(editor.state.doc.toString());
    await new Promise((r) => setTimeout(r, 300));
    expect(pane.innerHTML).toBe("");
  });

  it("文档更新走 200ms 防抖", async () => {
    const { pane, preview, editor } = setup("# 初始\n");
    preview.setActive(true);
    editor.dispatch({ changes: { from: 0, insert: "快\n" } });
    preview.update(editor.state.doc.toString());
    expect(pane.innerHTML).toContain("初始");
    await new Promise((r) => setTimeout(r, 260));
    expect(pane.innerHTML).toContain("快");
  });

  it("同步滚动不抛错", async () => {
    const { preview, editor } = setup("# 标题\n\n正文\n");
    preview.setActive(true);
    editor.scrollDOM.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 0));
    expect(true).toBe(true);
  });

  it("文档没变时重复激活不再整篇重渲染", async () => {
    const { preview, editor } = await render("# 初始\n");
    const update = vi.spyOn(preview, "update");
    preview.setActive(true);
    preview.setActive(true);
    expect(update).not.toHaveBeenCalled();

    editor.dispatch({ changes: { from: 0, insert: "改了\n" } });
    preview.setActive(true);
    expect(update).toHaveBeenCalledTimes(1);
    preview.setActive(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("从隐藏切回显示时即使文档没变也要重绘", async () => {
    const { preview } = await render("# 初始\n");
    preview.setActive(false);
    const update = vi.spyOn(preview, "update");
    preview.setActive(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("isActive 反映面板是否可见", () => {
    const { preview } = setup("# 初始\n");
    expect(preview.isActive).toBe(false);
    preview.setActive(true);
    expect(preview.isActive).toBe(true);
    preview.setActive(false);
    expect(preview.isActive).toBe(false);
  });
});

describe("Markdown 文件判定", () => {
  it.each([
    ["a.md", true],
    ["a.MD", true],
    ["a.markdown", true],
    ["a.mdown", true],
    ["a.txt", false],
    ["md", false],
    ["a.md.png", false]
  ])("%s → %s", (name, expected) => {
    expect(isMarkdown(name)).toBe(expected);
  });
});
