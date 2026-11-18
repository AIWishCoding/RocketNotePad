import { beforeAll, describe, expect, it } from "vitest";
import { demoFs, EDIT_SIZE_LIMIT, type TauriMock } from "../helpers/tauri-mock";
import {
  $id,
  $q,
  bootApp,
  dblClickRow,
  editorContent,
  flush,
  globalKey,
  keydown,
  tabStates,
  until,
  viewFromDom,
  type BootedApp
} from "../helpers/dom";

let app: BootedApp;
let mock: TauriMock;

/** 一个 1.2 KiB 的日志文件；阈值压到 600 B 就能在没有真大文件的测试里复现只读路径 */
const HUGE = Array.from({ length: 60 }, (_, i) => `日志行 ${i} detail ${"x".repeat(10)}`).join("\n") + "\n";

const bare = (name: string) => name.replace(/^● /, "");
const tab = (name: string) => tabStates().find((t) => bare(t.name) === name);
const writes = () => mock.invokeLog("write_text_file");

async function openNode(name: string): Promise<void> {
  dblClickRow(name);
  await until(() => tab(name) !== undefined);
  await flush(20);
}

beforeAll(async () => {
  app = await bootApp({
    fs: { ...demoFs(), "/demo/huge.log": HUGE, "/demo/small.log": "普通小文件\n" },
    largeFileLimit: 600,
    storage: { "rnp.folders": JSON.stringify(["/demo"]) }
  });
  mock = app.mock;
  await until(() => !!$id("sidebar-tree"));
});

describe("超大文件只读打开", () => {
  it("默认阈值就是后端的 64 MiB", () => {
    expect(EDIT_SIZE_LIMIT).toBe(64 * 1024 * 1024);
  });

  it("超过阈值的文件以只读打开并在状态栏标注", async () => {
    await openNode("huge.log");
    const view = viewFromDom();
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect($id("st-size").textContent).toContain("只读");
    expect($id("st-size").title).toBe("文件过大，已按只读打开，不能编辑");
    expect(editorContent()).toContain("日志行 0");
  });

  it("只读标签改不动，也不会出现未保存标记", async () => {
    await openNode("huge.log");
    const view = viewFromDom();
    view.dispatch({ changes: { from: 0, insert: "注入" } });
    globalKey("s", { metaKey: true });
    await flush(30);
    expect(view.state.doc.toString()).toBe(HUGE);
    expect(tab("huge.log")!.dirty).toBe(false);
    expect($id("st-size").textContent).toContain("只读");
  });

  it("只读文件仍然可以查找与跳转", async () => {
    await openNode("huge.log");
    mock.emit("menu-action", "find.open");
    await until(() => !!$q(".rnp-find-input"));
    const input = $q<HTMLInputElement>(".rnp-find-input");
    input.value = "日志行 42";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(20);
    expect($q(".rnp-find-count").textContent).toBe("1 / 1");
    keydown($q(".rnp-find")!, "Escape");
    await until(() => !$q(".rnp-find"));
    expect(viewFromDom().state.readOnly).toBe(true);
  });

  it("未超过阈值的文件照常可编辑", async () => {
    await openNode("small.log");
    const view = viewFromDom();
    expect(view.state.readOnly).toBe(false);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
    expect($id("st-size").title).toBe("");
    const before = writes().length;
    view.dispatch({ changes: { from: 0, insert: "改一笔" } });
    await until(() => tab("small.log")!.dirty);
    globalKey("s", { metaKey: true });
    await until(() => writes().length === before + 1);
    await until(() => !tab("small.log")!.dirty);
    expect(mock.fs.content("/demo/small.log")).toBe("改一笔普通小文件\n");
  });

  it("从只读标签切回普通标签后恢复可编辑", async () => {
    await openNode("huge.log");
    expect(viewFromDom().state.readOnly).toBe(true);
    await openNode("note.md");
    const view = viewFromDom();
    expect(view.state.readOnly).toBe(false);
    view.dispatch({ changes: { from: 0, insert: "# 改过\n" } });
    await until(() => tab("note.md")!.dirty);
    expect(editorContent()).toContain("# 改过");
    await openNode("huge.log");
    expect(viewFromDom().state.readOnly).toBe(true);
    expect($id("st-size").textContent).toContain("只读");
  });
});
