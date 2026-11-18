import { beforeAll, describe, expect, it, vi } from "vitest";
import { demoFs, type TauriMock } from "../helpers/tauri-mock";
import { MarkdownPreview } from "../../src/preview";
import {
  $id,
  $qa,
  bootApp,
  click,
  flush,
  until,
  untilConfig,
  viewFromDom,
  type BootedApp
} from "../helpers/dom";

let app: BootedApp;
let mock: TauriMock;

/** 给元素挂计数版几何量：读一次记一次，用来盯住更新回调里有没有强制同步布局 */
function countReads(el: HTMLElement, sizes: Record<string, number>): () => number {
  let reads = 0;
  for (const [prop, value] of Object.entries(sizes)) {
    Object.defineProperty(el, prop, {
      configurable: true,
      get: () => {
        reads++;
        return value;
      }
    });
  }
  return () => reads;
}

const bigDoc = Array.from({ length: 3000 }, (_, i) => `第 ${i} 行：the quick brown fox jumps over the lazy dog`).join("\n");

beforeAll(async () => {
  app = await bootApp({
    fs: { ...demoFs(), "/demo/big.txt": bigDoc },
    config: {
      folders: ["/demo"],
      preview: true,
      autoSave: false,
      minimap: true,
      restoreTabs: ["/demo/big.txt", "/demo/note.md"],
      restoreActive: "/demo/big.txt"
    }
  });
  mock = app.mock;
  await until(() => $qa("#tabbar .tab").length === 2);
  // 让小地图的首次重绘先跑完，后面的计数才只反映拖选本身
  await flush(260);
});

describe("拖选与编辑的流畅度", () => {
  it("连续拖选时状态栏只改光标位，其余字段一次都不重写", async () => {
    const view = viewFromDom();
    const fixed = ["st-size", "st-enc", "st-lang", "st-font", "st-zoom", "st-wrap", "st-theme"].map($id);
    const write = vi.spyOn(Node.prototype, "textContent", "set");
    for (let i = 0; i < 200; i++) {
      view.dispatch({ selection: { anchor: i * 7, head: i * 7 + 3 } });
    }
    const rewritten = write.mock.contexts.filter((el) => fixed.includes(el as HTMLElement)).length;
    expect(rewritten).toBe(0);
    expect(write.mock.calls.length).toBeGreaterThan(0);
    expect($id("st-sel").textContent).toBe("选中 3 字符");
    write.mockRestore();
    await flush(40);
  });

  it("选区更新不在回调里读几何量，小地图的读取推迟到帧里且次数固定", async () => {
    const view = viewFromDom();
    const canvas = $id("minimap");
    const canvasReads = countReads(canvas, { clientHeight: 600, clientWidth: 110 });
    const scrollReads = countReads(view.scrollDOM, { scrollHeight: 90000, clientHeight: 600 });
    for (let i = 0; i < 200; i++) {
      view.dispatch({ selection: { anchor: i * 11, head: i * 11 + 5 } });
    }
    expect(canvasReads() + scrollReads()).toBe(0);
    await flush(60);
    const after = canvasReads();
    expect(after).toBeLessThanOrEqual(4);
    for (let i = 0; i < 200; i++) {
      view.dispatch({ selection: { anchor: i * 13, head: i * 13 + 2 } });
    }
    await flush(60);
    expect(canvasReads()).toBeLessThanOrEqual(after + 4);
  });

  it("预览没打开时连续输入不拼整篇文档，也不触发预览渲染", async () => {
    expect($id("preview-pane").classList.contains("hidden")).toBe(true);
    const update = vi.spyOn(MarkdownPreview.prototype, "update");
    const view = viewFromDom();
    for (let i = 0; i < 60; i++) {
      view.dispatch({ changes: { from: 0, insert: "x" } });
    }
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("切到 Markdown 标签后预览恢复实时更新", async () => {
    click($qa("#tabbar .tab")[1]);
    await until(() => !$id("preview-pane").classList.contains("hidden"));
    const update = vi.spyOn(MarkdownPreview.prototype, "update");
    viewFromDom().dispatch({ changes: { from: 0, insert: "开头" } });
    expect(update).toHaveBeenCalledTimes(1);
    expect(String(update.mock.calls[0][0])).toContain("标题");
    update.mockRestore();
    await until(() => ($id("preview-pane").textContent ?? "").includes("标题"));
    await untilConfig(mock, "restoreActive", "/demo/note.md");
  });
});