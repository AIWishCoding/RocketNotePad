import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { createState } from "../../src/editor";
import { Minimap } from "../../src/minimap";
import { MarkdownPreview } from "../../src/preview";
import { cfg } from "../../src/config";
import { perFrame } from "../../src/frame";

const views: EditorView[] = [];

/** 给指定元素挂上计数版几何量：读一次记一次，用来盯住「有没有在更新回调里强制布局」 */
function countReads(el: HTMLElement, sizes: Record<string, number>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [prop, value] of Object.entries(sizes)) {
    counts[prop] = 0;
    Object.defineProperty(el, prop, {
      configurable: true,
      get: () => {
        counts[prop]++;
        return value;
      }
    });
  }
  return counts;
}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

function setup(doc = "hello\nworld\n\nfoo") {
  localStorage.clear();
  cfg.minimap = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: createState(doc, null, { theme: "dark", fontSize: 13, wrap: true }),
    parent: host
  });
  views.push(view);
  const wrap = document.createElement("div");
  const canvas = document.createElement("canvas");
  const pane = document.createElement("div");
  wrap.appendChild(canvas);
  host.append(wrap, pane);
  return { view, canvas, wrap, pane };
}

afterEach(() => {
  vi.useRealTimers();
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = "";
});

describe("perFrame", () => {
  it("一帧里调多少次都只执行一次，下一帧还能再执行", () => {
    vi.useFakeTimers();
    let runs = 0;
    const tick = perFrame(() => runs++);
    for (let i = 0; i < 100; i++) tick();
    expect(runs).toBe(0);
    vi.advanceTimersByTime(50);
    expect(runs).toBe(1);
    tick();
    tick();
    vi.advanceTimersByTime(50);
    expect(runs).toBe(2);
  });
});

describe("拖选时的布局代价", () => {
  it("选区更新不在回调里读几何量，一帧只统一读一次", () => {
    vi.useFakeTimers();
    const { view, canvas } = setup();
    const mm = new Minimap(canvas, view);
    vi.advanceTimersByTime(200);
    const canvasReads = countReads(canvas, { clientHeight: 600, clientWidth: 110 });
    const scrollReads = countReads(view.scrollDOM, { scrollHeight: 12000, clientHeight: 600 });

    // 模拟按住鼠标拖过一整段文本：每个 mousemove 一次更新
    for (let i = 0; i < 200; i++) {
      view.scrollDOM.scrollTop = i * 10;
      mm.onUpdate(false);
    }
    expect(total(canvasReads) + total(scrollReads)).toBe(0);

    vi.advanceTimersByTime(50);
    const perFrameReads = total(canvasReads) + total(scrollReads);
    expect(perFrameReads).toBeGreaterThan(0);
    expect(perFrameReads).toBeLessThanOrEqual(10);

    // 再来一帧，代价不随更新次数上涨
    for (let i = 0; i < 200; i++) mm.onUpdate(false);
    vi.advanceTimersByTime(50);
    expect(total(canvasReads) + total(scrollReads)).toBeLessThanOrEqual(perFrameReads * 2);
    expect(mm.visible).toBe(true);
  });

  it("指示器位置没变就不重复写样式", () => {
    vi.useFakeTimers();
    const { view, canvas, wrap } = setup();
    const mm = new Minimap(canvas, view);
    vi.advanceTimersByTime(200);
    const indicator = wrap.querySelector<HTMLElement>(".minimap-viewport")!;
    const write = vi.spyOn(CSSStyleDeclaration.prototype, "top", "set");
    view.scrollDOM.scrollTop = 400;
    mm.onUpdate(false);
    vi.advanceTimersByTime(50);
    const moved = indicator.style.top;
    expect(moved).not.toBe("0px");
    const afterFirst = write.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) mm.onUpdate(false);
    vi.advanceTimersByTime(100);
    expect(indicator.style.top).toBe(moved);
    expect(write.mock.calls.length).toBe(afterFirst);
  });
});

describe("Markdown 预览的滚动同步", () => {
  it("预览没打开时滚动完全不读几何量", () => {
    vi.useFakeTimers();
    const { view, pane } = setup();
    const preview = new MarkdownPreview(pane, view, "dark");
    const reads = countReads(pane, { scrollHeight: 4000, clientHeight: 600 });
    for (let i = 0; i < 100; i++) {
      view.scrollDOM.scrollTop = i * 20;
      view.scrollDOM.dispatchEvent(new Event("scroll"));
    }
    vi.advanceTimersByTime(100);
    expect(total(reads)).toBe(0);
    expect(pane.scrollTop).toBe(0);
    expect(preview.isActive).toBe(false);
  });

  it("打开后一帧只同步一次，且滚动比例跟着走", () => {
    vi.useFakeTimers();
    const { view, pane } = setup();
    const preview = new MarkdownPreview(pane, view, "dark");
    preview.setActive(true);
    const reads = countReads(pane, { scrollHeight: 4000, clientHeight: 600 });
    for (let i = 0; i < 100; i++) {
      view.scrollDOM.scrollTop = i * 10;
      view.scrollDOM.dispatchEvent(new Event("scroll"));
    }
    expect(total(reads)).toBe(0);
    vi.advanceTimersByTime(50);
    expect(total(reads)).toBeLessThanOrEqual(4);
    expect(pane.scrollTop).toBeGreaterThan(0);
    expect(preview.isActive).toBe(true);
  });
});