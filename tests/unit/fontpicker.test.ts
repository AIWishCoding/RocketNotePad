import { afterEach, describe, expect, it } from "vitest";
import { openFontPicker } from "../../src/fontpicker";
import { COMMON_FONTS, SYSTEM_FONT, fontStack } from "../../src/fonts";
import { $q, $qa, click, keydown, mouse } from "../helpers/dom";

interface Calls {
  preview: Array<[string, number]>;
  commit: Array<[string, number]>;
  cancel: number;
}

function open(current: string = SYSTEM_FONT, fontSize = 15): Calls {
  const calls: Calls = { preview: [], commit: [], cancel: 0 };
  openFontPicker({
    current,
    fontSize,
    onPreview: (family, size) => calls.preview.push([family, size]),
    onCommit: (family, size) => calls.commit.push([family, size]),
    onCancel: () => calls.cancel++
  });
  return calls;
}

const items = () => $qa(".font-item");
const fontOf = (el: HTMLElement) => el.dataset.font!;
const selected = () => $q(".font-item.selected");
const input = () => $q<HTMLInputElement>(".font-input");

function search(text: string) {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("字体面板", () => {
  it("打开就列出系统默认和常用字体，当前项带标记", () => {
    open();
    expect(items()).toHaveLength(COMMON_FONTS.length);
    expect(fontOf(items()[0])).toBe(SYSTEM_FONT);
    expect(selected()).toBe(items()[0]);
    expect($q(".font-tag-current").textContent).toBe("当前");
    expect($qa(".font-item")).toHaveLength(COMMON_FONTS.length);
  });

  it("每行示例用该行自己的字体渲染，挑之前就能看出字形", () => {
    open();
    for (const el of items()) {
      const sample = el.querySelector<HTMLElement>(".font-sample")!;
      expect(sample.style.fontFamily).toBe(fontStack(fontOf(el)));
      expect(sample.textContent).toContain("汉字排版");
    }
  });

  it("等宽字体标出来，方便挑对齐整齐的那款", () => {
    open();
    const mono = COMMON_FONTS.filter((f) => f.mono);
    const tagged = items().filter((el) =>
      [...el.querySelectorAll(".font-tag")].some((t) => t.textContent === "等宽")
    );
    expect(tagged).toHaveLength(mono.length);
  });

  it("搜索按名字过滤，并给出同名的自定义项", () => {
    open();
    search("Mono");
    const all = items();
    expect(all.length).toBeGreaterThan(1);
    expect(all.length).toBeLessThan(COMMON_FONTS.length + 1);
    expect(fontOf(all[0]).toLowerCase()).toContain("mono");
    expect(all.at(-1)!.textContent).toContain("使用「Mono」");
  });

  it("输入没收录的字体名可以直接用，回车即选定", () => {
    const calls = open();
    search("JetBrains Mono");
    expect(items()).toHaveLength(1);
    expect(items()[0].textContent).toContain("使用「JetBrains Mono」");
    expect(items()[0].textContent).toContain("自定义");
    keydown(input(), "Enter");
    expect(calls.commit).toEqual([["JetBrains Mono", 15]]);
    expect($q(".font-box")).toBeNull();
  });

  it("上下键实时试穿但不落盘，回车才选定", () => {
    const calls = open();
    const want = fontOf(items()[1]);
    calls.preview.length = 0;
    keydown(input(), "ArrowDown");
    expect(selected()).toBe(items()[1]);
    expect(calls.preview).toEqual([[want, 15]]);
    expect(calls.commit).toEqual([]);
    keydown(input(), "ArrowDown");
    keydown(input(), "ArrowUp");
    expect(selected()).toBe(items()[1]);
    keydown(input(), "Enter");
    expect(calls.commit).toEqual([[want, 15]]);
    expect($q(".font-box")).toBeNull();
  });

  it("Esc 取消：关掉面板并让调用方恢复原字体", () => {
    const calls = open();
    keydown(input(), "ArrowDown");
    keydown(input(), "Escape");
    expect(calls.cancel).toBe(1);
    expect(calls.commit).toEqual([]);
    expect($q(".font-box")).toBeNull();
  });

  it("点遮罩等同取消，点行等同选定", () => {
    const cancelled = open();
    mouse($q(".palette-overlay"), "mousedown");
    expect(cancelled.cancel).toBe(1);
    expect($q(".font-box")).toBeNull();

    const picked = open();
    const row = items()[2];
    const want = fontOf(row);
    click(row);
    expect(picked.commit).toEqual([[want, 15]]);
    expect($q(".font-box")).toBeNull();
  });

  it("悬停即试穿，不用点下去就能看效果", () => {
    const calls = open();
    calls.preview.length = 0;
    items()[3].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    expect(selected()).toBe(items()[3]);
    expect(calls.preview).toEqual([[fontOf(items()[3]), 15]]);
  });

  it("字号可以就地加减与重置，并跟着一起试穿", () => {
    const calls = open(SYSTEM_FONT, 15);
    calls.preview.length = 0;
    click($q(".font-plus"));
    expect($q(".font-size-value").textContent).toBe("16px");
    expect(calls.preview.at(-1)).toEqual([SYSTEM_FONT, 16]);
    click($q(".font-minus"));
    click($q(".font-minus"));
    expect($q(".font-size-value").textContent).toBe("14px");
    click($q(".font-size-reset"));
    expect($q(".font-size-value").textContent).toBe("15px");
    keydown(input(), "Enter");
    expect(calls.commit).toEqual([[SYSTEM_FONT, 15]]);
  });

  it("字号夹在 9 到 40 之间，连点不会越界", () => {
    open(SYSTEM_FONT, 39);
    for (let i = 0; i < 5; i++) click($q(".font-plus"));
    expect($q(".font-size-value").textContent).toBe("40px");
    for (let i = 0; i < 50; i++) click($q(".font-minus"));
    expect($q(".font-size-value").textContent).toBe("9px");
  });

  it("当前用的是自定义字体时，打开面板不会把它挤掉", () => {
    const calls = open("JetBrains Mono", 18);
    expect(fontOf(items()[0])).toBe("JetBrains Mono");
    expect(selected()).toBe(items()[0]);
    expect(calls.preview.at(-1)).toEqual(["JetBrains Mono", 18]);
    expect($q(".font-size-value").textContent).toBe("18px");
  });

  it("重复打开只留一个面板", () => {
    open();
    open("system", 20);
    expect($qa(".palette-overlay")).toHaveLength(1);
    expect($q(".font-size-value").textContent).toBe("20px");
  });

  it("只有标点这类拼不出字体名的输入给空态，空白输入仍列全部", () => {
    open();
    search("   ");
    expect(items()).toHaveLength(COMMON_FONTS.length);
    search('";;');
    expect(items()).toHaveLength(0);
    expect($q(".palette-empty").textContent).toBe("无匹配字体");
    keydown(input(), "ArrowDown");
    keydown(input(), "Enter");
    expect($q(".font-box")).toBeNull();
  });
});