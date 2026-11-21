import { afterEach, describe, expect, it, vi } from "vitest";
import { NEW_DIR_BASE, NEW_FILE_BASE, Sidebar, numberedName } from "../../src/sidebar";
import { cfg } from "../../src/config";
import { demoFs, installTauriMock, type TauriMock, type TauriMockOptions } from "../helpers/tauri-mock";
import {
  $q,
  $qa,
  click,
  dblClick,
  findRow,
  flush,
  globalKey,
  mouse,
  treeRows,
  until,
  visibleTreeNames
} from "../helpers/dom";

const SHELL = `
  <div id="sidebar">
    <div class="sidebar-header">
      <span>资源管理器</span>
      <span class="tb-spacer"></span>
      <button id="sidebar-add" title="打开文件夹"></button>
      <button id="sidebar-newfile" title="新建文件"></button>
      <button id="sidebar-newfolder" title="新建文件夹"></button>
      <button id="sidebar-refresh" title="刷新"></button>
      <button id="sidebar-collapse" title="折叠全部"></button>
    </div>
    <div id="sidebar-tree"></div>
  </div>`;

interface Mounted {
  sb: Sidebar;
  mock: TauriMock;
  opened: Array<{ path: string; preview: boolean }>;
  created: string[];
  renamed: Array<[string, string]>;
  deleted: string[];
  closed: string[];
  addFolder: () => number;
}

let currentMock: TauriMock | undefined;

const ROOT_CHILDREN = ["demo", "alpha", "Zeta", "a.cpp", "B.ts", "config.json", "Dockerfile", "note.md"];

async function mount(options: TauriMockOptions & { folders?: string[] } = {}): Promise<Mounted> {
  document.body.innerHTML = SHELL;
  localStorage.clear();
  cfg.folders = [...(options.folders ?? ["/demo"])];
  const mock = installTauriMock({ fs: demoFs(), ...options });
  currentMock = mock;
  const opened: Array<{ path: string; preview: boolean }> = [];
  const created: string[] = [];
  const renamed: Array<[string, string]> = [];
  const deleted: string[] = [];
  const closed: string[] = [];
  let addCount = 0;
  const sb = new Sidebar(
    $q("#sidebar"),
    $q("#sidebar-tree"),
    (path, preview) => opened.push({ path, preview }),
    () => addCount++,
    {
      onCreated: (p) => created.push(p),
      onRenamed: (from, to) => renamed.push([from, to]),
      onDeleted: (p) => deleted.push(p),
      onCloseFolder: (d) => closed.push(d)
    }
  );
  // 与真实操作一致：先按住在侧边栏内，键盘命令才会生效
  mouse($q("#sidebar-tree"), "mousedown");
  await until(() => treeRows().length > 0 || !!document.querySelector(".sidebar-empty"));
  return { sb, mock, opened, created, renamed, deleted, closed, addFolder: () => addCount };
}

const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>(".tree-input")!;

function typeInto(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function keyOf(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }));
}

function ctxLabels(): string[] {
  return $qa(".ctx-item span:first-child").map((s) => s.textContent ?? "");
}

function ctxItem(label: string): HTMLElement {
  const all = $qa(".ctx-item");
  const el = all.find((i) => i.querySelector("span")?.textContent === label);
  if (!el) {
    throw new Error(`右键菜单缺少 "${label}"，现有: ${all.map((i) => i.textContent).join(" | ") || "空"}`);
  }
  return el;
}

function openCtx(name: string) {
  mouse(findRow(name), "contextmenu");
}

function selectedLabel(): string {
  return document.querySelector(".tree-row.selected .tree-label")?.textContent ?? "";
}

async function startCreate(buttonId: string) {
  click($q(buttonId));
  await until(() => !!document.querySelector(".tree-input"));
}

async function commitCreate(value: string) {
  typeInto(input(), value);
  keyOf(input(), "Enter");
  await flush(20);
}

async function startRename(name: string, key = "F2") {
  click(findRow(name));
  keyOf(document, key);
  await until(() => !!document.querySelector(".tree-input"));
}

afterEach(() => {
  // 目标不在任何侧边栏内，会让上一个实例的全局 keydown/mousedown 监听器失效
  document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.body.innerHTML = "";
  currentMock?.uninstall();
  currentMock = undefined;
  vi.restoreAllMocks();
});

