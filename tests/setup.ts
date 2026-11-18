/**
 * jsdom 缺失的浏览器能力补齐：CodeMirror、minimap（canvas）、侧边栏滚动等都依赖这些 API。
 */

/**
 * Node 26 起全局 `localStorage` 会被解析成需要 --localstorage-file 的内置实现（值为 undefined），
 * 覆盖成内存版，保证应用代码里的 localStorage.* 可用。
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length() {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }

  removeItem(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

for (const target of [globalThis, window] as unknown[]) {
  Object.defineProperty(target, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true
  });
}

/** 记录所有绘制调用的假 2D 上下文，便于断言 minimap 确实渲染了 */
export const canvasOps: string[] = [];

function makeCtx(): Record<string, unknown> {
  const noop = (name: string) => (...args: unknown[]) => {
    canvasOps.push(`${name}(${args.join(",")})`);
  };
  const ctx: Record<string, unknown> = {
    canvas: null,
    setTransform: noop("setTransform"),
    clearRect: noop("clearRect"),
    fillRect: noop("fillRect"),
    fillText: noop("fillText"),
    strokeRect: noop("strokeRect"),
    beginPath: noop("beginPath"),
    closePath: noop("closePath"),
    moveTo: noop("moveTo"),
    lineTo: noop("lineTo"),
    stroke: noop("stroke"),
    fill: noop("fill"),
    save: noop("save"),
    restore: noop("restore"),
    translate: noop("translate"),
    scale: noop("scale"),
    drawImage: noop("drawImage"),
    measureText: (text: string) => ({ width: String(text).length * 6 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
      width: w,
      height: h
    }),
    putImageData: noop("putImageData"),
    font: "13px monospace",
    fillStyle: "#000",
    strokeStyle: "#000",
    textBaseline: "top",
    lineWidth: 1
  };
  return ctx;
}

function fakeGetContext(
  this: HTMLCanvasElement,
  kind?: string
): CanvasRenderingContext2D | null {
  if (kind !== "2d") return null;
  const existing = (this as unknown as { __ctx?: CanvasRenderingContext2D }).__ctx;
  if (existing) return existing;
  const ctx = makeCtx() as unknown as CanvasRenderingContext2D;
  Object.defineProperty(this, "__ctx", { value: ctx, configurable: true });
  return ctx;
}

HTMLCanvasElement.prototype.getContext =
  fakeGetContext as unknown as typeof HTMLCanvasElement.prototype.getContext;

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

globalThis.ResizeObserver ??= FakeResizeObserver as unknown as typeof ResizeObserver;
window.ResizeObserver ??= FakeResizeObserver as unknown as typeof ResizeObserver;
window.IntersectionObserver ??=
  FakeIntersectionObserver as unknown as typeof window.IntersectionObserver;

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => undefined);

/** jsdom 的滚动尺寸为常量 0，补齐一个可写的近似实现，避免除零分支被跳过 */
for (const [prop, value] of [
  ["clientHeight", 600],
  ["scrollHeight", 1200],
  ["clientWidth", 800],
  ["scrollWidth", 800]
] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get: () => value
  });
}

window.scrollTo = (() => undefined) as typeof window.scrollTo;

/** jsdom 的 Range 缺少几何 API，CodeMirror 的选区/光标测量会直接抛错 */
function emptyRectList(): DOMRectList {
  const rectList = {
    length: 0,
    item: () => null
  } as unknown as DOMRectList;
  (rectList as unknown as { [Symbol.iterator]: () => Iterator<DOMRect> })[Symbol.iterator] =
    function* () {
      /* 没有可布局的矩形 */
    };
  return rectList;
}

const zeroRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  toJSON: () => ({})
} as DOMRect;

Range.prototype.getClientRects ??= emptyRectList;
Range.prototype.getBoundingClientRect ??= () => zeroRect;
if (!Element.prototype.getClientRects) {
  Element.prototype.getClientRects = emptyRectList;
  Element.prototype.getBoundingClientRect = () => zeroRect;
}
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  })) as typeof window.matchMedia;
}
