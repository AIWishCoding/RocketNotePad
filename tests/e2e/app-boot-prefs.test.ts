import { beforeAll, describe, expect, it } from "vitest";
import { demoFs, type TauriMock } from "../helpers/tauri-mock";
import {
  $id,
  $qa,
  bootApp,
  click,
  dblClickRow,
  editorContent,
  flush,
  globalKey,
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
const activeTab = (name: string) => tab(name)?.active === true;

async function editInsert(text: string): Promise<void> {
  viewFromDom().dispatch({ changes: { from: 0, insert: text } });
  await until(() => tabStates().some((t) => t.dirty));
}

/** 在命令面板里按标题执行一条命令 */
async function runCommand(query: string, title: string): Promise<void> {
  globalKey("p", { metaKey: true, shiftKey: true });
  await until(() => !!$qa(".palette-input")[0]);
  const input = $qa<HTMLInputElement>(".palette-input")[0];
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush(10);
  mouse(itemByTitle(title), "mousedown");
  await flush(20);
}

function itemByTitle(title: string): HTMLElement {
  const el = $qa(".palette-item").find((i) => (i.textContent ?? "").includes(title));
  if (!el) throw new Error(`面板缺少 "${title}"`);
  return el;
}

/**
 * 另一套保存的偏好：侧边栏、Minimap、预览、自动保存全部关闭，且没有待恢复的标签，
 * 用来验证“按偏好启动”的分支与退出确认流程。
 * 同时留下旧版 localStorage 的值，配置文件存在时它们必须被忽略。
 */
beforeAll(async () => {
  app = await bootApp({
    fs: demoFs(),
    recent: ["/demo/note.md", "/demo/Dockerfile"],
    storage: { "rnp.fontSize": "11", "rnp.theme": "dark" },
    config: {
      folders: ["/demo"],
      sidebarVisible: false,
      minimap: false,
      preview: false,
      autoSave: false,
      wrap: true,
      fontSize: 40,
      theme: "light",
      restoreTabs: [],
      restoreActive: ""
    }
  });
  mock = app.mock;
  await until(() => $qa("#welcome-recent .recent-item").length > 0);
});

describe("按保存的偏好启动", () => {
  it("侧边栏与 Minimap 按偏好隐藏，欢迎页展示最近打开", () => {
    expect($id("sidebar").classList.contains("hidden")).toBe(true);
    expect($id("minimap").style.display).toBe("none");
    expect($id("welcome").classList.contains("hidden")).toBe(false);
    expect($qa("#welcome-recent .recent-item").map((i) => i.textContent)).toEqual([
      "note.md",
      "Dockerfile"
    ]);
  });

  it("字号与换行偏好直接生效", () => {
    expect($id("st-zoom").textContent).toBe("缩放 40px");
    expect($id("st-wrap").textContent).toBe("自动换行: 开");
    expect($qa(".cm-content")[0].classList.contains("cm-lineWrapping")).toBe(true);
  });

  it("⌘\\ 重新显示侧边栏并写回配置文件", async () => {
    globalKey("\\", { metaKey: true });
    await until(() => !$id("sidebar").classList.contains("hidden"));
    await until(() => mock.configJson()?.sidebarVisible === true);
  });

  it("Minimap 命令恢复画布显示", async () => {
    mock.emit("menu-action", "view.minimap");
    await until(() => $id("minimap").style.display === "block");
    await until(() => mock.configJson()?.minimap === true);
  });
});

describe("预览与自动保存开关", () => {
  it("预览关闭时打开 Markdown 也不显示面板", async () => {
    click($qa("#welcome-recent .recent-item")[0]);
    await until(() => activeTab("note.md"));
    expect(editorContent()).toContain("标题");
    expect($id("preview-pane").classList.contains("hidden")).toBe(true);
    expect($id("editor-wrap").classList.contains("previewing")).toBe(false);
  });

  it("打开预览开关后面板立即渲染当前文档", async () => {
    await runCommand("Markdown 预览", "切换 Markdown 预览");
    await until(() => $id("preview-pane").classList.contains("hidden") === false);
    expect($id("editor-wrap").classList.contains("previewing")).toBe(true);
    await until(() => !!$id("preview-pane").querySelector("h1"));
    await until(() => mock.configJson()?.preview === true);
  });

  it("自动保存关闭时编辑只标记脏标签，不落盘", async () => {
    dblClickRow("a.cpp");
    await until(() => activeTab("a.cpp"));
    const writes = mock.invokeLog("write_text_file").length;
    await editInsert("// no autosave\n");
    window.dispatchEvent(new Event("blur"));
    await flush(120);
    expect(mock.invokeLog("write_text_file")).toHaveLength(writes);
    expect(tab("a.cpp")).toMatchObject({ dirty: true, preview: false });
  });

  it("开启自动保存后失去焦点会立刻冲刷到磁盘", async () => {
    await runCommand("自动保存", "文件: 自动保存（当前关闭）");
    await until(() => mock.configJson()?.autoSave === true);
    await editInsert("// please save\n");
    window.dispatchEvent(new Event("blur"));
    await until(() => mock.fs.content("/demo/a.cpp")!.includes("// please save"));
    await until(() => tab("a.cpp")?.dirty === false);
  });
});

describe("退出确认", () => {
  it("启动时注册窗口关闭事件监听", () => {
    expect(mock.listenerCount("tauri://close-requested")).toBe(1);
  });

  it("没有脏标签时直接退出并保存偏好", async () => {
    // 上一个用例已把 a.cpp 写盘，此时全部标签干净
    expect(tabStates().some((t) => t.dirty)).toBe(false);
    mock.resetInvokeLog();
    mock.emit("tauri://close-requested", {});
    await until(() => !!mock.lastCall("plugin:window|destroy"));
    expect(mock.dialogs.ask).toEqual([]);
    expect(mock.configJson()?.restoreTabs).toEqual(["/demo/note.md", "/demo/a.cpp"]);
  });

  it("脏标签选择“保存并退出”时先落盘再销毁窗口", async () => {
    dblClickRow("B.ts");
    await until(() => activeTab("B.ts"));
    await editInsert("const z = 3;\n");
    mock.resetInvokeLog();
    mock.dialogs.ask.length = 0;
    mock.dialogs.ask.push(true); // 保存并退出
    mock.emit("tauri://close-requested", {});
    await until(() => !!mock.lastCall("plugin:window|destroy"));
    expect(mock.lastCall("write_text_file")?.args.path).toBe("/demo/B.ts");
    expect(mock.fs.content("/demo/B.ts")).toContain("const z = 3;");
  });

  it("两次询问都取消时阻止关闭窗口", async () => {
    // 退出前会先冲刷自动保存，所以这里关掉开关才能保证标签仍是脏的
    await runCommand("自动保存", "文件: 自动保存（当前开启）");
    await until(() => mock.configJson()?.autoSave === false);
    await editInsert("// keep me\n");
    mock.resetInvokeLog();
    mock.dialogs.ask.length = 0;
    mock.dialogs.ask.push(false, false); // 不保存 → 取消
    mock.emit("tauri://close-requested", {});
    await flush(60);
    expect(mock.lastCall("plugin:window|destroy")).toBeUndefined();
    expect(tab("B.ts")).toMatchObject({ active: true, dirty: true });
  });
});
