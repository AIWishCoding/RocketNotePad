import type { EditorView } from "@codemirror/view";
import { cfg, saveConfig } from "./config";
import { fontStack } from "./fonts";
import { perFrame } from "./frame";

/** 一次重绘最多采样多少个像素行：再密也不会提高可读性，却会让大文档重绘代价线性上涨 */
const MAX_ROWS = 1500;

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private renderTimer: number | undefined;
  private docHeight = 1;
  private scale = 0.1;
  private enabled = cfg.minimap;
  private dragging = false;
  private indicator: HTMLElement;
  private shown = "";

  constructor(private canvas: HTMLCanvasElement, private view: EditorView) {
    this.ctx = canvas.getContext("2d")!;
    canvas.style.display = this.enabled ? "block" : "none";
    this.indicator = document.createElement("div");
    this.indicator.className = "minimap-viewport";
    this.indicator.style.display = "none";
    canvas.parentElement!.appendChild(this.indicator);
    view.scrollDOM.addEventListener("scroll", this.syncViewport, { passive: true });
    canvas.addEventListener("mousedown", (e) => {
      this.dragging = true;
      this.jumpTo(e);
    });
    window.addEventListener("mousemove", (e) => {
      if (this.dragging) this.jumpTo(e);
    });
    window.addEventListener("mouseup", () => {
      this.dragging = false;
    });
    new ResizeObserver(() => this.scheduleRender()).observe(canvas.parentElement!);
    this.scheduleRender();
  }

  get visible(): boolean {
    return this.enabled;
  }

  toggle() {
    this.enabled = !this.enabled;
    cfg.minimap = this.enabled;
    saveConfig();
    this.canvas.style.display = this.enabled ? "block" : "none";
    this.shown = "";
    this.paintViewport();
    if (this.enabled) this.scheduleRender();
  }

  onUpdate(docChanged: boolean) {
    if (docChanged) this.scheduleRender();
    else this.syncViewport();
  }

  /** 视口指示器跟着滚动/拖选走，一帧最多同步一次，避免在 CM 测量前强制布局 */
  private syncViewport = perFrame(() => this.paintViewport());

  private jumpTo(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    const scroller = this.view.scrollDOM;
    scroller.scrollTop = ratio * this.docHeight - scroller.clientHeight / 2;
  }

  private scheduleRender() {
    if (!this.enabled) return;
    window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.render(), 150);
  }

  private render() {
    if (!this.enabled) return;
    const canvas = this.canvas;
    const parent = canvas.parentElement!;
    const w = 110;
    const h = parent.clientHeight;
    if (h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const doc = this.view.state.doc;
    const lineCount = doc.lines;
    const style = getComputedStyle(this.view.contentDOM);
    const fontSize = parseFloat(style.fontSize) || 13;
    const lineH = parseFloat(style.lineHeight) || fontSize * 1.55;
    this.docHeight = Math.max(1, lineCount * lineH);
    this.scale = Math.min(0.22, h / this.docHeight);
    const mh = lineH * this.scale;
    const dark = document.body.dataset.theme === "dark";
    const textColor = dark ? "rgba(171,178,191,0.75)" : "rgba(60,64,72,0.7)";
    const barColor = dark ? "rgba(171,178,191,0.35)" : "rgba(60,64,72,0.3)";
    // 按像素行采样而不是遍历文档行：缩放后一个像素行往往压着几十行文本，
    // 逐行绘制会让代价随文件行数线性增长，而视觉上根本看不出差别。
    const rowCount = Math.min(
      lineCount,
      Math.max(1, Math.min(MAX_ROWS, Math.ceil(h / Math.max(mh, 0.05))))
    );
    const sampleLine = (row: number): number => {
      const from = Math.floor((row * lineCount) / rowCount);
      const to = Math.min(lineCount - 1, Math.floor(((row + 1) * lineCount) / rowCount) - 1);
      return Math.round((from + to) / 2) + 1;
    };

    if (lineCount <= 4000) {
      ctx.font = `${Math.max(1, fontSize * this.scale)}px ${fontStack(cfg.fontFamily)}`;
      ctx.fillStyle = textColor;
      ctx.textBaseline = "top";
      for (let row = 0; row < rowCount; row++) {
        const n = sampleLine(row);
        const text = doc.line(n).text;
        if (text.trim()) {
          ctx.fillText(text.slice(0, 200), 3, (n - 1) * mh);
        }
      }
    } else {
      ctx.fillStyle = barColor;
      const charW = fontSize * 0.6 * this.scale;
      for (let row = 0; row < rowCount; row++) {
        const n = sampleLine(row);
        const len = doc.line(n).length;
        if (len > 0) {
          ctx.fillRect(3, (n - 1) * mh, Math.min(w - 6, len * charW), Math.max(0.5, mh * 0.7));
        }
      }
    }
    this.paintViewport();
  }

  private paintViewport() {
    const indicator = this.indicator;
    const hide = () => {
      if (this.shown !== "none") {
        indicator.style.display = "none";
        this.shown = "none";
      }
    };
    if (!this.enabled) return hide();
    const canvas = this.canvas;
    const h = canvas.clientHeight;
    const w = canvas.clientWidth;
    if (h <= 0) return hide();
    const scroller = this.view.scrollDOM;
    const scrollHeight = scroller.scrollHeight;
    const clientHeight = scroller.clientHeight;
    if (scrollHeight <= clientHeight + 2) return hide();
    const total = Math.max(this.docHeight, scrollHeight);
    const top = (scroller.scrollTop / total) * h;
    const vh = Math.max(8, (clientHeight / total) * h);
    // 拖选时指示器往往一动不动，重复写同样的样式只会白白让布局失效
    const next = `${top}|${vh}|${w}`;
    if (next === this.shown) return;
    this.shown = next;
    indicator.style.display = "block";
    indicator.style.top = top + "px";
    indicator.style.height = vh + "px";
    indicator.style.width = w + "px";
  }
}
