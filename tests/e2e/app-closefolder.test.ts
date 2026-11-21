import { beforeAll, describe, expect, it } from "vitest";
import { demoFs, type TauriMock } from "../helpers/tauri-mock";
import {
  $qa,
  bootApp,
  click,
  clickRow,
  dblClickRow,
  findRow,
  flush,
  mouse,
  tabStates,
  until,
  viewFromDom,
  visibleTreeNames
} from "../helpers/dom";
import type { BootedApp } from "../helpers/dom";

let app: BootedApp;
let mock: TauriMock;

beforeAll(async () => {
  app = await bootApp({
    fs: {
      ...demoFs(),
      "/other": null,
      "/other/b.md": "b 内容\n",
      "/other/c.md": "c 内容\n",
      "/third": null,
      "/third/d.md": "d 内容\n",
      "/fourth": null,
      "/fourth/e.md": "e 内容\n"
    },
    storage: { "rnp.folders": JSON.stringify(["/demo", "/other", "/third", "/fourth"]) }
  });
  mock = app.mock;
  await until(() => $qa(".tree-root").length === 4);
});

const tab = (name: string) => tabStates().find((t) => t.name.replace(/^● /, "") === name);

function answer(asks: boolean[]): void {
  mock.dialogs.ask.length = 0;
  mock.dialogs.ask.push(...asks);
}

/** 根文件夹默认是折叠的，先展开再双击里面的文件 */
async function openFile(root: string, name: string): Promise<void> {
  if (!visibleTreeNames().includes(name)) {
    clickRow(root);
    await until(() => visibleTreeNames().includes(name));
  }
  dblClickRow(name);
  await until(() => tab(name)?.active === true);
}

/** 根文件夹右键 →「关闭文件夹」 */
async function closeFolder(root: string): Promise<void> {
  mouse(findRow(root), "contextmenu");
  const item = $qa(".ctx-item").find((i) => i.querySelector("span")?.textContent === "关闭文件夹");
  if (!item) throw new Error(`根节点 ${root} 的右键菜单里没有「关闭文件夹」`);
  click(item);
  await flush(20);
}

describe("关闭文件夹连带关闭标签", () => {
  it("该文件夹下的标签一起关掉，别的文件夹不受影响", async () => {
    await openFile("other", "b.md");
    await openFile("other", "c.md");
    await openFile("demo", "note.md");
    answer([]);

    await closeFolder("other");

    expect(tab("b.md")).toBeUndefined();
    expect(tab("c.md")).toBeUndefined();
    expect(tab("note.md")).toBeDefined();
    expect(mock.dialogs.ask.length).toBe(0);
  });

  it("有未保存修改时先询问，取消就保留标签", async () => {
    await openFile("third", "d.md");
    viewFromDom().dispatch({ changes: { from: 0, insert: "改" } });
    await until(() => tab("d.md")?.dirty === true);
    answer([false]);

    await closeFolder("third");

    expect(tab("d.md")).toBeDefined();
    expect(tab("d.md")?.dirty).toBe(true);
  });

  it("确认关闭后丢弃未保存修改并关掉标签", async () => {
    await openFile("fourth", "e.md");
    viewFromDom().dispatch({ changes: { from: 0, insert: "改" } });
    await until(() => tab("e.md")?.dirty === true);
    answer([true]);

    await closeFolder("fourth");

    expect(tab("e.md")).toBeUndefined();
    expect(visibleTreeNames()).not.toContain("fourth");
  });
});