describe("目录树渲染", () => {
  it("根目录默认展开，目录在前且忽略大小写排序", async () => {
    await mount();
    expect(visibleTreeNames()).toEqual(ROOT_CHILDREN);
    expect(findRow("demo").className).toContain("tree-root");
  });

  it("用 --d 记录层级，展开的目录有开口图标与箭头", async () => {
    await mount();
    click(findRow("alpha"));
    expect(findRow("demo").style.getPropertyValue("--d")).toBe("0");
    expect(findRow("alpha").style.getPropertyValue("--d")).toBe("1");
    expect(findRow("one.md").style.getPropertyValue("--d")).toBe("2");
    expect(findRow("alpha").querySelector(".tree-caret")!.className).toContain("open");
    const icon = findRow("alpha").querySelector(".tree-icon")!;
    expect(icon.className).toContain("tree-icon-dir");
    expect(icon.className).toContain("open");
    expect(icon.innerHTML).toContain("svg");
  });

  it("文件节点没有折叠箭头，鼠标悬停提示完整路径", async () => {
    await mount();
    const caret = findRow("note.md").querySelector(".tree-caret")!;
    expect(caret.innerHTML).toBe("");
    expect(caret.className).not.toContain("open");
    expect(findRow("note.md").querySelector<HTMLElement>(".tree-label")!.title).toBe("/demo/note.md");
  });

  it("隐藏文件、隐藏目录与二进制文件不进树", async () => {
    await mount({
      fs: {
        "/demo": null,
        "/demo/note.md": "x",
        "/demo/.env": "SECRET=1",
        "/demo/.git/config": "x",
        "/demo/logo.png": "binary"
      }
    });
    expect(visibleTreeNames()).toEqual(["demo", "note.md"]);
  });

  it("没有文件夹时显示中文空态", async () => {
    await mount({ folders: [] });
    expect(treeRows().length).toBe(0);
    expect($q(".sidebar-empty").textContent).toContain("没有打开的文件夹");
  });

  it("文件夹读取失败时自动移出列表", async () => {
    const { mock } = await mount();
    mock.resetInvokeLog();
    mock.fail("list_folder_tree", "路径不存在");
    click($q("#sidebar-refresh"));
    await until(() => !!document.querySelector(".sidebar-empty"));
    expect([...cfg.folders]).toEqual([]);
  });
});

describe("打开文件的预览与固定", () => {
  it("单击文件按预览打开，双击固定打开", async () => {
    const { opened } = await mount();
    click(findRow("note.md"));
    expect(opened).toEqual([{ path: "/demo/note.md", preview: true }]);
    dblClick(findRow("note.md"));
    expect(opened[1]).toEqual({ path: "/demo/note.md", preview: false });
  });

  it("单击目录只展开折叠，不会打开文件", async () => {
    const { opened } = await mount();
    click(findRow("alpha"));
    expect(opened.length).toBe(0);
    expect(visibleTreeNames()).toContain("one.md");
    click(findRow("alpha"));
    expect(visibleTreeNames()).not.toContain("one.md");
  });

  it("同一时刻只有一个选中行", async () => {
    await mount();
    click(findRow("note.md"));
    expect(findRow("note.md").classList.contains("selected")).toBe(true);
    click(findRow("a.cpp"));
    expect($qa(".tree-row.selected").length).toBe(1);
    expect(selectedLabel()).toBe("a.cpp");
  });

  it("扁平文件列表供跳转面板使用", async () => {
    const { sb } = await mount();
    expect(sb.flatFiles().map((f) => f.name).sort()).toEqual(
      ["B.ts", "Dockerfile", "Two.TXT", "a.cpp", "config.json", "note.md", "one.md", "readme.md"].sort()
    );
  });
});

