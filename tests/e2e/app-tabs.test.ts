import { beforeAll, describe, expect, it } from "vitest";
import { demoFs, type TauriMock } from "../helpers/tauri-mock";
import {
  $id,
  $q,
  $qa,
  bootApp,
  click,
  clickRow,
  dblClickRow,
  editorContent,
  flush,
  globalKey,
  mouse,
  tabEls,
  tabStates,
  until,
  viewFromDom,
  type BootedApp
} from "../helpers/dom";

let app: BootedApp;
let mock: TauriMock;

/** 关闭自动保存，让“脏标签”走对话框流程而不是悄悄落盘 */
beforeAll(async () => {
  app = await bootApp({
    fs: demoFs(),
    recent: ["/demo/note.md", "/demo/Dockerfile"],
    storage: { "rnp.folders": JSON.stringify(["/demo"]), "rnp.autoSave": "0" }
  });
  mock = app.mock;
  await until(() => $qa("#welcome-recent .recent-item").length > 0);
});

/** 脏标签名字带 “● ” 前缀，按业务名查找时两种都接受 */
const bare = (name: string) => name.replace(/^● /, "");
const tab = (name: string) => tabStates().find((t) => bare(t.name) === name);
const tabIndex = (name: string) => tabStates().findIndex((t) => bare(t.name) === name);
const tabAt = (name: string) => tabEls()[tabIndex(name)];

/** 关闭标签后编辑器仍留着上一份文档，因此只能等标签状态而不是内容 */
async function waitTab(name: string): Promise<void> {
  await until(() => tab(name)?.active === true);
}

async function waitTabCount(n: number): Promise<void> {
  await until(() => tabStates().length === n);
}

/** 精确安排后续对话框答案，避免残留答案影响其它用例 */
function answer(asks: boolean[], saves: Array<string | null> = []): void {
  mock.dialogs.ask.length = 0;
  mock.dialogs.ask.push(...asks);
  mock.dialogs.save.length = 0;
  mock.dialogs.save.push(...saves);
}

async function editInsert(text: string): Promise<void> {
  viewFromDom().dispatch({ changes: { from: 0, insert: text } });
  await until(() => tabStates().some((t) => t.dirty));
}

async function closeByKey(): Promise<void> {
  globalKey("w", { metaKey: true });
  await flush(20);
}

/** 关掉所有标签，回到干净起点 */
async function closeAllTabs(): Promise<void> {
  for (let guard = 0; guard < 10 && tabStates().length > 0; guard++) {
    const dirtyIndex = tabStates().findIndex((t) => t.dirty);
    if (dirtyIndex >= 0) {
      answer([false, true]);
      click(tabEls()[dirtyIndex]);
      await flush(20);
      globalKey("w", { metaKey: true });
    } else {
      mouse(tabEls()[0].querySelector(".tab-close")!, "click");
    }
    await flush(30);
  }
  await waitTabCount(0);
}

describe("欢迎页与最近打开", () => {
  it("启动后没有标签，展示欢迎页与最近打开列表", () => {
    expect(tabStates()).toEqual([]);
    expect($id("welcome").classList.contains("hidden")).toBe(false);
    expect($id("editor-wrap").classList.contains("hidden")).toBe(true);
    expect($q(".welcome-recent-title")?.textContent).toBe("最近打开");
    expect($qa("#welcome-recent .recent-item").map((i) => i.textContent)).toEqual([
      "note.md",
      "Dockerfile"
    ]);
    expect($qa("#welcome-recent .recent-item")[0].title).toBe("/demo/note.md");
  });

  it("点击最近项以固定标签打开", async () => {
    click($qa("#welcome-recent .recent-item")[0]);
    await waitTab("note.md");
    expect(tab("note.md")).toMatchObject({ preview: false, active: true, dirty: false });
    expect(editorContent()).toContain("标题");
  });

  it("标签的 × 关闭干净的标签后回到欢迎页", async () => {
    mouse(tabEls()[0].querySelector(".tab-close")!, "click");
    await waitTabCount(0);
    expect($id("welcome").classList.contains("hidden")).toBe(false);
    expect(mock.messages).toEqual([]);
  });
});

describe("预览标签与固定标签", () => {
  it("单击目录树文件产生预览标签", async () => {
    clickRow("note.md");
    await waitTab("note.md");
    expect(tabStates()).toHaveLength(1);
    expect(tab("note.md")).toMatchObject({ preview: true, active: true });
    expect(tabEls()[0].title).toBe("/demo/note.md");
  });

  it("再单击另一个文件复用同一个预览标签", async () => {
    clickRow("a.cpp");
    await waitTab("a.cpp");
    expect(tabStates()).toHaveLength(1);
    expect(tab("a.cpp")!.preview).toBe(true);
    expect(editorContent()).toContain("int main");
  });

  it("编辑预览标签会取消预览态并标记为已修改", async () => {
    await editInsert("// touched\n");
    expect(tab("a.cpp")).toMatchObject({ preview: false, dirty: true });
    expect(tabStates()[0].name).toBe("● a.cpp");
  });

  it("双击文件生成固定标签，已打开的文件只切换", async () => {
    dblClickRow("B.ts");
    await waitTab("B.ts");
    expect(tabStates().map((t) => t.name)).toEqual(["● a.cpp", "B.ts"]);
    clickRow("B.ts");
    await flush(20);
    expect(tabStates()).toHaveLength(2);
    expect(tab("B.ts")!.active).toBe(true);
  });

  it("新建标签命名为“未命名 1”，状态栏报告未保存", async () => {
    globalKey("n", { metaKey: true });
    await waitTab("未命名 1");
    expect(tabAt("未命名 1").title).toBe("未保存的新文件");
    expect($id("st-size").textContent).toBe("未保存");
  });
});

