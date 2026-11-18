import { beforeAll, describe, expect, it } from "vitest";
import { version } from "../../package.json";
import { APP_CONFIG_PATH, demoFs, type TauriMock } from "../helpers/tauri-mock";
import {
  $q,
  $qa,
  bootApp,
  click,
  dblClickRow,
  flush,
  globalKey,
  keydown,
  mouse,
  tabStates,
  until,
  type BootedApp
} from "../helpers/dom";

let app: BootedApp;
let mock: TauriMock;

const aboutOpen = () => !!$q(".about-box");

async function menu(id: string): Promise<void> {
  mock.emit("menu-action", id);
  await flush(30);
}

async function closeAbout(): Promise<void> {
  if (!aboutOpen()) return;
  keydown(document.body, "Escape");
  await until(() => !aboutOpen());
}

beforeAll(async () => {
  app = await bootApp({
    fs: demoFs(),
    storage: { "rnp.folders": JSON.stringify(["/demo"]) }
  });
  mock = app.mock;
  await until(() => !!$q("#sidebar-tree .tree-row"));
});

describe("帮助 · 关于", () => {
  it("菜单打开的是完整面板而不是系统弹窗，关闭后焦点回到编辑器", async () => {
    const messages = mock.messages.length;
    await menu("help.about");
    expect(aboutOpen()).toBe(true);
    expect(mock.messages).toHaveLength(messages);
    expect($q(".about-tagline").textContent).toContain("本地优先");
    await closeAbout();
    expect(document.activeElement).toBe($q(".cm-content"));
  });

  it("命令面板里能搜到关于，提示带版本号", async () => {
    globalKey("p", { metaKey: true, shiftKey: true });
    await until(() => !!$q(".palette-input"));
    const input = $q<HTMLInputElement>(".palette-input");
    input.value = "关于";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(10);
    const first = $q(".palette-item");
    expect(first.textContent).toContain("帮助: 关于 RocketNotePad");
    expect(first.textContent).toContain(version);
    keydown(input, "Enter");
    await until(aboutOpen);
    expect($q(".palette-input")).toBeFalsy();
    await closeAbout();
  });

  it("面板里的命令面板按钮接着就能用，改动照常落盘", async () => {
    await menu("help.about");
    click($qa<HTMLButtonElement>(".about-btn").find((b) => b.textContent === "命令面板")!);
    await until(() => !!$q(".palette-input"));
    expect(aboutOpen()).toBe(false);
    const input = $q<HTMLInputElement>(".palette-input");
    input.value = "切换明暗主题";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(10);
    keydown(input, "Enter");
    await until(() => document.body.dataset.theme === "dark");
    await until(() => mock.configJson()?.theme === "dark");

    // 暗色下再开一次，面板跟着当前主题走
    await menu("help.about");
    expect(aboutOpen()).toBe(true);
    await closeAbout();
    await menu("view.theme");
    await until(() => document.body.dataset.theme === "light");
  });

  it("面板开着时全局快捷键不会穿过它去改文档", async () => {
    const before = tabStates().length;
    await menu("help.about");
    globalKey("n", { metaKey: true });
    globalKey("w", { metaKey: true });
    await flush(20);
    expect(tabStates()).toHaveLength(before);
    expect(aboutOpen()).toBe(true);
    await closeAbout();
  });

  it("运行环境页报的是本次会话的真实规模与真实路径", async () => {
    dblClickRow("note.md");
    await until(() => tabStates().some((t) => t.name === "note.md" && t.active));
    dblClickRow("a.cpp");
    await until(() => tabStates().some((t) => t.name === "a.cpp" && t.active));
    await menu("help.about");
    click($qa<HTMLButtonElement>(".about-tab")[2]);
    await until(() => ($q("#about-panel-env").textContent ?? "").includes(APP_CONFIG_PATH));
    const rows = $qa(".about-env-row").map((r) => r.textContent ?? "");
    expect(rows.find((r) => r.startsWith("本次会话"))).toContain(`${tabStates().length} 个标签`);
    expect(rows.find((r) => r.startsWith("本次会话"))).toContain("1 个文件夹");
    expect(rows.find((r) => r.startsWith("版本"))).toContain(version);
    await closeAbout();
  });

  it("点遮罩关掉面板，编辑器可以继续输入", async () => {
    await menu("help.about");
    mouse($q(".about-overlay"), "mousedown");
    await until(() => !aboutOpen());
    const content = $q(".cm-content");
    content.focus();
    expect(document.activeElement).toBe(content);
  });
});