describe("键盘导航", () => {
  it("上下方向键在可见行之间移动选择并在两端停住", async () => {
    await mount();
    click(findRow("a.cpp"));
    globalKey("ArrowDown");
    expect(selectedLabel()).toBe("B.ts");
    globalKey("ArrowUp");
    expect(selectedLabel()).toBe("a.cpp");
    globalKey("ArrowUp");
    expect(selectedLabel()).toBe("Zeta");
    for (let i = 0; i < 20; i++) globalKey("ArrowDown");
    expect(selectedLabel()).toBe("note.md");
  });

  it("右方向键先展开目录再进入第一个子项", async () => {
    const { opened } = await mount();
    click(findRow("Zeta"));
    globalKey("ArrowRight");
    expect(visibleTreeNames()).toContain("readme.md");
    globalKey("ArrowRight");
    expect(selectedLabel()).toBe("readme.md");
    globalKey("Enter");
    expect(opened[opened.length - 1]).toEqual({ path: "/demo/Zeta/readme.md", preview: false });
  });

  it("文件节点上按右方向键不展开", async () => {
    await mount();
    click(findRow("note.md"));
    globalKey("ArrowRight");
    expect(selectedLabel()).toBe("note.md");
  });

  it("左方向键先回到子项所在目录，再折叠，再回到父级", async () => {
    await mount();
    click(findRow("alpha"));
    click(findRow("one.md"));
    globalKey("ArrowLeft");
    expect(selectedLabel()).toBe("alpha");
    globalKey("ArrowLeft");
    expect(visibleTreeNames()).not.toContain("one.md");
    globalKey("ArrowLeft");
    expect(selectedLabel()).toBe("demo");
    globalKey("ArrowLeft");
    expect(selectedLabel()).toBe("demo");
  });

  it("回车在文件上固定打开，在目录上切换展开", async () => {
    const { opened } = await mount();
    click(findRow("B.ts"));
    globalKey("Enter");
    expect(opened[opened.length - 1]).toEqual({ path: "/demo/B.ts", preview: false });
    click(findRow("alpha"));
    expect(visibleTreeNames()).toContain("one.md");
    globalKey("Enter");
    expect(visibleTreeNames()).not.toContain("one.md");
  });

  it("焦点在输入类元素时侧边栏不劫持按键", async () => {
    await mount();
    const host = document.createElement("textarea");
    document.body.appendChild(host);
    host.focus();
    click(findRow("note.md"));
    globalKey("ArrowDown");
    expect(selectedLabel()).toBe("note.md");
  });

  it("折叠全部按钮收起所有目录，只留根节点", async () => {
    await mount();
    click(findRow("alpha"));
    expect(visibleTreeNames()).toContain("one.md");
    click($q("#sidebar-collapse"));
    expect(visibleTreeNames()).toEqual(["demo"]);
  });

  it("折叠后按钮变为「展开全部」，再点恢复目录树", async () => {
    await mount();
    const btn = $q<HTMLElement>("#sidebar-collapse");
    expect(btn.title).toBe("折叠全部");
    click(findRow("alpha"));
    click(btn);
    expect(btn.title).toBe("展开全部");
    expect(btn.innerHTML).toContain("M3.5 2.5 8 6.5l4.5-4");
    click(btn);
    expect(btn.title).toBe("折叠全部");
    expect(btn.innerHTML).toContain("M3.5 6.5 8 2.5l4.5 4");
    expect(visibleTreeNames()).toContain("one.md");
    expect(visibleTreeNames()).toContain("readme.md");
  });

  it("目录为空时按钮停在「展开全部」", async () => {
    await mount({ folders: [] });
    expect($q<HTMLElement>("#sidebar-collapse").title).toBe("展开全部");
  });

  it("focusFile 展开目标文件的各级目录并选中它", async () => {
    const { sb } = await mount();
    expect(visibleTreeNames()).not.toContain("one.md");
    await sb.focusFile("/demo/alpha/one.md");
    expect(visibleTreeNames()).toContain("one.md");
    expect(selectedLabel()).toBe("one.md");
  });

  it("focusFile 对不属于任何已打开文件夹的路径不动作", async () => {
    const { sb } = await mount();
    await sb.focusFile("/elsewhere/x.md");
    expect(selectedLabel()).toBe("");
  });

  it("刷新按钮重新拉取目录树", async () => {
    const { mock } = await mount();
    mock.resetInvokeLog();
    click($q("#sidebar-refresh"));
    await flush(20);
    expect(mock.invokeLog("list_folder_tree").length).toBe(1);
  });

  it("打开文件夹按钮回调生效", async () => {
    const { addFolder } = await mount();
    click($q("#sidebar-add"));
    expect(addFolder()).toBe(1);
  });
});

