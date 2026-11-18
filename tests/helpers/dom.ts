import { EditorView } from "@codemirror/view";
import { installTauriMock, type TauriMock, type TauriMockOptions } from "./tauri-mock";

/** 应用外壳：与 index.html 保持一致的最小 DOM */
export function mountShell() {
  document.body.innerHTML = '<div id="app"></div>';
  document.body.removeAttribute("data-theme");
  localStorage.clear();
}

export function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待条件成立，用于等待 main() 里的异步启动流程 */
export async function until(condition: () => boolean, timeout = 3000, step = 10): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("等待超时: 页面状态未达到预期");
    await flush(step);
  }
}

export const $id = (id: string): HTMLElement => document.getElementById(id)!;

/** 等待配置文件（应用目录那份 JSON）里的字段变成期望值：落盘是防抖的，不能同步断言 */
export async function untilConfig(mock: TauriMock, key: string, value: unknown): Promise<void> {
  await until(() => mock.configJson()?.[key] === value);
}
export const $q = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T =>
  root.querySelector(sel) as T;
export const $qa = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  [...root.querySelectorAll(sel)] as T[];

export const treeRows = (): HTMLElement[] => $qa("#sidebar-tree .tree-row");

export function rowText(row: HTMLElement): string {
  return row.querySelector(".tree-label")?.textContent ?? "";
}

export function findRow(name: string): HTMLElement {
  const row = treeRows().find((r) => rowText(r) === name);
  if (!row) throw new Error(`目录树中没有节点: ${name}（现有: ${treeRows().map(rowText).join(", ")}）`);
  return row;
}

export const visibleTreeNames = (): string[] => treeRows().map(rowText);

export function tabEls(): HTMLElement[] {
  return $qa("#tabbar .tab");
}

export function tabStates(): Array<{ name: string; preview: boolean; active: boolean; dirty: boolean }> {
  return tabEls().map((t) => ({
    name: t.querySelector(".tab-name")?.textContent ?? "",
    preview: t.classList.contains("preview"),
    active: t.classList.contains("active"),
    dirty: (t.querySelector(".tab-name")?.textContent ?? "").startsWith("●")
  }));
}

export function editorContent(): string {
  return $q(".cm-content")?.textContent ?? "";
}

export function viewFromDom(): EditorView {
  const view = EditorView.findFromDOM($q(".cm-editor"));
  if (!view) throw new Error("找不到 EditorView");
  return view;
}

export function mouse(target: Element, type: string, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

/** jsdom 的 HTMLElement 没有 dblclick() 方法，统一用事件派发 */
export function click(target: Element) {
  mouse(target, "click");
}

export function dblClick(target: Element) {
  mouse(target, "dblclick");
}

export const clickRow = (name: string) => click(findRow(name));
export const dblClickRow = (name: string) => dblClick(findRow(name));

/** jsdom 不会从 key 推导 keyCode，而 CodeMirror 的对话框只认 keyCode，这里补齐 */
const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  F3: 114
};

export function keydown(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init });
  const keyCode = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  if (!ev.keyCode && keyCode) {
    Object.defineProperty(ev, "keyCode", { configurable: true, get: () => keyCode });
  }
  target.dispatchEvent(ev);
  return ev;
}

/** 在编辑器 DOM 上派发按键，走 CodeMirror 的 keymap */
export function editorKey(key: string, init: KeyboardEventInit = {}) {
  return keydown($q(".cm-content"), key, init);
}

/** 文档级按键（侧边栏键盘导航、全局快捷键等） */
export function globalKey(key: string, init: KeyboardEventInit = {}) {
  return keydown(document.body, key, init);
}

export interface BootedApp {
  mock: TauriMock;
}

/**
 * 安装后端 mock 后导入应用入口。main.ts 在导入时执行 main()，
 * 因此每个测试文件需要独立的模块图（配合 vi.resetModules 或单独文件）。
 */
export async function bootApp(
  options: TauriMockOptions & { storage?: Record<string, string> } = {}
): Promise<BootedApp> {
  mountShell();
  for (const [k, v] of Object.entries(options.storage ?? {})) localStorage.setItem(k, v);
  const mock = installTauriMock(options);
  await import("../../src/main.ts");
  await until(() => !!$q("#sidebar-tree") && !!$q(".cm-editor"));
  return { mock };
}

/** 打开应用并等待目录树就绪 */
export async function bootAppWithFolder(
  fs: Record<string, string | null>,
  extraStorage: Record<string, string> = {}
): Promise<BootedApp> {
  return bootApp({
    fs,
    storage: { "rnp.folders": JSON.stringify(["/demo"]), ...extraStorage }
  });
}
