import { beforeAll, describe, expect, it } from "vitest";
import { demoFs, type TauriMock } from "../helpers/tauri-mock";
import {
  $id,
  $q,
  $qa,
  bootApp,
  click,
  dblClickRow,
  editorContent,
  flush,
  globalKey,
  keydown,
  mouse,
  tabStates,
  until,
  viewFromDom,
  type BootedApp
} from "../helpers/dom";

let app: BootedApp;
let mock: TauriMock;

const bare = (name: string) => name.replace(/^● /, "");
const tab = (name: string) => tabStates().find((t) => bare(t.name) === name);

/** 超过只读阈值的大 SQL 文件，用来验证只读标签禁用格式化 */
const BIG_SQL = "select " + "col, ".repeat(60) + "1 from big_table;\n";

async function openFile(name: string): Promise<void> {
  dblClickRow(name);
  await until(() => tab(name)?.active === true);
  await flush(20);
}

/** 在编辑区派发右键，等待自定义菜单出现（外部语言要等后端探测工具） */
async function rightClickEditor(): Promise<void> {
  mouse($q(".cm-content"), "contextmenu", { clientX: 40, clientY: 40 });
  await until(() => !!$q(".ctx-menu"));
  await flush(10);
}

const items = () => $qa(".ctx-menu .ctx-item");
const itemByText = (text: string) => items().find((el) => el.firstElementChild?.textContent === text);
const hintOf = (text: string) => itemByText(text)?.querySelector(".ctx-hint")?.textContent ?? "";
const disabled = (text: string) => itemByText(text)?.classList.contains("disabled") ?? false;

beforeAll(async () => {
  app = await bootApp({
    fs: {
      ...demoFs(),
      "/demo/query.sql": "select id,name from users where id=1 and name='a';\n",
      "/demo/script.py": "x=1   \ny=2\t\n",
      "/demo/main.rs": "fn main(){println!(\"hi\");}\n",
      "/demo/big.sql": BIG_SQL
    },
    // 关掉自动保存，让格式化后的脏标签可断言；Rust 工具缺席以覆盖“未安装”分支
    largeFileLimit: 200,
    availableFormatters: ["Python", "Java", "C", "C++", "Go"],
    storage: { "rnp.folders": JSON.stringify(["/demo"]), "rnp.autoSave": "0" }
  });
  mock = app.mock;
  await until(() => !!$id("sidebar-tree"));
});