describe("内联新建", () => {
  it("工具栏新建文件写入磁盘并回调", async () => {
    const { mock, created } = await mount();
    click(findRow("alpha"));
    await startCreate("#sidebar-newfile");
    await commitCreate("新文件.md");
    expect(mock.lastCall("create_file")?.args.path).toBe("/demo/alpha/新文件.md");
    expect(mock.fs.content("/demo/alpha/新文件.md")).toBe("");
    expect(created).toEqual(["/demo/alpha/新文件.md"]);
    expect(selectedLabel()).toBe("新文件.md");
  });

  it("没有文件夹时新建按钮转为打开文件夹", async () => {
    const { addFolder } = await mount({ folders: [] });
    click($q("#sidebar-newfile"));
    expect(addFolder()).toBe(1);
    click($q("#sidebar-newfolder"));
    expect(addFolder()).toBe(2);
  });

  it("新建文件夹后自动展开", async () => {
    const { mock } = await mount();
    click(findRow("alpha"));
    await startCreate("#sidebar-newfolder");
    await commitCreate("sub");
    expect(mock.lastCall("create_dir")?.args.path).toBe("/demo/alpha/sub");
    expect(visibleTreeNames()).toContain("sub");
    expect(findRow("sub").querySelector(".tree-caret")!.className).toContain("open");
  });

  it("名称为空时取消新建", async () => {
    const { mock } = await mount();
    await startCreate("#sidebar-newfile");
    typeInto(input(), "");
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.invokeLog("create_file").length).toBe(0);
    expect(document.querySelector(".tree-input")).toBeNull();
  });

  it("新建名称含反斜杠时报错且不落盘", async () => {
    const { mock } = await mount();
    click(findRow("alpha"));
    await startCreate("#sidebar-newfile");
    await commitCreate("a\\b.md");
    const call = mock.lastCall("plugin:dialog|message");
    expect(call?.args.message).toBe("名称不能包含路径分隔符");
    expect(call?.args.title).toBe("名称无效");
    expect(mock.invokeLog("create_file").length).toBe(0);
  });

  it("重命名名称含斜杠或反斜杠时报错且不落盘", async () => {
    for (const bad of ["a/b.md", "a\\b.md"]) {
      const { mock, renamed } = await mount();
      await startRename("note.md");
      typeInto(input(), bad);
      keyOf(input(), "Enter");
      await flush(20);
      const call = mock.lastCall("plugin:dialog|message");
      expect(call?.args.message).toBe("名称不能包含路径分隔符");
      expect(call?.args.title).toBe("名称无效");
      expect(mock.invokeLog("rename_path").length).toBe(0);
      expect(renamed).toEqual([]);
      mock.uninstall();
    }
  });

  it("新建时正斜杠按嵌套路径落盘（与后端自动建父目录一致）", async () => {
    const { mock, created } = await mount();
    click(findRow("demo"));
    await startCreate("#sidebar-newfile");
    await commitCreate("nested/deep.md");
    expect(mock.lastCall("create_file")?.args.path).toBe("/demo/nested/deep.md");
    expect(created).toEqual(["/demo/nested/deep.md"]);
  });

  it("Esc 取消输入框", async () => {
    const { mock } = await mount();
    await startCreate("#sidebar-newfile");
    typeInto(input(), "tmp.md");
    keyOf(input(), "Escape");
    await flush(20);
    expect(document.querySelector(".tree-input")).toBeNull();
    expect(mock.invokeLog("create_file").length).toBe(0);
  });

  it("失焦即提交，重命名只选中主名", async () => {
    const { mock, renamed } = await mount();
    await startRename("note.md");
    expect(input().value).toBe("note.md");
    await until(() => document.activeElement === input());
    expect(input().selectionEnd).toBe(4);
    typeInto(input(), "改名.md");
    input().dispatchEvent(new FocusEvent("blur"));
    await flush(20);
    expect(mock.lastCall("rename_path")?.args).toEqual({ from: "/demo/note.md", to: "/demo/改名.md" });
    expect(renamed).toEqual([["/demo/note.md", "/demo/改名.md"]]);
    expect(visibleTreeNames()).toContain("改名.md");
  });

  it("重命名未改变名称时不调用后端", async () => {
    const { mock } = await mount();
    await startRename("note.md");
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.invokeLog("rename_path").length).toBe(0);
    expect(document.querySelector(".tree-input")).toBeNull();
  });

  it("重命名时点击名称输入框不会立即提交，仍可继续编辑", async () => {
    const { mock, renamed } = await mount();
    await startRename("note.md");
    await until(() => document.activeElement === input());
    // 点击输入框（用户想把光标点到名称中间）：不应被行 click 抢焦点触发 blur 提交
    click(input());
    await flush(20);
    expect(document.querySelector(".tree-input")).not.toBeNull();
    expect(document.activeElement).toBe(input());
    expect(mock.invokeLog("rename_path").length).toBe(0);
    expect(renamed).toEqual([]);
    // 仍能改写并提交
    typeInto(input(), "改名.md");
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.lastCall("rename_path")?.args).toEqual({ from: "/demo/note.md", to: "/demo/改名.md" });
    expect(renamed).toEqual([["/demo/note.md", "/demo/改名.md"]]);
  });

  it("重命名时双击名称输入框选词不会打开文件或提交", async () => {
    const { mock, opened } = await mount();
    await startRename("note.md");
    await until(() => document.activeElement === input());
    const openedBefore = opened.length;
    dblClick(input());
    await flush(20);
    expect(document.querySelector(".tree-input")).not.toBeNull();
    expect(opened.length).toBe(openedBefore);
    expect(mock.invokeLog("rename_path").length).toBe(0);
  });

  it("重命名目录后展开状态随新路径迁移", async () => {
    const { mock } = await mount();
    click(findRow("alpha"));
    expect(visibleTreeNames()).toContain("one.md");
    await startRename("alpha");
    await commitCreate("alpha2");
    expect(mock.lastCall("rename_path")?.args.to).toBe("/demo/alpha2");
    expect(visibleTreeNames()).toContain("alpha2");
    expect(visibleTreeNames()).toContain("one.md");
    expect(findRow("alpha2").querySelector(".tree-caret")!.className).toContain("open");
  });

  it("目标已存在时提示新建失败", async () => {
    const { mock } = await mount();
    click(findRow("alpha"));
    await startCreate("#sidebar-newfile");
    await commitCreate("one.md");
    const call = mock.lastCall("plugin:dialog|message");
    expect(call?.args.title).toBe("新建失败");
    expect(String(call?.args.message)).toBe("目标已存在");
  });
});

