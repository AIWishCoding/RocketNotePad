import { beforeAll, describe, expect, it, vi } from "vitest";
import { demoFs, type TauriMock } from "../helpers/tauri-mock";
import {
  $id,
  bootApp,
  clickRow,
  dblClickRow,
  editorContent,
  flush,
  globalKey,
  tabStates,
  until,
  viewFromDom,
  type BootedApp
} from "../helpers/dom";

let app: BootedApp;
let mock: TauriMock;

beforeAll(async () => {
  app = await bootApp({
    fs: { ...demoFs(), "/demo/win.txt": "line1\r\nline2\r\n", "/demo/cr.txt": "a\rb\rc" },
    storage: { "rnp.folders": JSON.stringify(["/demo"]) }
  });
  mock = app.mock;
  await until(() => !!$id("sidebar-tree"));
});

const bare = (name: string) => name.replace(/^● /, "");
const tab = (name: string) => tabStates().find((t) => bare(t.name) === name);
const writes = () => mock.invokeLog("write_text_file");
const lastWrite = () => writes().at(-1);

async function waitWriteCount(n: number): Promise<void> {
  await until(() => writes().length === n);
}

async function editInsert(text: string): Promise<void> {
  viewFromDom().dispatch({ changes: { from: 0, insert: text } });
  await until(() => tabStates().some((t) => t.dirty));
}

async function openFile(name: string): Promise<void> {
  clickRow(name);
  await until(() => tab(name) !== undefined);
  await flush(20);
}

describe("手动保存", () => {
  it("⌘S 用原路径、原编码、原行尾写回并清除脏标记", async () => {
    await openFile("note.md");
    const before = writes().length;
    await editInsert("# 改过\n");
    globalKey("s", { metaKey: true });
    await waitWriteCount(before + 1);
    expect(lastWrite()!.args).toEqual({
      path: "/demo/note.md",
      content: "# 改过\n# 标题\n\n正文 one two three\n",
      encoding: "UTF-8",
      lineEnding: "\n"
    });
    expect(mock.fs.content("/demo/note.md")).toBe("# 改过\n# 标题\n\n正文 one two three\n");
    await until(() => tab("note.md")!.dirty === false);
    expect($id("st-size").textContent).toBe("40 B");
  });

  it("CRLF 文件保持 CRLF，且反复保存不会叠加成 \\r\\r\\n", async () => {
    await openFile("win.txt");
    expect($id("st-enc").textContent).toBe("UTF-8 · CRLF");
    expect(editorContent()).toContain("line1");
    for (let i = 0; i < 2; i++) {
      const before = writes().length;
      await editInsert("head\n");
      globalKey("s", { metaKey: true });
      await waitWriteCount(before + 1);
      expect(lastWrite()!.args.lineEnding).toBe("\r\n");
    }
    const saved = mock.fs.content("/demo/win.txt")!;
    expect(saved).toContain("head\r\nline1\r\n");
    expect(saved).not.toContain("\r\r\n");
  });

  it("单独 CR 行尾的文件报告为 CR 并按 CR 落盘", async () => {
    await openFile("cr.txt");
    expect($id("st-enc").textContent).toBe("UTF-8 · CR");
    const before = writes().length;
    await editInsert("z\n");
    globalKey("s", { metaKey: true });
    await waitWriteCount(before + 1);
    expect(lastWrite()!.args.lineEnding).toBe("\r");
    expect(mock.fs.content("/demo/cr.txt")).toBe("z\ra\rb\rc");
  });

  it("另存为走保存对话框，并改名换语言", async () => {
    dblClickRow("note.md");
    await until(() => tab("note.md")!.active);
    mock.dialogs.save.length = 0;
    mock.dialogs.save.push("/demo/other.py");
    const before = writes().length;
    globalKey("s", { metaKey: true, shiftKey: true });
    await waitWriteCount(before + 1);
    expect(lastWrite()!.args.path).toBe("/demo/other.py");
    expect(tab("other.py")).toBeTruthy();
    expect($id("st-lang").textContent).toBe("Python");
  });

  it("保存对话框取消时不落盘、保持脏", async () => {
    const before = writes().length;
    await editInsert("x = 1\n");
    mock.dialogs.save.length = 0;
    mock.dialogs.save.push(null);
    globalKey("s", { metaKey: true, shiftKey: true });
    await flush(30);
    expect(writes()).toHaveLength(before);
    expect(tab("other.py")!.dirty).toBe(true);
  });

  it("后端写入失败时提示“保存失败”并保留脏标记", async () => {
    mock.fail("write_text_file", "只读文件系统");
    const before = mock.messages.length;
    globalKey("s", { metaKey: true });
    await until(() => mock.messages.length === before + 1);
    expect(mock.messages.at(-1)).toMatchObject({ title: "保存失败", kind: "error" });
    expect(mock.messages.at(-1)!.message).toContain("只读文件系统");
    expect(tab("other.py")!.dirty).toBe(true);
    mock.clearFailures();
  });
});

