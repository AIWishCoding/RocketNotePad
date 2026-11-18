import { beforeAll, describe, expect, it } from "vitest";
import { demoFs, type TauriMock } from "../helpers/tauri-mock";
import { SYSTEM_FONT, SYSTEM_STACK, fontStack } from "../../src/fonts";
import {
  $id,
  $q,
  $qa,
  bootApp,
  click,
  flush,
  globalKey,
  keydown,
  mouse,
  until,
  untilConfig,
  viewFromDom,
  type BootedApp
} from "../helpers/dom";

let app: BootedApp;
let mock: TauriMock;

const items = () => $qa(".font-item");
const fontOf = (el: HTMLElement) => el.dataset.font!;
const pickerInput = () => $q<HTMLInputElement>(".font-input");
/** jsdom 会重排字体名里的引号，比较前统一去掉 */
const norm = (s: string) => s.replace(/['"]/g, "").replace(/\s+/g, " ").trim();
const editorFont = () => norm(getComputedStyle(viewFromDom().scrollDOM).fontFamily);
const cssVar = () => document.documentElement.style.getPropertyValue("--rnp-editor-font");
const sameFont = (id: string) => editorFont() === norm(fontStack(id));

async function menu(id: string): Promise<void> {
  mock.emit("menu-action", id);
  await flush(30);
}

async function openPicker(): Promise<void> {
  await menu("view.font");
  await until(() => items().length > 0);
}

function search(text: string) {
  pickerInput().value = text;
  pickerInput().dispatchEvent(new Event("input", { bubbles: true }));
}

/** 挑一款当前平台一定有的等宽字体：清单里第一个标了等宽的 */
function firstMono(): string {
  const el = items().find((i) => [...i.querySelectorAll(".font-tag")].some((t) => t.textContent === "等宽"));
  return fontOf(el!);
}

beforeAll(async () => {
  app = await bootApp({
    fs: {
      ...demoFs(),
      "/demo/code.md": "# 代码\n\n```js\nconst a = 1;\n```\n"
    },
    config: {
      folders: ["/demo"],
      preview: true,
      autoSave: false,
      restoreTabs: ["/demo/code.md"]
    }
  });
  mock = app.mock;
  await until(() => $qa("#tabbar .tab").length === 1);
  await until(() => !$id("preview-pane").classList.contains("hidden"));
});

describe("默认字体跟随系统", () => {
  it("状态栏、编辑器与预览代码块都用系统默认字体栈", () => {
    expect($id("st-font").textContent).toBe("系统默认");
    expect(cssVar()).toBe(SYSTEM_STACK);
    expect(editorFont()).toBe(norm(SYSTEM_STACK));
    expect(mock.configJson()?.fontFamily ?? SYSTEM_FONT).toBe(SYSTEM_FONT);
  });

  it("预览面板打开时编辑器字体变量已经就位，代码块能直接继承", async () => {
    await until(() => !!$q("#preview-pane code"));
    expect(cssVar()).toBe(SYSTEM_STACK);
  });
});

describe("字体面板", () => {
  it("菜单「字体…」打开面板，当前项标着系统默认", async () => {
    await openPicker();
    expect($q(".font-title").textContent).toBe("字体");
    expect(fontOf(items()[0])).toBe(SYSTEM_FONT);
    expect($q(".font-item.selected")).toBe(items()[0]);
    expect($q(".font-size-value").textContent).toBe("15px");
  });

  it("上下键即时试穿：编辑器与状态栏跟着变，但还没落盘", async () => {
    const want = fontOf(items()[1]);
    const label = items()[1].querySelector(".font-name")!.textContent;
    keydown(pickerInput(), "ArrowDown");
    await until(() => sameFont(want));
    expect($id("st-font").textContent).toBe(label);
    expect(cssVar()).toBe(fontStack(want));
    expect(mock.configJson()?.fontFamily ?? SYSTEM_FONT).toBe(SYSTEM_FONT);
  });

  it("Esc 取消后字体原样还回去，配置里不留痕迹", async () => {
    keydown(pickerInput(), "Escape");
    await until(() => sameFont(SYSTEM_FONT));
    expect($q(".font-box")).toBeNull();
    expect($id("st-font").textContent).toBe("系统默认");
    expect(mock.configJson()?.fontFamily ?? SYSTEM_FONT).toBe(SYSTEM_FONT);
  });

  it("试穿期间别的设置落盘，不会把没选定的字体写进配置", async () => {
    await openPicker();
    const want = fontOf(items()[1]);
    keydown(pickerInput(), "ArrowDown");
    await until(() => sameFont(want));
    // 切主题会触发一次防抖落盘，试穿值不能跟着进配置文件
    await menu("view.theme");
    await untilConfig(mock, "theme", "dark");
    await menu("view.theme");
    await untilConfig(mock, "theme", "light");
    expect(mock.configJson()?.fontFamily ?? SYSTEM_FONT).toBe(SYSTEM_FONT);
    expect(sameFont(want)).toBe(true);
    keydown(pickerInput(), "Escape");
    await until(() => sameFont(SYSTEM_FONT));
    expect(mock.configJson()?.fontFamily ?? SYSTEM_FONT).toBe(SYSTEM_FONT);
  });

  it("选定一款等宽字体：编辑器、小地图、预览与配置一起跟上", async () => {
    await openPicker();
    const mono = firstMono();
    const row = items().find((i) => fontOf(i) === mono)!;
    click(row);
    await until(() => sameFont(mono));
    expect($q(".font-box")).toBeNull();
    expect(cssVar()).toBe(fontStack(mono));
    expect($id("st-font").textContent).toBe(row.querySelector(".font-name")!.textContent);
    await untilConfig(mock, "fontFamily", mono);
    // 小地图的画布文字也换成同一款字体
    await flush(220);
    const ctx = ($id("minimap") as HTMLCanvasElement & { __ctx: { font: string } }).__ctx;
    expect(ctx.font).toContain(mono);
  });

  it("面板里改字号同样落盘，状态栏缩放跟着走", async () => {
    await openPicker();
    click($q(".font-plus"));
    click($q(".font-plus"));
    expect($q(".font-size-value").textContent).toBe("17px");
    keydown(pickerInput(), "Enter");
    await untilConfig(mock, "fontSize", 17);
    expect($id("st-zoom").textContent).toBe("缩放 17px");
    expect(sameFont(mock.configJson()!.fontFamily as string)).toBe(true);
  });

  it("输入没收录的字体名可以直接用，并写进配置", async () => {
    await openPicker();
    search("JetBrains Mono");
    expect(items()).toHaveLength(1);
    keydown(pickerInput(), "Enter");
    await untilConfig(mock, "fontFamily", "JetBrains Mono");
    expect(sameFont("JetBrains Mono")).toBe(true);
    expect($id("st-font").textContent).toBe("JetBrains Mono");
  });

  it("自定义字体会留在列表首位，重开面板不会被挤掉", async () => {
    await openPicker();
    expect(fontOf(items()[0])).toBe("JetBrains Mono");
    expect($q(".font-item.selected")).toBe(items()[0]);
    expect($q(".font-tag-current").textContent).toBe("当前");
    keydown(pickerInput(), "Escape");
    await until(() => !$q(".font-box"));
  });

  it("点状态栏的字体名也能打开面板，选回系统默认后处处还原", async () => {
    click($id("st-font"));
    await until(() => items().length > 0);
    click(items().find((i) => fontOf(i) === SYSTEM_FONT)!);
    await untilConfig(mock, "fontFamily", SYSTEM_FONT);
    expect(sameFont(SYSTEM_FONT)).toBe(true);
    expect(cssVar()).toBe(SYSTEM_STACK);
    expect($id("st-font").textContent).toBe("系统默认");
  });

  it("命令面板里也有「选择字体」，并显示当前字体", async () => {
    globalKey("p", { metaKey: true, shiftKey: true });
    await until(() => !!$q(".palette-input"));
    const input = $q<HTMLInputElement>(".palette-input");
    input.value = "字体";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(10);
    const item = $qa(".palette-item").find((i) => (i.textContent ?? "").includes("选择字体"));
    expect(item?.textContent).toContain("系统默认");
    mouse(item!, "mousedown");
    await until(() => items().length > 0);
    keydown(pickerInput(), "Escape");
    await until(() => !$q(".font-box"));
  });
});