describe("内联新建自动命名", () => {
  it("编号规则：首项不带编号，文件编号在扩展名前，目录直接追加", () => {
    expect(numberedName("新建文件.txt", 1)).toBe("新建文件.txt");
    expect(numberedName("新建文件.txt", 2)).toBe("新建文件 2.txt");
    expect(numberedName("新建文件.txt", 10)).toBe("新建文件 10.txt");
    expect(numberedName("新建文件夹", 1)).toBe("新建文件夹");
    expect(numberedName("新建文件夹", 3)).toBe("新建文件夹 3");
    expect(numberedName("archive.tar.gz", 2)).toBe("archive.tar 2.gz");
    expect(numberedName(".gitignore", 2)).toBe(".gitignore 2");
  });

  it("打开输入框就填好默认名，并选中主名便于直接改写", async () => {
    const { mock } = await mount();
    await startCreate("#sidebar-newfile");
    expect(input().value).toBe(NEW_FILE_BASE);
    await until(() => document.activeElement === input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe("新建文件".length);
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.lastCall("create_file")?.args.path).toBe(`/demo/${NEW_FILE_BASE}`);
  });

  it("连续新建文件按递增编号命名，编号插在扩展名之前", async () => {
    const { mock } = await mount();
    await startCreate("#sidebar-newfile");
    keyOf(input(), "Enter");
    await flush(20);
    await startCreate("#sidebar-newfile");
    expect(input().value).toBe("新建文件 2.txt");
    keyOf(input(), "Enter");
    await flush(20);
    await startCreate("#sidebar-newfile");
    expect(input().value).toBe("新建文件 3.txt");
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.invokeLog("create_file").map((c) => c.args.path)).toEqual([
      "/demo/新建文件.txt",
      "/demo/新建文件 2.txt",
      "/demo/新建文件 3.txt"
    ]);
  });

  it("连续新建文件夹按递增编号命名", async () => {
    const { mock } = await mount();
    await startCreate("#sidebar-newfolder");
    expect(input().value).toBe(NEW_DIR_BASE);
    keyOf(input(), "Enter");
    await flush(20);
    click(findRow("demo"));
    await startCreate("#sidebar-newfolder");
    expect(input().value).toBe("新建文件夹 2");
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.invokeLog("create_dir").map((c) => c.args.path)).toEqual([
      "/demo/新建文件夹",
      "/demo/新建文件夹 2"
    ]);
  });

  it("默认名被占用（含树里不列的项）时跳到下一个空编号", async () => {
    const { mock } = await mount();
    mock.fs.set("/demo/新建文件.txt", "");
    mock.fs.set("/demo/新建文件 2.txt", "");
    mock.fs.setDir("/demo/新建文件夹");
    await startCreate("#sidebar-newfile");
    expect(input().value).toBe("新建文件 3.txt");
    keyOf(input(), "Escape");
    await flush(20);
    await startCreate("#sidebar-newfolder");
    expect(input().value).toBe("新建文件夹 2");
  });

  it("自动名只是预填，手动改名后仍按输入落盘", async () => {
    const { mock, created } = await mount();
    await startCreate("#sidebar-newfile");
    await commitCreate("自定义.md");
    expect(mock.lastCall("create_file")?.args.path).toBe("/demo/自定义.md");
    expect(created).toEqual(["/demo/自定义.md"]);
  });
});

describe("新建默认位置", () => {
  it("无手动选中时落在第一个文件夹根，不跟随启动恢复的深层高亮", async () => {
    const { sb, mock } = await mount();
    await sb.focusFile("/demo/alpha/one.md");
    expect(selectedLabel()).toBe("one.md");
    await startCreate("#sidebar-newfile");
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.lastCall("create_file")?.args.path).toBe("/demo/新建文件.txt");
  });

  it("手动点选深层文件后，新建落在该文件所在目录", async () => {
    const { mock } = await mount();
    click(findRow("alpha"));
    await flush(10);
    click(findRow("one.md"));
    await flush(10);
    await startCreate("#sidebar-newfile");
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.lastCall("create_file")?.args.path).toBe("/demo/alpha/新建文件.txt");
  });

  it("手动选中的目录被删后回退到根，而不是悬空路径", async () => {
    const { sb, mock } = await mount();
    click(findRow("alpha"));
    await flush(10);
    for (const p of [...mock.fs.entries.keys()]) {
      if (p === "/demo/alpha" || p.startsWith("/demo/alpha/")) mock.fs.entries.delete(p);
    }
    await sb.refresh();
    await startCreate("#sidebar-newfile");
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.lastCall("create_file")?.args.path).toBe("/demo/新建文件.txt");
  });
});

