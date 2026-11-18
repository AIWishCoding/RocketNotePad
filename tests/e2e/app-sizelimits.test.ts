import { beforeAll, describe, expect, it } from "vitest";
import { demoFs, type TauriMock } from "../helpers/tauri-mock";
import { $id, bootApp, dblClickRow, flush, globalKey, tabStates, until, viewFromDom, type BootedApp } from "../helpers/dom";

let app: BootedApp;
let mock: TauriMock;

const tab = (name: string) => tabStates().find((t) => t.name.replace(/^● /, "") === name);
const line = (i: number) => `日志行 ${i} ${"y".repeat(50)}`;
/** ≈1.44 MB：落在 1–2 MB 档的只读区 */
const MID = Array.from({ length: 24000 }, (_, i) => line(i)).join("\n") + "\n";
/** ≈2.88 MB：超过 2 MB 拒绝档 */
const BIG = Array.from({ length: 48000 }, (_, i) => line(i)).join("\n") + "\n";

async function openNode(name: string): Promise<void> {
  dblClickRow(name);
  await until(() => tab(name) !== undefined);
  await flush(20);
}

async function menu(id: string): Promise<void> {
  mock.emit("menu-action", id);
  await flush(30);
}

beforeAll(async () => {
  app = await bootApp({
    fs: { ...demoFs(), "/demo/mid.log": MID, "/demo/big.log": BIG },
    config: { editLimitMB: 1, maxFileMB: 2, folders: ["/demo"] },
    storage: { "rnp.folders": JSON.stringify(["/demo"]) }
  });
  mock = app.mock;
  await until(() => !!$id("sidebar-tree"));
});

describe("配置驱动的三档行为", () => {
  it("启动按配置把 1/2 MB 档位同步给菜单", () => {
    expect(mock.lastCall("refresh_size_menu")?.args).toEqual({ editLimitMb: 1, maxFileMb: 2 });
  });

  it("1–2 MB 之间的文件只读打开", async () => {
    await openNode("mid.log");
    expect(viewFromDom().state.readOnly).toBe(true);
    expect($id("st-size").textContent).toContain("只读");
  });

  it("超过拒绝档的文件打不开并提示当前上限", async () => {
    const before = mock.messages.length;
    dblClickRow("big.log");
    await until(() => mock.messages.length === before + 1);
    expect(mock.messages.at(-1)?.title).toBe("打开失败");
    expect(mock.messages.at(-1)?.message).toContain("当前上限为 2 MB");
    expect(tab("big.log")).toBeUndefined();
  });

  it("目录扫描收录范围跟着可编辑档走", async () => {
    mock.dialogs.open.length = 0;
    mock.dialogs.open.push("/demo");
    await menu("file.open_folder");
    await until(() => !!tab("Two.TXT"));
    expect(mock.lastCall("list_text_files")?.args).toMatchObject({ editLimitMb: 1 });
    // mid.log 早前已作为只读标签存在；扫描档只影响新收录，big.log 不该被开进来
    expect(tab("big.log")).toBeUndefined();
  });

  it("菜单调高档位后原只读文件变可编辑、原被拒文件能打开", async () => {
    await menu("limits.edit.64");
    await until(() => mock.configJson()?.editLimitMB === 64);
    await menu("limits.max.256");
    await until(() => mock.configJson()?.maxFileMB === 256);
    await openNode("mid.log");
    expect(viewFromDom().state.readOnly).toBe(false);
    await openNode("big.log");
    expect(viewFromDom().state.readOnly).toBe(false);
    expect(mock.configJson()?.editLimitMB).toBe(64);
    expect(mock.configJson()?.maxFileMB).toBe(256);
  });

  it("调档后的新阈值立即作用于下一次打开", async () => {
    await menu("limits.edit.1");
    await until(() => mock.configJson()?.editLimitMB === 1);
    await menu("limits.max.2");
    await until(() => mock.configJson()?.maxFileMB === 2);
    globalKey("w", { metaKey: true, shiftKey: true });
    await until(() => tabStates().length === 0);
    await openNode("mid.log");
    expect(viewFromDom().state.readOnly).toBe(true);
  });
});