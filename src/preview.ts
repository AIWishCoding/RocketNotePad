import { Marked } from "marked";
import DOMPurify from "dompurify";
import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import type { ThemeName } from "./editor";
import { perFrame } from "./frame";

type MermaidApi = typeof import("mermaid").default;
type MermaidTheme = "dark" | "default";
interface Svg {
  id: string;
  svg: string;
}

const pendingCodes = new Map<string, string>();
let seq = 0;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const md = new Marked({ gfm: true, breaks: false });

md.use({
  renderer: {
    code({ text, lang }) {
      const name = (lang ?? "").trim().split(/\s+/)[0].toLowerCase();
      if (name === "mermaid") {
        const id = `c${++seq}`;
        pendingCodes.set(id, text);
        return `<div class="md-mermaid" data-mmd-id="${id}"><pre class="md-mermaid-src">${escapeHtml(text)}</pre></div>`;
      }
      const cls = name ? ` class="language-${escapeHtml(name)}"` : "";
      return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`;
    }
  }
});

let mermaidPromise: Promise<MermaidApi> | undefined;
let mermaidTheme: MermaidTheme | undefined;

function loadMermaid(theme: MermaidTheme): Promise<MermaidApi> {
  if (!mermaidPromise) mermaidPromise = import("mermaid").then((m) => m.default);
  return mermaidPromise.then((mermaid) => {
    if (mermaidTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme,
        // 预览层还要过一遍 DOMPurify：它会把 foreignObject 里的 HTML 标签整段剥掉，
        // 图表只剩空框。关掉 HTML 标签让 Mermaid 直接输出 <text>，文本能安全通过清洗。
        htmlLabels: false,
        fontFamily: getComputedStyle(document.body).fontFamily
      });
      mermaidTheme = theme;
    }
    return mermaid;
  });
}

export class MarkdownPreview {
  private timer: number | undefined;
  private active = false;
  private theme: ThemeName;
  private token = 0;
  private lastTop = NaN;
  private renderedDoc: Text | null = null;
  private svgCache = new Map<string, Svg>();

  constructor(private el: HTMLElement, private view: EditorView, theme: ThemeName) {
    this.theme = theme;
    view.scrollDOM.addEventListener("scroll", this.syncScroll, { passive: true });
  }

  /** 预览没打开时调用方连整篇文档的字符串都不必拼出来 */
  get isActive(): boolean {
    return this.active;
  }

  setTheme(theme: ThemeName) {
    if (theme === this.theme) return;
    this.theme = theme;
    this.svgCache.clear();
    this.update(this.view.state.doc.toString(), true);
  }

  setActive(active: boolean) {
    const changed = active !== this.active;
    this.active = active;
    this.el.classList.toggle("hidden", !active);
    if (!active) return;
    // renderTabs() 每次都会调到这里（改脏标记、切标签、重命名都算），
    // 状态和文档都没变时不能再整篇重渲染一遍，否则每敲第一下都要白解析一次 Markdown
    if (!changed && this.view.state.doc === this.renderedDoc) return;
    this.lastTop = NaN;
    this.update(this.view.state.doc.toString(), true);
  }

  update(doc: string, immediate = false) {
    if (!this.active) return;
    this.renderedDoc = this.view.state.doc;
    window.clearTimeout(this.timer);
    if (immediate) void this.render(doc);
    else this.timer = window.setTimeout(() => void this.render(doc), 200);
  }

  private async render(doc: string) {
    const token = ++this.token;
    pendingCodes.clear();
    const html = md.parse(doc, { async: false }) as string;
    this.el.innerHTML = DOMPurify.sanitize(html);
    this.lastTop = NaN;
    const marks = Array.from(this.el.querySelectorAll<HTMLElement>("[data-mmd-id]"));
    if (marks.length === 0) {
      this.syncScroll();
      return;
    }
    await this.renderMermaid(token, marks);
  }

  private async renderMermaid(token: number, marks: HTMLElement[]) {
    let mermaid: MermaidApi;
    try {
      mermaid = await loadMermaid(this.theme === "dark" ? "dark" : "default");
    } catch {
      this.showMermaidError(marks, "mermaid 组件加载失败");
      return;
    }
    const usedIds = new Set<string>();
    for (const mark of marks) {
      if (token !== this.token || !mark.isConnected) return;
      const code = pendingCodes.get(mark.dataset.mmdId ?? "") ?? "";
      const key = `${this.theme}\u0000${code}`;
      let item = this.svgCache.get(key);
      if (item === undefined) {
        item = (await this.renderOne(mermaid, code)) ?? undefined;
        if (item) this.svgCache.set(key, item);
      }
      if (token !== this.token || !mark.isConnected) return;
      if (!item) {
        mark.classList.add("failed");
        mark.innerHTML = `<pre class="md-mermaid-src">${escapeHtml(code)}</pre><div class="md-mermaid-error">图表语法有误</div>`;
        continue;
      }
      let { id, svg } = item;
      // 缓存命中时同一份 SVG 可能出现在文档多处，改写 id 以免重复 DOM id 与样式选择器
      if (usedIds.has(id)) {
        const fresh = `rnp-${++seq}`;
        svg = svg.split(id).join(fresh);
        id = fresh;
      }
      usedIds.add(id);
      mark.classList.remove("failed");
      mark.innerHTML = DOMPurify.sanitize(svg);
    }
    this.syncScroll();
  }

  private async renderOne(mermaid: MermaidApi, code: string): Promise<Svg | null> {
    const id = `rnp-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      return { id, svg };
    } catch {
      return null;
    }
  }

  private showMermaidError(marks: HTMLElement[], message: string) {
    for (const mark of marks) {
      mark.classList.add("failed");
      const code = pendingCodes.get(mark.dataset.mmdId ?? "") ?? "";
      mark.innerHTML = `<pre class="md-mermaid-src">${escapeHtml(code)}</pre><div class="md-mermaid-error">${message}</div>`;
    }
  }

  private syncScroll = perFrame(() => {
    if (!this.active) return;
    const scroller = this.view.scrollDOM;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const ratio = max > 0 ? scroller.scrollTop / max : 0;
    const top = ratio * (this.el.scrollHeight - this.el.clientHeight);
    if (top === this.lastTop) return;
    this.lastTop = top;
    this.el.scrollTop = top;
  });
}

export function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdown)$/i.test(name);
}