describe("删除", () => {
  it("Delete 确认后移入回收站并回调", async () => {
    const { mock, deleted } = await mount();
    click(findRow("config.json"));
    globalKey("Delete");
    await flush(20);
    expect(mock.lastCall("plugin:dialog|message")?.args.message).toContain('确定删除 "config.json"');
    expect(mock.lastCall("delete_path")?.args.path).toBe("/demo/config.json");
    expect(deleted).toEqual(["/demo/config.json"]);
    expect(visibleTreeNames()).not.toContain("config.json");
  });

  it("取消确认时不删除", async () => {
    const { mock, deleted } = await mount({ dialogs: { ask: [false] } });
    click(findRow("config.json"));
    globalKey("Delete");
    await flush(20);
    expect(mock.invokeLog("delete_path").length).toBe(0);
    expect(deleted.length).toBe(0);
    expect(visibleTreeNames()).toContain("config.json");
  });

  it("删除失败提示中文标题", async () => {
    const { mock } = await mount();
    click(findRow("note.md"));
    mock.fs.removeTree("/demo/note.md");
    globalKey("Backspace");
    await flush(20);
    const call = mock.lastCall("plugin:dialog|message");
    expect(call?.args.title).toBe("删除失败");
  });

  it("根节点上按删除键不会删除整个文件夹", async () => {
    const { mock } = await mount();
    click(findRow("demo"));
    globalKey("Delete");
    await flush(20);
    expect(mock.invokeLog("delete_path").length).toBe(0);
    expect(treeRows().length).toBeGreaterThan(0);
  });
});

describe("右键菜单", () => {
  it("目录菜单以新建项开头，文件菜单含重命名与删除", async () => {
    await mount();
    openCtx("alpha");
    expect(ctxLabels().slice(0, 2)).toEqual(["新建文件…", "新建文件夹…"]);
    expect(ctxLabels()).not.toContain("关闭文件夹");
    expect(ctxLabels()).toContain("刷新");

    openCtx("note.md");
    const labels = ctxLabels();
    expect(labels).toEqual(expect.arrayContaining(["剪切", "复制", "粘贴", "复制路径", "复制相对路径", "刷新", "重命名…", "删除"]));
    expect(labels.length).toBe(9);
    expect(labels.filter((l) => /中显示$/.test(l))).toHaveLength(1);
    expect(labels[labels.length - 1]).toBe("删除");
    expect(labels[labels.length - 2]).toBe("重命名…");
    expect($qa(".ctx-danger").length).toBe(1);
    expect($q(".ctx-sep")).toBeTruthy();
  });

  it("文件/目录行右键的刷新与顶部按钮一致：重新拉取目录树", async () => {
    const { mock } = await mount();
    for (const name of ["note.md", "alpha"]) {
      mock.resetInvokeLog();
      openCtx(name);
      click(ctxItem("刷新"));
      await flush(20);
      expect(mock.invokeLog("list_folder_tree").length).toBe(1);
      expect(document.querySelector(".ctx-menu")).toBeNull();
    }
  });

  it("菜单项带快捷键提示", async () => {
    await mount();
    openCtx("note.md");
    const hints = Object.fromEntries(
      $qa(".ctx-item").map((i) => [i.querySelector("span:first-child")!.textContent ?? "", i.querySelector(".ctx-hint")?.textContent ?? ""])
    );
    expect(hints["剪切"]).toMatch(/^(⌘|Ctrl\+)X$/);
    expect(hints["复制"]).toMatch(/^(⌘|Ctrl\+)C$/);
    expect(hints["粘贴"]).toMatch(/^(⌘|Ctrl\+)V$/);
    expect(hints["重命名…"]).toBe("F2");
    expect(hints["删除"]).toMatch(/^(⌘⌫|Delete)$/);
  });

  it("根节点菜单可关闭文件夹并持久化", async () => {
    const { closed } = await mount({
      folders: ["/demo", "/other"],
      fs: { "/demo": null, "/demo/a.md": "x", "/other": null, "/other/b.md": "y" }
    });
    expect($qa(".tree-root").length).toBe(2);
    openCtx("other");
    click(ctxItem("关闭文件夹"));
    await flush(20);
    expect([...cfg.folders]).toEqual(["/demo"]);
    expect(visibleTreeNames()).not.toContain("other");
    expect(closed).toEqual(["/other"]);
  });

  it("点击菜单项后菜单关闭", async () => {
    await mount();
    openCtx("alpha");
    click(ctxItem("新建文件…"));
    expect(document.querySelector(".ctx-menu")).toBeNull();
    await until(() => !!document.querySelector(".tree-input"));
  });

  it("点击菜单外或 Esc 关闭菜单", async () => {
    await mount();
    openCtx("note.md");
    keyOf(document, "Escape");
    expect(document.querySelector(".ctx-menu")).toBeNull();
    openCtx("note.md");
    click(document.body);
    expect(document.querySelector(".ctx-menu")).toBeNull();
  });

  it("重复右键只保留一个菜单", async () => {
    await mount();
    openCtx("note.md");
    openCtx("a.cpp");
    expect($qa(".ctx-menu").length).toBe(1);
  });

  it("未复制时粘贴项禁用且点击不产生后端调用", async () => {
    const { mock } = await mount();
    openCtx("alpha");
    const paste = ctxItem("粘贴");
    expect(paste.className).toContain("disabled");
    click(paste);
    expect(document.querySelector(".ctx-menu")).toBeNull();
    expect(mock.invokeLog("copy_path").length).toBe(0);
    expect(mock.invokeLog("rename_path").length).toBe(0);
  });
});