describe("编辑区右键菜单（应用接线）", () => {
  it("右键编辑区弹出自定义菜单，保留原生编辑动作并新增格式化文档", async () => {
    await openFile("query.sql");
    await rightClickEditor();
    expect($q(".ctx-menu")).toBeTruthy();
    for (const text of ["撤销", "重做", "剪切", "复制", "粘贴", "全选", "格式化文档"]) {
      expect(itemByText(text), text).toBeTruthy();
    }
    // 语言由真实标签的扩展名推断为 SQL，格式化项启用且标注内置
    expect($id("st-lang").textContent).toBe("SQL");
    expect(disabled("格式化文档")).toBe(false);
    expect(hintOf("格式化文档")).toBe("内置");
    keydown(document.body, "Escape");
    await until(() => !$q(".ctx-menu"));
  });

  it("点击格式化文档对 .sql 真实生效（内置引擎，不走后端）", async () => {
    await openFile("query.sql");
    const before = mock.invokeLog("format_document").length;
    await rightClickEditor();
    click(itemByText("格式化文档")!);
    await until(() => editorContent().includes("SELECT"));
    expect($q(".ctx-menu")).toBeNull();
    expect(editorContent()).toContain("FROM");
    expect(tab("query.sql")!.dirty).toBe(true);
    // SQL 走前端内置格式化，不应调用后端 format_document
    expect(mock.invokeLog("format_document").length).toBe(before);
  });

  it("外部语言（Python）右键格式化调用后端并整篇替换", async () => {
    await openFile("script.py");
    expect($id("st-lang").textContent).toBe("Python");
    await rightClickEditor();
    expect(disabled("格式化文档")).toBe(false);
    expect(hintOf("格式化文档")).toBe("black");
    const before = mock.invokeLog("format_document").length;
    click(itemByText("格式化文档")!);
    await until(() => tab("script.py")!.dirty);
    const call = mock.invokeLog("format_document").at(-1)!;
    expect(call.args.lang).toBe("Python");
    expect(mock.invokeLog("format_document").length).toBe(before + 1);
    // 默认 mock 变换去掉行尾空白
    expect(editorContent()).not.toMatch(/[ \t]+\n/);
  });

  it("缺工具的语言（Rust）格式化项禁用并提示安装", async () => {
    await openFile("main.rs");
    expect($id("st-lang").textContent).toBe("Rust");
    await rightClickEditor();
    expect(disabled("格式化文档")).toBe(true);
    expect(hintOf("格式化文档")).toBe("未安装 rustfmt");
    keydown(document.body, "Escape");
    await until(() => !$q(".ctx-menu"));
  });

  it("不支持的语言（Markdown）格式化项禁用并提示", async () => {
    await openFile("note.md");
    expect($id("st-lang").textContent).toBe("Markdown");
    await rightClickEditor();
    expect(disabled("格式化文档")).toBe(true);
    expect(hintOf("格式化文档")).toBe("暂不支持该语言");
    keydown(document.body, "Escape");
    await until(() => !$q(".ctx-menu"));
  });

  it("只读大文件禁用格式化与改写类动作", async () => {
    await openFile("big.sql");
    expect(viewFromDom().state.readOnly).toBe(true);
    await rightClickEditor();
    expect(disabled("格式化文档")).toBe(true);
    expect(hintOf("格式化文档")).toBe("只读文件");
    expect(disabled("撤销")).toBe(true);
    expect(disabled("粘贴")).toBe(true);
    expect(disabled("全选")).toBe(false);
    keydown(document.body, "Escape");
    await until(() => !$q(".ctx-menu"));
  });

  it("菜单里的全选作用于真实编辑器", async () => {
    await openFile("query.sql");
    await rightClickEditor();
    click(itemByText("全选")!);
    await flush(10);
    const view = viewFromDom();
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(view.state.doc.length);
  });

  it("菜单外左键点击关闭菜单", async () => {
    await openFile("query.sql");
    await rightClickEditor();
    expect($q(".ctx-menu")).toBeTruthy();
    click($id("sidebar"));
    await until(() => !$q(".ctx-menu"));
  });
});

describe("命令面板格式化入口", () => {
  it("“编辑: 格式化文档”命令对活动 SQL 文档生效", async () => {
    await openFile("query.sql");
    // 先弄乱大小写，确保命令确有改动
    viewFromDom().dispatch({ changes: { from: 0, to: viewFromDom().state.doc.length, insert: "select a from t\n" } });
    await until(() => tab("query.sql")!.dirty);
    globalKey("p", { metaKey: true, shiftKey: true });
    await until(() => !!$q(".palette-overlay .palette-input"));
    const input = $q<HTMLInputElement>(".palette-overlay .palette-input");
    input.value = "格式化文档";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(10);
    expect($qa(".palette-item")[0].textContent).toContain("编辑: 格式化文档");
    keydown(input, "Enter");
    await until(() => editorContent().includes("SELECT"));
    expect(editorContent()).toContain("FROM");
  });

  it("对不支持的语言执行命令给出中文提示且不改文档", async () => {
    await openFile("note.md");
    const before = editorContent();
    const msgs = mock.messages.length;
    globalKey("p", { metaKey: true, shiftKey: true });
    await until(() => !!$q(".palette-overlay .palette-input"));
    const input = $q<HTMLInputElement>(".palette-overlay .palette-input");
    input.value = "格式化文档";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(10);
    keydown(input, "Enter");
    await until(() => mock.messages.length === msgs + 1);
    expect(mock.messages.at(-1)).toMatchObject({ title: "格式化文档", kind: "info" });
    expect(mock.messages.at(-1)!.message).toContain("Markdown");
    expect(editorContent()).toBe(before);
  });
});