describe("自动保存", () => {
  it("编辑已保存文件后停顿 1.5 秒自动写盘", async () => {
    vi.useFakeTimers();
    try {
      const before = writes().length;
      viewFromDom().dispatch({ changes: { from: 0, insert: "# 自动\n" } });
      await vi.advanceTimersByTimeAsync(1400);
      expect(writes()).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(200);
      expect(writes()).toHaveLength(before + 1);
      expect(lastWrite()!.args.path).toBe("/demo/other.py");
      expect((lastWrite()!.args.content as string).startsWith("# 自动")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(tabStates().some((t) => t.dirty)).toBe(false);
  });

  it("未命名的新文件不会被自动写盘", async () => {
    globalKey("n", { metaKey: true });
    await until(() => tab("未命名 1") !== undefined);
    const before = writes().length;
    viewFromDom().dispatch({ changes: { from: 0, insert: "草稿\n" } });
    await flush(1700);
    expect(writes()).toHaveLength(before);
    expect(tab("未命名 1")!.dirty).toBe(true);
  });

  it("窗口失焦时立刻冲刷待写入内容", async () => {
    dblClickRow("Dockerfile");
    await until(() => tab("Dockerfile")?.active === true);
    vi.useFakeTimers();
    try {
      const before = writes().length;
      viewFromDom().dispatch({ changes: { from: 0, insert: "# syntax: docker\n" } });
      await vi.advanceTimersByTimeAsync(200);
      expect(writes()).toHaveLength(before);
      window.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(50);
      expect(writes()).toHaveLength(before + 1);
      expect(lastWrite()!.args.path).toBe("/demo/Dockerfile");
    } finally {
      vi.useRealTimers();
    }
  });

  it("页面切到后台时同样冲刷", async () => {
    dblClickRow("B.ts");
    await until(() => tab("B.ts")?.active === true);
    vi.useFakeTimers();
    try {
      const before = writes().length;
      viewFromDom().dispatch({ changes: { from: 0, insert: "export const z = 3;\n" } });
      await vi.advanceTimersByTimeAsync(200);
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(50);
      expect(writes()).toHaveLength(before + 1);
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("自动保存失败只提示一次，不反复弹框", async () => {
    mock.fail("write_text_file", "只读文件系统");
    const before = mock.messages.length;
    await editInsert("// dirty again\n");
    await flush(1700);
    expect(mock.messages).toHaveLength(before + 1);
    expect(mock.messages.at(-1)).toMatchObject({ title: "自动保存失败", kind: "error" });
    expect(mock.messages.at(-1)!.message).toContain("仍是未保存状态");
    await editInsert("// more\n");
    await flush(1700);
    expect(mock.messages).toHaveLength(before + 1);
    mock.clearFailures();
    await editInsert("// final\n");
    await flush(1700);
    expect(tab("B.ts")!.dirty).toBe(false);
  });
});

describe("会话恢复", () => {
  it("打开与另存为都会把标签路径写进配置文件", async () => {
    await until(
      () =>
        ((mock.configJson()?.restoreTabs as string[]) ?? []).includes("/demo/other.py") &&
        ((mock.configJson()?.restoreTabs as string[]) ?? []).includes("/demo/Dockerfile")
    );
    const restored: string[] = mock.configJson()?.restoreTabs ?? [];
    expect(restored).not.toContain(null);
  });

  it("保存后的文件内容对后端可见，可被下一次启动重新读取", () => {
    expect(mock.fs.content("/demo/B.ts")).toContain("export const z = 3;");
    expect(mock.fs.content("/demo/win.txt")).toContain("head");
  });
});