describe("空白区右键菜单", () => {
  function openBlankCtx() {
    mouse($q("#sidebar-tree"), "contextmenu", { clientX: 40, clientY: 320 });
  }

  it("空白区右键弹出新建文件夹、新建文件与刷新，顺序与工具栏一致", async () => {
    await mount();
    openBlankCtx();
    expect(ctxLabels()).toEqual(["新建文件夹…", "新建文件…", "刷新"]);
    expect($qa(".ctx-menu").length).toBe(1);
  });

  it("空白区刷新与顶部按钮一致：重新拉取目录树并关闭菜单", async () => {
    const { mock } = await mount();
    mock.resetInvokeLog();
    openBlankCtx();
    click(ctxItem("刷新"));
    await flush(20);
    expect(mock.invokeLog("list_folder_tree").length).toBe(1);
    expect(document.querySelector(".ctx-menu")).toBeNull();
  });

  it("空白区新建文件与顶部按钮落点一致：无手动选中时落在根", async () => {
    const { sb, mock } = await mount();
    await sb.focusFile("/demo/alpha/one.md");
    expect(selectedLabel()).toBe("one.md");
    openBlankCtx();
    click(ctxItem("新建文件…"));
    await until(() => !!document.querySelector(".tree-input"));
    expect(input().value).toBe(NEW_FILE_BASE);
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.lastCall("create_file")?.args.path).toBe("/demo/新建文件.txt");
  });

  it("空白区新建文件夹同样落在根并自动命名", async () => {
    const { mock } = await mount();
    openBlankCtx();
    click(ctxItem("新建文件夹…"));
    await until(() => !!document.querySelector(".tree-input"));
    expect(input().value).toBe(NEW_DIR_BASE);
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.lastCall("create_dir")?.args.path).toBe("/demo/新建文件夹");
  });

  it("手动选中目录后，空白区新建落在该目录（与按钮一致）", async () => {
    const { mock } = await mount();
    click(findRow("alpha"));
    await flush(10);
    openBlankCtx();
    click(ctxItem("新建文件…"));
    await until(() => !!document.querySelector(".tree-input"));
    keyOf(input(), "Enter");
    await flush(20);
    expect(mock.lastCall("create_file")?.args.path).toBe("/demo/alpha/新建文件.txt");
  });

  it("在行上右键仍是节点菜单，不会冒泡成空白菜单", async () => {
    await mount();
    openCtx("alpha");
    expect(ctxLabels().slice(0, 2)).toEqual(["新建文件…", "新建文件夹…"]);
    expect(ctxLabels()).toContain("粘贴");
    expect($qa(".ctx-menu").length).toBe(1);
  });

  it("没有文件夹时空白区新建转为打开文件夹（与按钮一致）", async () => {
    const { addFolder } = await mount({ folders: [] });
    openBlankCtx();
    click(ctxItem("新建文件…"));
    expect(addFolder()).toBe(1);
    openBlankCtx();
    click(ctxItem("新建文件夹…"));
    expect(addFolder()).toBe(2);
  });

  it("空白菜单点击后关闭，Esc 也能关闭", async () => {
    await mount();
    openBlankCtx();
    expect($q(".ctx-menu")).toBeTruthy();
    keyOf(document, "Escape");
    expect(document.querySelector(".ctx-menu")).toBeNull();
    openBlankCtx();
    click(ctxItem("新建文件夹…"));
    expect(document.querySelector(".ctx-menu")).toBeNull();
    await until(() => !!document.querySelector(".tree-input"));
  });
});

