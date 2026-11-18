import { afterEach, describe, expect, it, vi } from "vitest";
import { fuzzyScore, openGoto, openPalette, promptText, type Command } from "../../src/palette";
import type { FlatFile } from "../../src/sidebar";
import { $qa, $q, mouse } from "../helpers/dom";

const items = (): HTMLElement[] => $qa(".palette-item");
const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>(".palette-input")!;

function typeQuery(value: string) {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}

function key(keyName: string, init: KeyboardEventInit = {}) {
  input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: keyName, ...init }));
}

function labels(): string[] {
  return items().map((el) => el.textContent ?? "");
}

const cmds = (...ids: string[]): Command[] =>
  ids.map((id, i) => ({ id, title: `命令 ${id}`, hint: `hint-${id}`, run: vi.fn(() => void i) }));

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("模糊匹配打分", () => {
  it("空查询匹配一切，连续包含得分最高", () => {
    expect(fuzzyScore("", "anything")).toBe(1);
    expect(fuzzyScore("ab", "ab-cmd")).toBeGreaterThan(fuzzyScore("ab", "a-b-cmd"));
    expect(fuzzyScore("ab", "xaby")).toBeGreaterThan(fuzzyScore("ab", "zzzab"));
  });

  it("支持跳字匹配，字符顺序不满足时返回 -1", () => {
    expect(fuzzyScore("ho", "hello")).toBeGreaterThan(0);
    expect(fuzzyScore("ehlo", "hello")).toBe(-1);
    expect(fuzzyScore("hlo", "hello")).toBeGreaterThan(0);
  });

  it("大小写不敏感，中文按包含匹配", () => {
    expect(fuzzyScore("MD", "a.md")).toBe(fuzzyScore("md", "a.md"));
    expect(fuzzyScore("保存", "文件保存")).toBeGreaterThan(0);
    expect(fuzzyScore("保存", "另存为")).toBe(-1);
  });
});

describe("命令面板", () => {
  it("打开后列出全部命令、快捷键提示并默认选中第一项", () => {
    openPalette(cmds("a", "b", "c"));
    expect(input().placeholder).toBe("输入命令…");
    expect(labels()).toEqual(["命令 ahint-a", "命令 bhint-b", "命令 chint-c"]);
    expect(items()[0].classList.contains("selected")).toBe(true);
    expect($q(".palette-sub").textContent).toBe("hint-a");
    expect(document.activeElement).toBe(input());
  });

  it("输入即时过滤并按得分排序", () => {
    openPalette(cmds("save", "save-as", "print"));
    typeQuery("save-as");
    expect(labels()).toEqual(["命令 save-ashint-save-as"]);
    typeQuery("print");
    expect(labels()).toEqual(["命令 printhint-print"]);
    typeQuery("save");
    expect(labels()).toEqual(["命令 savehint-save", "命令 save-ashint-save-as"]);
  });

  it("快捷键提示也参与匹配", () => {
    const run = vi.fn();
    openPalette([{ id: "x", title: "切换主题", hint: "ctrl+alt+t", run }]);
    typeQuery("alt+t");
    expect(labels().length).toBe(1);
  });

  it("无匹配时显示中文空态", () => {
    openPalette(cmds("a"));
    typeQuery("zzzz");
    expect(items().length).toBe(0);
    expect($q(".palette-empty").textContent).toBe("无匹配项");
  });

  it("上下键移动选中项并在两端停住", () => {
    openPalette(cmds("a", "b", "c"));
    key("ArrowDown");
    key("ArrowDown");
    expect(items()[2].classList.contains("selected")).toBe(true);
    key("ArrowDown");
    expect(items()[2].classList.contains("selected")).toBe(true);
    key("ArrowUp");
    expect(items()[1].classList.contains("selected")).toBe(true);
    key("ArrowUp");
    key("ArrowUp");
    expect(items()[0].classList.contains("selected")).toBe(true);
  });

  it("回车执行选中命令并关闭浮层", () => {
    const run = vi.fn();
    openPalette([{ id: "r", title: "执行我", run }]);
    typeQuery("执行");
    key("Enter");
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".palette-overlay")).toBeNull();
  });

  it("鼠标按下条目即执行，Esc 与点击遮罩只关闭", () => {
    const run = vi.fn();
    openPalette([{ id: "r", title: "点我", run }]);
    mouse(items()[0], "mousedown");
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".palette-overlay")).toBeNull();

    openPalette([{ id: "r", title: "别点", run }]);
    mouse($q(".palette-overlay"), "mousedown");
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".palette-overlay")).toBeNull();

    openPalette([{ id: "r", title: "逃开", run }]);
    key("Escape");
    expect(document.querySelector(".palette-overlay")).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("列表最多渲染 50 项，键盘也只走到第 50 项", () => {
    openPalette(cmds(...Array.from({ length: 60 }, (_, i) => String(i))));
    expect(items().length).toBe(50);
    for (let i = 0; i < 60; i++) key("ArrowDown");
    expect(items()[49].classList.contains("selected")).toBe(true);
  });

  it("重复打开只保留一个浮层", () => {
    openPalette(cmds("a"));
    openPalette(cmds("b"));
    expect($qa(".palette-overlay").length).toBe(1);
    expect(labels()).toEqual(["命令 bhint-b"]);
  });
});

