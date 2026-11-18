import { describe, expect, it } from "vitest";
import {
  chevronSvg,
  fileIconSvg,
  folderClosedSvg,
  folderOpenSvg
} from "../../src/icons";

const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

describe("目录树 SVG 图标", () => {
  it("箭头与文件夹是内联 SVG，且不含表情符号", () => {
    for (const markup of [chevronSvg, folderClosedSvg, folderOpenSvg]) {
      expect(markup).toMatch(/^<svg /);
      expect(markup).toContain("</svg>");
      expect(markup).not.toMatch(emoji);
    }
    expect(chevronSvg).toContain("stroke=\"currentColor\"");
    expect(folderClosedSvg).not.toContain("opacity");
    expect(folderOpenSvg).toContain("opacity");
  });

  it("按扩展名给出带角标的文件图标", () => {
    const cases: Array<[string, string, string]> = [
      ["note.md", "MD", "#519aba"],
      ["app.ts", "TS", "#3178c6"],
      ["main.cpp", "C+", "#f34b7d"],
      ["main.c", "C", "#4e6cc0"],
      ["lib.rs", "RS", "#c0652f"],
      ["index.html", "<>", "#e34c26"],
      ["pkg.json", "{}", "#cbcb41"],
      ["script.py", "PY", "#3572a5"],
      ["init.sh", "$", "#4d9a6a"],
      ["report.pdf", "PDF", "#db4437"]
    ];
    for (const [file, label, color] of cases) {
      const svg = fileIconSvg(file);
      expect(svg, file).toContain(`>${label}</text>`);
      expect(svg, file).toContain(`color="${color}"`);
    }
  });

  it("扩展名识别忽略大小写", () => {
    expect(fileIconSvg("README.MD")).toBe(fileIconSvg("readme.md"));
    expect(fileIconSvg("A.TS")).toBe(fileIconSvg("a.ts"));
  });

  it("图片类文件使用图片轮廓而不是角标", () => {
    for (const name of ["a.png", "b.jpg", "c.jpeg", "d.gif", "e.webp", "f.ico"]) {
      const svg = fileIconSvg(name);
      expect(svg).toContain("<circle");
      expect(svg).not.toContain("<text");
      expect(svg).toContain('color="#a074c4"');
    }
  });

  it("未知扩展名与无扩展名回退为普通文档轮廓", () => {
    for (const name of ["mystery.zzz", "LICENSE", "Makefile", "noextension"]) {
      const svg = fileIconSvg(name);
      expect(svg).not.toContain("<text");
      expect(svg).not.toContain("<circle");
      expect(svg).toContain('color="#8a919c"');
    }
  });

  it("角标字号按长度递减，避免溢出", () => {
    const two = fileIconSvg("a.ts");
    const three = fileIconSvg("a.pdf");
    const font = (s: string) => Number(/font-size="(\d+)"/.exec(s)?.[1]);
    expect(font(two)).toBeGreaterThan(font(three));
  });

  it("图标是装饰性的，不参与无障碍朗读", () => {
    expect(fileIconSvg("a.md")).toContain('aria-hidden="true"');
    expect(chevronSvg).toContain('focusable="false"');
  });
});
