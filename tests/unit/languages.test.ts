import { describe, expect, it } from "vitest";
import type { Extension } from "@codemirror/state";
import { LANGUAGES, PLAIN, languageByLabel, languageForFile, lazy } from "../../src/languages";

const detections: Array<[string, string]> = [
  ["a.ts", "TypeScript"],
  ["A.TS", "TypeScript"],
  ["a.tsx", "TypeScript"],
  ["a.mts", "TypeScript"],
  ["a.js", "JavaScript"],
  ["a.jsx", "JavaScript"],
  ["a.json", "JSON"],
  ["a.jsonl", "JSON"],
  ["a.html", "HTML"],
  ["a.vue", "HTML"],
  ["a.css", "CSS"],
  ["a.scss", "CSS"],
  ["a.sass", "Sass"],
  ["a.styl", "Stylus"],
  ["a.md", "Markdown"],
  ["a.markdown", "Markdown"],
  ["a.py", "Python"],
  ["a.rs", "Rust"],
  ["a.go", "Go"],
  ["a.java", "Java"],
  ["a.kt", "Kotlin"],
  ["a.scala", "Scala"],
  ["a.c", "C"],
  ["a.h", "C"],
  ["a.cpp", "C++"],
  ["a.hpp", "C++"],
  ["a.cs", "C#"],
  ["a.dart", "Dart"],
  ["a.m", "Objective-C"],
  ["a.swift", "Swift"],
  ["a.rb", "Ruby"],
  ["a.php", "PHP"],
  ["a.sql", "SQL"],
  ["a.xml", "XML"],
  ["a.svg", "XML"],
  ["a.yml", "YAML"],
  ["a.toml", "TOML"],
  ["a.ini", "INI"],
  ["a.env", "INI"],
  ["a.sh", "Shell"],
  ["a.ps1", "PowerShell"],
  ["a.cmake", "CMake"],
  ["a.dockerfile", "Dockerfile"],
  ["a.diff", "Diff"],
  ["a.lua", "Lua"],
  ["a.pl", "Perl"],
  ["a.proto", "Protocol Buffers"],
  ["a.clj", "Clojure"],
  ["a.gradle", "Groovy"],
  ["a.f90", "Fortran"],
  ["a.pas", "Pascal"],
  ["a.v", "Verilog"],
  ["a.tcl", "Tcl"],
  ["a.vbs", "VB"],
  ["a.http", "HTTP"],
  // 无扩展名的特殊文件名
  ["Dockerfile", "Dockerfile"],
  ["dockerfile", "Dockerfile"],
  ["CMakeLists.txt", "CMake"],
  ["Gemfile", "Ruby"],
  ["Jenkinsfile", "Groovy"],
  ["Brewfile", "Ruby"],
  // 未知的一律回退纯文本
  ["Makefile", "纯文本"],
  ["README", "纯文本"],
  ["notes.txt", "纯文本"],
  ["data.bin", "纯文本"],
  ["archive.zip", "纯文本"],
  [".hidden.md", "Markdown"]
];

describe("语言识别", () => {
  it.each(detections)("按文件名 %s 识别为 %s", (file, label) => {
    expect(languageForFile(file).label).toBe(label);
  });

  it("扩展名匹配不区分大小写且取最后一段", () => {
    expect(languageForFile("DIR/ARCHIVE.TAR.MD").label).toBe("Markdown");
    expect(languageForFile("no-suffix").label).toBe("纯文本");
  });

  it("按标签查语言，未知标签回退纯文本", () => {
    expect(languageByLabel("Rust")).toBe(LANGUAGES.find((l) => l.label === "Rust"));
    expect(languageByLabel("不存在的语言")).toBe(PLAIN);
  });

  it("纯文本语言不加载任何语法扩展", async () => {
    expect(PLAIN.exts).toEqual([]);
    expect(await PLAIN.load()).toBeNull();
  });

  it("同一扩展名不被多种语言重复声明", () => {
    const seen = new Map<string, string>();
    for (const lang of LANGUAGES) {
      for (const ext of lang.exts) {
        const prev = seen.get(ext);
        expect(prev, `扩展名 ${ext} 同时属于 ${prev} 和 ${lang.label}`).toBeUndefined();
        seen.set(ext, lang.label);
      }
    }
  });

  it("每种语言的标签非空且唯一", () => {
    const labels = LANGUAGES.map((l) => l.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
  });

  it("全部语言的语法扩展都能按需加载成功", async () => {
    const exts = await Promise.all(LANGUAGES.map((l) => l.load()));
    for (let i = 0; i < LANGUAGES.length; i++) {
      const ext = exts[i];
      expect(ext, LANGUAGES[i].label).not.toBeNull();
      expect(ext, LANGUAGES[i].label).toBeDefined();
    }
  });

  it("重复加载同一条语言复用同一份语法包", async () => {
    const rust = languageByLabel("Rust");
    expect(await rust.load()).toBe(await rust.load());
  });

  it("语言列表覆盖常见开发语言", () => {
    for (const label of ["Markdown", "JSON", "TypeScript", "Python", "Rust", "C++", "Go", "SQL"]) {
      expect(LANGUAGES.map((l) => l.label)).toContain(label);
    }
  });
});

describe("lazy 按需加载缓存", () => {
  it("成功加载复用同一份语法包，只取一次模块", async () => {
    let calls = 0;
    const ext = {} as Extension;
    const load = lazy(async () => {
      calls++;
      return ext;
    });
    expect(await load()).toBe(ext);
    expect(await load()).toBe(ext);
    expect(calls).toBe(1);
  });

  it("加载失败不永久缓存，下次打开可重试", async () => {
    let calls = 0;
    const ext = {} as Extension;
    const load = lazy(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return ext;
    });
    await expect(load()).rejects.toThrow("boom");
    expect(await load()).toBe(ext);
    expect(calls).toBe(2);
  });
});
