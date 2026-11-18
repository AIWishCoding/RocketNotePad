import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { createState, type EditorOptions } from "../../src/editor";
import { Minimap } from "../../src/minimap";
import { cfg } from "../../src/config";

interface Ops {
  text: Array<[string, number, number]>;
  bars: number[][];
  cleared: number;
  transforms: number[][];
}

const views: EditorView[] = [];

/** setup.ts 的假 getContext 会优先复用 __ctx，因此可以按需注入记录器 */
function recorder(canvas: HTMLCanvasElement): Ops {
  const ops: Ops = { text: [], bars: [], cleared: 0, transforms: [] };
  const ctx = {
    setTransform: (...a: number[]) => ops.transforms.push(a),
    clearRect: () => ops.cleared++,
    fillText: (text: string, x: number, y: number) => ops.text.push([text, x, y]),
    fillRect: (...a: number[]) => ops.bars.push(a),
    measureText: (text: string) => ({ width: String(text).length * 6 }),
    font: "",
    fillStyle: "",
    strokeStyle: "",
    textBaseline: ""
  };
  Object.defineProperty(canvas, "__ctx", { value: ctx, configurable: true });
  return ops;
}

function setup(doc = "hello\nworld\n\nfoo", opts: Partial<EditorOptions> = {}) {
  localStorage.clear();
  cfg.minimap = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: createState(doc, null, { theme: "dark", fontSize: 13, wrap: true, ...opts }),
    parent: host
  });
  views.push(view);
  const wrap = document.createElement("div");
  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  host.appendChild(wrap);
  return { view, canvas, wrap, ops: recorder(canvas) };
}

afterEach(() => {
  vi.useRealTimers();
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = "";
});

describe("Minimap 开关", () => {
  it("默认显示并保留画布", () => {
    const { view, canvas } = setup();
    const mm = new Minimap(canvas, view);
    expect(mm.visible).toBe(true);
    expect(canvas.style.display).toBe("block");
  });

  it("偏好为关闭时启动即隐藏，切换后写回偏好", () => {
    const { view, canvas } = setup();
    cfg.minimap = false;
    const mm = new Minimap(canvas, view);
    expect(mm.visible).toBe(false);
    expect(canvas.style.display).toBe("none");
    mm.toggle();
    expect(mm.visible).toBe(true);
    expect(canvas.style.display).toBe("block");
    expect(cfg.minimap).toBe(true);
    mm.toggle();
    expect(cfg.minimap).toBe(false);
  });
});

