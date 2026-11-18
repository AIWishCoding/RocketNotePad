import { beforeAll, describe, expect, it } from "vitest";
import { demoFs } from "../helpers/tauri-mock";
import {
  $id,
  $q,
  $qa,
  bootAppWithFolder,
  clickRow,
  dblClickRow,
  editorContent,
  findRow,
  tabStates,
  until,
  visibleTreeNames,
  viewFromDom,
  type BootedApp
} from "../helpers/dom";

let app: BootedApp;

beforeAll(async () => {
  app = await bootAppWithFolder(demoFs());
  await until(() => visibleTreeNames().length > 1);
});

describe("应用启动与外壳", () => {
  it("构建侧边栏、标签栏、编辑器与状态栏", () => {
    expect($id("sidebar")).toBeTruthy();
    expect($id("sidebar-tree")).toBeTruthy();
    expect($id("tabbar")).toBeTruthy();
    expect($id("editor-host").querySelector(".cm-editor")).toBeTruthy();
    expect($id("minimap").tagName).toBe("CANVAS");
    for (const id of ["st-pos", "st-sel", "st-size", "st-enc", "st-lang", "st-zoom", "st-wrap", "st-theme"]) {
      expect($id(id)).toBeTruthy();
    }
  });

  it("界面文案全部为中文", () => {
    const header = $q(".sidebar-header")?.textContent ?? "";
    expect(header).toContain("资源管理器");
    const welcome = $id("welcome").textContent ?? "";
    for (const word of ["新建文件", "打开文件", "打开文件夹"]) {
      expect(welcome).toContain(word);
    }
    for (const button of $qa(".sidebar-header button")) {
      expect(button.title).toMatch(/[一-龥]/);
    }
  });

  it("默认亮色主题与 15px 字号渲染", () => {
    expect(document.body.dataset.theme).toBe("light");
    expect($id("st-zoom").textContent).toBe("缩放 15px");
    expect($id("st-theme").textContent).toBe("亮色");
  });

  it("没有任何标签时显示欢迎页并隐藏编辑区", () => {
    expect($id("tabbar").children.length).toBe(0);
    expect($id("welcome").classList.contains("hidden")).toBe(false);
    expect($id("editor-wrap").classList.contains("hidden")).toBe(true);
  });

  it("侧边栏列出持久化的文件夹并按 VS Code 顺序排列", () => {
    expect(app.mock.invokeLog("list_folder_tree").length).toBeGreaterThan(0);
    // 未展开时只看到根与其下一层：目录在前，其后文件按忽略大小写排序
    expect(visibleTreeNames()).toEqual([
      "demo",
      "alpha",
      "Zeta",
      "a.cpp",
      "B.ts",
      "config.json",
      "Dockerfile",
      "note.md"
    ]);
  });

  it("文件夹图标是 SVG，行内不再出现表情符号", () => {
    expect($q(".tree-icon svg")).toBeTruthy();
    expect($id("sidebar-tree").textContent).toMatch(/^[\s\S]*$/);
    expect($id("sidebar-tree").textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it("展开目录后子项缩进递增且图标对齐", () => {
    clickRow("alpha");
    const names = visibleTreeNames();
    expect(names).toContain("one.md");
    const depth = (n: string) => findRow(n).style.getPropertyValue("--d");
    expect(depth("demo")).toBe("0");
    expect(depth("alpha")).toBe("1");
    expect(depth("one.md")).toBe("2");
  });
});

describe("打开文件与状态栏", () => {
  it("单击目录树文件生成预览标签并载入内容", async () => {
    clickRow("note.md");
    await until(() => editorContent().includes("标题"));
    const [tab] = tabStates();
    expect(tab.name).toBe("note.md");
    expect(tab.preview).toBe(true);
    expect(tab.active).toBe(true);
    expect($id("st-lang").textContent).toBe("Markdown");
    expect($id("st-enc").textContent).toContain("UTF-8");
    expect($id("st-enc").textContent).toContain("LF");
    expect($id("st-size").textContent).toContain("B");
    expect($id("st-pos").textContent).toBe("行 1, 列 1");
    expect($id("welcome").classList.contains("hidden")).toBe(true);
  });

  it("打开文件写入最近列表", () => {
    expect(app.mock.recent.map((r) => r.path)).toContain("/demo/note.md");
  });

  it("切换标签时编辑器内容随活动文档变化", async () => {
    dblClickRow("a.cpp");
    await until(() => editorContent().includes("int main"));
    expect(tabStates().length).toBe(2);
    expect(tabStates().map((t) => t.name)).toEqual(["note.md", "a.cpp"]);
    $qa("#tabbar .tab")[0].click();
    await until(() => editorContent().includes("标题"));
    expect(tabStates()[0].active).toBe(true);
  });

  it("光标移动后行列与选区状态更新", async () => {
    const view = viewFromDom();
    view.dispatch({ selection: { anchor: 0, head: 8 } });
    await until(() => $id("st-sel").textContent.includes("选中"));
    expect($id("st-pos").textContent).toContain("行 ");
    expect($id("st-sel").textContent).toContain("8 字符");
  });
});

describe("启动里程碑追踪", () => {
  it("每一步都上报后端，并在恢复标签前宣告页面就绪", () => {
    const notes = app.mock.startupNotes;
    expect(notes[0]).toContain("脚本开始执行");
    for (const step of ["配置已读取", "界面骨架已建好", "编辑器已挂载", "上次的文件夹与标签已恢复"]) {
      expect(notes.some((n) => n.includes(step)), step).toBe(true);
    }
    expect(app.mock.pageReady()).toBe(true);
    // 就绪信号在挂载之后、恢复之前：恢复过程慢或卡住都不该再弹「页面没起来」
    expect(notes.indexOf("编辑器已挂载")).toBeLessThan(notes.length - 1);
  });

  it("漏网的异常与未处理的 Promise 拒绝也记进日志", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", filename: "main.js", lineno: 7 }));
    // jsdom 没有 PromiseRejectionEvent，运行时只需要事件上的 reason 字段
    const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
    rejection.reason = new Error("nope");
    window.dispatchEvent(rejection);
    const notes = app.mock.startupNotes;
    expect(notes.some((n) => n.includes("未捕获错误：boom（main.js 第 7 行）"))).toBe(true);
    expect(notes.some((n) => n.includes("未处理的 Promise 拒绝：nope"))).toBe(true);
  });
});