describe("关闭标签与未保存修改", () => {
  it("选择“不保存 + 丢弃”后直接关闭脏标签", async () => {
    answer([false, true]);
    click(tabAt("a.cpp"));
    await waitTab("a.cpp");
    await closeByKey();
    await waitTabCount(2);
    expect(mock.fs.content("/demo/a.cpp")).toBe("int main() { return 0; }\n");
    expect(mock.messages).toEqual([]);
  });

  it("选择“保存”时先落盘再关闭", async () => {
    answer([true]);
    click(tabAt("B.ts"));
    await waitTab("B.ts");
    await editInsert("const y = 2;\n");
    await closeByKey();
    await waitTabCount(1);
    expect(mock.invokeLog("write_text_file").at(-1)?.args.path).toBe("/demo/B.ts");
    expect(mock.fs.content("/demo/B.ts")).toContain("const y = 2;");
    expect(tab("未命名 1")).toBeTruthy();
  });

  it("两次确认都取消时保持标签不动", async () => {
    answer([false, false]);
    expect(tab("未命名 1")!.active).toBe(true);
    await editInsert("// dirty\n");
    await closeByKey();
    expect(tabStates()).toHaveLength(1);
    expect(tab("未命名 1")!.dirty).toBe(true);
  });

  it("中键点击脏标签时按“保存”路径落盘后关闭", async () => {
    answer([true], ["/demo/from-untitled.txt"]);
    mouse(tabAt("未命名 1"), "auxclick", { button: 1 });
    await waitTabCount(0);
    expect(mock.fs.content("/demo/from-untitled.txt")).toBe("// dirty\n");
    expect(mock.recent.map((r) => r.path)).toContain("/demo/from-untitled.txt");
  });
});

describe("标签切换与状态栏", () => {
  beforeAll(async () => {
    clickRow("config.json");
    await waitTab("config.json");
    dblClickRow("Dockerfile");
    await waitTab("Dockerfile");
    dblClickRow("a.cpp");
    await waitTab("a.cpp");
  });

  it("关闭活动标签后自动激活相邻标签", async () => {
    expect(tabStates()).toHaveLength(3);
    mouse(tabAt("a.cpp").querySelector(".tab-close")!, "click");
    await waitTabCount(2);
    expect(tab("Dockerfile")!.active).toBe(true);
  });

  it("⌘Tab 正向、⇧⌘Tab 反向循环", async () => {
    const count = tabStates().length;
    const activeIndex = () => tabStates().findIndex((t) => t.active);
    const start = activeIndex();
    globalKey("Tab", { metaKey: true });
    await until(() => activeIndex() === (start + 1) % count);
    globalKey("Tab", { metaKey: true, shiftKey: true });
    await until(() => activeIndex() === start);
  });

  it("切换标签时编辑器文档、语言与编码指示随之更新", async () => {
    click(tabAt("Dockerfile"));
    await until(() => editorContent().includes("FROM rust"));
    expect($id("st-lang").textContent).toBe("Dockerfile");
    expect($id("st-enc").textContent).toBe("UTF-8 · LF");
    click(tabAt("config.json"));
    await until(() => editorContent().includes("\"a\""));
    expect($id("st-lang").textContent).toBe("JSON");
    expect($id("st-size").textContent).toBe("13 B");
    expect($id("st-pos").textContent).toBe("行 1, 列 1");
  });

  it("切换标签时资源管理器自动选中对应文件", async () => {
    const selectedName = () =>
      $q("#sidebar-tree .tree-row.selected .tree-label")?.textContent ?? "";
    click(tabAt("Dockerfile"));
    await until(() => tab("Dockerfile")?.active === true && selectedName() === "Dockerfile");
    click(tabAt("config.json"));
    await until(() => tab("config.json")?.active === true && selectedName() === "config.json");
    // ⌘Tab 循环切换同样跟随选中
    globalKey("Tab", { metaKey: true });
    await until(() => tab("Dockerfile")?.active === true && selectedName() === "Dockerfile");
  });

  it("选中文本时状态栏报告选中长度", async () => {
    viewFromDom().dispatch({ selection: { anchor: 0, head: 5 } });
    await until(() => $id("st-sel").textContent.includes("选中"));
    expect($id("st-sel").textContent).toBe("选中 5 字符");
  });

  it("关闭全部标签后状态栏清空并回到欢迎页", async () => {
    await closeAllTabs();
    expect($id("welcome").classList.contains("hidden")).toBe(false);
    for (const id of ["st-pos", "st-sel", "st-size", "st-enc", "st-lang"]) {
      expect($id(id).textContent).toBe("");
    }
  });
});