describe("Minimap 渲染", () => {
  it("延迟 150ms 后逐行绘制文本并跳过空行", () => {
    vi.useFakeTimers();
    const { view, canvas, ops } = setup();
    new Minimap(canvas, view);
    expect(ops.text.length).toBe(0);
    vi.advanceTimersByTime(200);
    expect(ops.transforms).toEqual([[1, 0, 0, 1, 0, 0]]);
    expect(ops.cleared).toBe(1);
    expect(ops.text.map((t) => t[0])).toEqual(["hello", "world", "foo"]);
    expect(ops.text[0][2]).toBe(0);
    expect(ops.text[2][2]).toBeGreaterThan(ops.text[1][2]);
    expect(ops.bars.length).toBe(0);
  });

  it("超过 4000 行时改用色块近似渲染", () => {
    vi.useFakeTimers();
    const big = Array.from({ length: 4001 }, (_, i) => `line ${i}`).join("\n");
    const { view, canvas, ops } = setup(big);
    new Minimap(canvas, view);
    vi.advanceTimersByTime(200);
    expect(ops.text.length).toBe(0);
    expect(ops.bars.length).toBeGreaterThan(500);
    expect(ops.bars.length).toBeLessThanOrEqual(1500);
  });

  it("重绘代价与文档行数无关", () => {
    vi.useFakeTimers();
    const drawOnce = (lines: number) => {
      const doc = Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n");
      const { view, canvas, ops } = setup(doc);
      new Minimap(canvas, view);
      vi.advanceTimersByTime(200);
      return ops.bars.length + ops.text.length;
    };
    const small = drawOnce(5000);
    const huge = drawOnce(60000);
    expect(small).toBeGreaterThan(0);
    expect(huge).toBe(small);
  });

  it("按 devicePixelRatio 放大画布位图", () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    const { view, canvas, ops } = setup("a\nb");
    new Minimap(canvas, view);
    vi.advanceTimersByTime(200);
    expect(canvas.width).toBe(220);
    expect(canvas.style.width).toBe("110px");
    expect(ops.transforms[0]).toEqual([2, 0, 0, 2, 0, 0]);
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  });

  it("关闭后不再调度渲染", () => {
    vi.useFakeTimers();
    const { view, canvas, ops } = setup();
    const mm = new Minimap(canvas, view);
    mm.toggle();
    ops.text.length = 0;
    mm.onUpdate(true);
    vi.advanceTimersByTime(500);
    expect(ops.text.length).toBe(0);
    mm.toggle();
    vi.advanceTimersByTime(500);
    expect(ops.text.map((t) => t[0])).toEqual(["hello", "world", "foo"]);
  });

  it("onUpdate(false) 只同步视口指示器", () => {
    vi.useFakeTimers();
    const { view, canvas, ops, wrap } = setup();
    const mm = new Minimap(canvas, view);
    vi.advanceTimersByTime(200);
    const indicator = wrap.querySelector<HTMLElement>(".minimap-viewport")!;
    expect(indicator.style.display).toBe("block");
    ops.text.length = 0;
    view.scrollDOM.scrollTop = 100;
    mm.onUpdate(false);
    // 指示器挪到下一帧统一同步，避免在 CodeMirror 测量前强制布局
    vi.advanceTimersByTime(50);
    expect(ops.text.length).toBe(0);
    expect(Number(indicator.style.top.replace("px", ""))).toBeGreaterThan(0);
  });
});

describe("Minimap 交互", () => {
  it("点击画布按比例滚动，拖拽继续跟随", () => {
    vi.useFakeTimers();
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const { view, canvas } = setup(big);
    new Minimap(canvas, view);
    vi.advanceTimersByTime(200);
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ top: 0, height: 600, width: 110, left: 0, right: 110, bottom: 600, x: 0, y: 0 }),
      configurable: true
    });
    const scroller = view.scrollDOM;
    canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 300 }));
    const mid = scroller.scrollTop;
    expect(mid).toBeGreaterThan(0);
    canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 590 }));
    expect(scroller.scrollTop).toBeGreaterThan(mid);
    // 拖拽中：窗口上的 mousemove 仍然驱动滚动，mouseup 后停止
    scroller.scrollTop = 0;
    canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 100 }));
    const dragFrom = scroller.scrollTop;
    window.dispatchEvent(new MouseEvent("mousemove", { clientY: 500 }));
    expect(scroller.scrollTop).toBeGreaterThan(dragFrom);
    window.dispatchEvent(new MouseEvent("mouseup"));
    const held = scroller.scrollTop;
    window.dispatchEvent(new MouseEvent("mousemove", { clientY: 10 }));
    expect(scroller.scrollTop).toBe(held);
  });

  it("滚动编辑器时视口指示器同步移动", () => {
    vi.useFakeTimers();
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const { view, canvas, wrap } = setup(big);
    new Minimap(canvas, view);
    vi.advanceTimersByTime(200);
    const indicator = wrap.querySelector<HTMLElement>(".minimap-viewport")!;
    const topOf = () => parseFloat(indicator.style.top);
    view.scrollDOM.scrollTop = 0;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(50);
    expect(topOf()).toBe(0);
    view.scrollDOM.scrollTop = 800;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(50);
    expect(topOf()).toBeGreaterThan(0);
    expect(indicator.style.width).toBe("800px");
  });
});