describe("输入框 promptText", () => {
  it("确定按钮返回去掉首尾空白的输入", async () => {
    const p = promptText("新建文件名", "untitled.md");
    expect(input().value).toBe("untitled.md");
    expect($q(".prompt-title").textContent).toBe("新建文件名");
    input().value = "  a.txt  ";
    ($q(".prompt-ok") as HTMLButtonElement).click();
    expect(await p).toBe("a.txt");
    expect(document.querySelector(".palette-overlay")).toBeNull();
  });

  it("回车提交，空输入不提交", async () => {
    const p = promptText("重命名", "");
    key("Enter");
    expect(document.querySelector(".palette-overlay")).not.toBeNull();
    input().value = "b.md";
    key("Enter");
    expect(await p).toBe("b.md");
  });

  it("取消、Esc、点击遮罩都返回 null", async () => {
    const p1 = promptText("x", "y");
    ($q(".prompt-cancel") as HTMLButtonElement).click();
    expect(await p1).toBeNull();

    const p2 = promptText("x", "y");
    key("Escape");
    expect(await p2).toBeNull();

    const p3 = promptText("x", "y");
    mouse($q(".palette-overlay"), "mousedown");
    expect(await p3).toBeNull();
  });

  it("按钮文案为中文且会预选原有内容", async () => {
    const p = promptText("标题", "abc");
    expect($q(".prompt-cancel").textContent).toBe("取消");
    expect($q(".prompt-ok").textContent).toBe("确定");
    expect(input().selectionEnd).toBe(3);
    ($q(".prompt-cancel") as HTMLButtonElement).click();
    await p;
  });
});

describe("跳转到文件 / 行", () => {
  const files: FlatFile[] = [
    { path: "/demo/alpha/one.md", name: "one.md" },
    { path: "/demo/note.md", name: "note.md" },
    { path: "/demo/Zeta/readme.md", name: "readme.md" }
  ];

  it("列出全部文件，子标题为完整路径", () => {
    const openFile = vi.fn();
    openGoto(files, openFile, vi.fn());
    expect(input().placeholder).toBe("跳转到文件…（输入 :行号 可跳转当前文件的行）");
    expect(items().length).toBe(3);
    expect($q(".palette-sub").textContent).toBe("/demo/alpha/one.md");
  });

  it("冒号开头切换为跳转行命令", async () => {
    const gotoLine = vi.fn();
    openGoto(files, vi.fn(), gotoLine);
    typeQuery(":42");
    expect(labels()).toEqual(["跳转到第 42 行"]);
    key("Enter");
    expect(gotoLine).toHaveBeenCalledWith(42);
  });

  it("文件:行号 先打开文件再跳转行", async () => {
    vi.useFakeTimers();
    const openFile = vi.fn();
    const gotoLine = vi.fn();
    openGoto(files, openFile, gotoLine);
    typeQuery("no:7");
    expect(labels()).toEqual(["note.md:7/demo/note.md"]);
    key("Enter");
    expect(openFile).toHaveBeenCalledWith("/demo/note.md");
    expect(gotoLine).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(gotoLine).toHaveBeenCalledWith(7);
  });

  it("不存在的文件名下无匹配项", () => {
    openGoto(files, vi.fn(), vi.fn());
    typeQuery("zzz:1");
    expect(items().length).toBe(0);
    expect($q(".palette-empty").textContent).toBe("无匹配项");
  });

  it("模糊匹配文件名，路径命中也可跳转", () => {
    const openFile = vi.fn();
    openGoto(files, openFile, vi.fn());
    typeQuery("readme");
    mouse(items()[0], "mousedown");
    expect(openFile).toHaveBeenCalledWith("/demo/Zeta/readme.md");
  });
});
