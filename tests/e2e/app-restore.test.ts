import { beforeAll, describe, expect, it } from "vitest";
import { demoFs, type TauriMock } from "../helpers/tauri-mock";
import {
  $qa,
  bootApp,
  editorContent,
  tabStates,
  until,
  visibleTreeNames,
  type BootedApp
} from "../helpers/dom";

let app: BootedApp;
let mock: TauriMock;

const selectedLabel = () =>
  document.querySelector(".tree-row.selected .tree-label")?.textContent ?? "";

/**
 * 上次退出时留着 /demo 文件夹、三个标签（其中一个后来被删掉）和停在 one.md 上的活动标签，
 * 这些都写在应用目录（macOS 为 ~/.rocketnote）的配置文件里。本次启动应该原样还原，并且不为失效路径弹错误框。
 */
beforeAll(async () => {
  app = await bootApp({
    fs: demoFs(),
    config: {
      folders: ["/demo"],
      restoreTabs: ["/demo/alpha/one.md", "/demo/gone.md", "/demo/note.md"],
      restoreActive: "/demo/alpha/one.md"
    }
  });
  mock = app.mock;
  await until(() => tabStates().length === 2);
});

describe("启动时恢复上次的文件夹与文件", () => {
  it("自动重新读取上次打开的文件夹", () => {
    const calls = mock.invokeLog("list_folder_tree");
    expect(calls.map((c) => c.args.dir)).toContain("/demo");
  });

  it("磁盘上还在的文件恢复成标签，顺序保持上次那样", () => {
    expect(tabStates().map((t) => t.name)).toEqual(["one.md", "note.md"]);
  });

  it("活动标签回到上次停留的文件", () => {
    expect(tabStates().find((t) => t.active)?.name).toBe("one.md");
    expect(editorContent()).toContain("# one");
  });

  it("目录树展开到该文件并高亮选中", () => {
    expect(visibleTreeNames()).toContain("one.md");
    expect(selectedLabel()).toBe("one.md");
  });

  it("已被删除的文件静默跳过，不弹打开失败", () => {
    expect(mock.messages.filter((m) => m.title === "打开失败")).toEqual([]);
  });

  it("失效路径从恢复列表里剔除", async () => {
    await until(() => (mock.configJson()?.restoreTabs as string[]).length === 2);
    expect(mock.configJson()?.restoreTabs).toEqual(["/demo/alpha/one.md", "/demo/note.md"]);
  });

  it("活动文件路径会随切换标签写进配置文件", async () => {
    await until(() => mock.configJson()?.restoreActive === "/demo/alpha/one.md");
    const note = $qa("#tabbar .tab").find((t) => (t.textContent ?? "").includes("note.md"))!;
    note.click();
    await until(() => tabStates().find((t) => t.active)?.name === "note.md");
    await until(() => mock.configJson()?.restoreActive === "/demo/note.md");
  });
});

describe("资源管理器标题栏", () => {
  it("打开文件夹排在动作按钮最左边，折叠按钮在最后", () => {
    expect($qa(".sidebar-header button").map((b) => b.id)).toEqual([
      "sidebar-add",
      "sidebar-newfolder",
      "sidebar-newfile",
      "sidebar-refresh",
      "sidebar-collapse"
    ]);
  });

  it("每个按钮都有中文提示且折叠按钮随目录状态切换文案", async () => {
    for (const b of $qa(".sidebar-header button")) expect(b.title).toMatch(/[一-龥]/);
    const collapse = document.querySelector<HTMLButtonElement>("#sidebar-collapse")!;
    expect(collapse.title).toBe("折叠全部");
    collapse.click();
    await until(() => visibleTreeNames().join() === "demo");
    expect(collapse.title).toBe("展开全部");
    collapse.click();
    await until(() => visibleTreeNames().includes("one.md"));
    expect(collapse.title).toBe("折叠全部");
  });
});