describe("剪贴板与拖拽", () => {
  it("复制后粘贴同名文件自动改名避让", async () => {
    const { mock } = await mount({ fs: { "/demo/note.md": "内容", "/demo/note.md.bak": "无关" } });
    click(findRow("note.md"));
    keyOf(document, "c", { metaKey: true });
    openCtx("note.md");
    click(ctxItem("粘贴"));
    await flush(30);
    const call = mock.lastCall("copy_path");
    expect(call?.args.from).toBe("/demo/note.md");
    expect(String(call?.args.to)).toMatch(/^\/demo\/note copy(\. \d+)?\.md$/);
    expect(mock.fs.content(String(call?.args.to))).toBe("内容");
  });

  it("剪切后粘贴是移动，剪贴板随即清空", async () => {
    const { mock, renamed } = await mount();
    click(findRow("note.md"));
    keyOf(document, "x", { metaKey: true });
    expect(findRow("note.md").classList.contains("cut")).toBe(true);
    click(findRow("alpha"));
    keyOf(document, "v", { metaKey: true });
    await flush(30);
    expect(mock.lastCall("rename_path")?.args).toEqual({ from: "/demo/note.md", to: "/demo/alpha/note.md" });
    expect(renamed).toEqual([["/demo/note.md", "/demo/alpha/note.md"]]);
    openCtx("alpha");
    expect(ctxItem("粘贴").className).toContain("disabled");
  });

  it("不能把文件夹粘贴到自身内部", async () => {
    const { mock } = await mount();
    click(findRow("alpha"));
    keyOf(document, "c", { metaKey: true });
    keyOf(document, "v", { metaKey: true });
    await flush(30);
    expect(mock.lastCall("plugin:dialog|message")?.args.message).toBe("不能将项目粘贴到其自身内部");
    expect(mock.invokeLog("copy_path").length).toBe(0);
  });

  it("复制路径与相对路径写入系统剪贴板", async () => {
    const { mock } = await mount();
    click(findRow("alpha"));
    click(findRow("one.md"));
    openCtx("one.md");
    click(ctxItem("复制相对路径"));
    await flush(10);
    expect(mock.lastCall("plugin:clipboard-manager|write_text")?.args.text).toBe("alpha/one.md");
    openCtx("one.md");
    click(ctxItem("复制路径"));
    await flush(10);
    expect(mock.lastCall("plugin:clipboard-manager|write_text")?.args.text).toBe("/demo/alpha/one.md");
  });

  it("在文件管理器中显示调用后端命令", async () => {
    const { mock } = await mount();
    click(findRow("note.md"));
    openCtx("note.md");
    const reveal = $qa(".ctx-item").find((i) => /中显示$/.test(i.querySelector("span")?.textContent ?? ""));
    click(reveal!);
    await flush(10);
    expect(mock.lastCall("reveal_in_file_manager")?.args.path).toBe("/demo/note.md");
  });

  function dragBag() {
    const store = new Map<string, string>();
    return {
      effectAllowed: "",
      dropEffect: "",
      setData: (t: string, v: string) => store.set(t, v),
      getData: (t: string) => store.get(t) ?? "",
      store
    };
  }

  function fireDrag(el: Element, type: string, dt?: ReturnType<typeof dragBag>) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    el.dispatchEvent(ev);
    return ev;
  }

  it("拖到其它目录时高亮并确认后移动", async () => {
    const { mock, renamed } = await mount();
    const dt = dragBag();
    fireDrag(findRow("note.md"), "dragstart", dt);
    expect(dt.store.get("application/x-rnp-path")).toBe("/demo/note.md");
    const over = fireDrag(findRow("alpha"), "dragover", dt);
    expect(findRow("alpha").classList.contains("drag-over")).toBe(true);
    expect(over.defaultPrevented).toBe(true);
    fireDrag(findRow("alpha"), "drop", dt);
    await flush(30);
    expect(mock.lastCall("rename_path")?.args).toEqual({ from: "/demo/note.md", to: "/demo/alpha/note.md" });
    expect(renamed.length).toBe(1);
    expect(findRow("alpha").classList.contains("drag-over")).toBe(false);
  });

  it("拖回原目录不产生移动", async () => {
    const { mock } = await mount();
    const dt = dragBag();
    fireDrag(findRow("note.md"), "dragstart", dt);
    const over = fireDrag(findRow("demo"), "dragover", dt);
    expect(over.defaultPrevented).toBe(false);
    fireDrag(findRow("demo"), "drop", dt);
    await flush(30);
    expect(mock.invokeLog("rename_path").length).toBe(0);
  });

  it("拖拽结束后清除高亮", async () => {
    await mount();
    const dt = dragBag();
    fireDrag(findRow("note.md"), "dragstart", dt);
    fireDrag(findRow("alpha"), "dragover", dt);
    fireDrag(findRow("note.md"), "dragend", dt);
    expect($qa(".drag-over").length).toBe(0);
  });

  it("重命名中的行不可拖拽", async () => {
    await mount();
    await startRename("note.md");
    expect(input().closest(".tree-row")!.getAttribute("draggable")).toBe("false");
  });
});

describe("侧边栏可见性与工作区", () => {
  it("toggle 隐藏/显示并持久化偏好", async () => {
    const { sb } = await mount();
    expect(sb.visible).toBe(true);
    sb.toggle();
    expect(sb.visible).toBe(false);
    expect($q("#sidebar").classList.contains("hidden")).toBe(true);
    expect(cfg.sidebarVisible).toBe(false);
    sb.toggle();
    expect(cfg.sidebarVisible).toBe(true);
  });

  it("隐藏时键盘导航不生效", async () => {
    const { sb } = await mount();
    sb.toggle();
    globalKey("ArrowDown");
    expect(selectedLabel()).toBe("");
  });

  it("addFolder 后保持可见并写入持久化列表", async () => {
    const { sb, mock } = await mount({ folders: [] });
    mock.resetInvokeLog();
    await sb.addFolder("/other");
    expect([...cfg.folders]).toEqual(["/other"]);
    expect(sb.visible).toBe(true);
    expect(visibleTreeNames()).toEqual(["other"]);
  });

  it("重复添加同一文件夹不产生两份根节点", async () => {
    const { sb } = await mount();
    await sb.addFolder("/demo");
    expect($qa(".tree-root").length).toBe(1);
    expect([...cfg.folders]).toEqual(["/demo"]);
  });
});
