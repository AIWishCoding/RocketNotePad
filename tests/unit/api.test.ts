import { afterEach, describe, expect, it } from "vitest";
import * as api from "../../src/api";
import {
  applyLineEnding,
  demoFs,
  detectLineEnding,
  installTauriMock,
  type TauriMock
} from "../helpers/tauri-mock";

let mock: TauriMock | undefined;

/** 每个用例只调一个包装函数，断言命令名与参数键完全一致 */
async function call<T>(fn: () => Promise<T>) {
  mock = installTauriMock({ fs: demoFs() });
  const value = await fn();
  return { mock, value };
}

/** 期望的后端命令契约：包装函数 -> [命令名, 参数键] */
const CONTRACT: Array<{ label: string; run: () => Promise<unknown>; cmd: string; keys: string[] }> = [
  { label: "readTextFile", run: () => api.readTextFile("/demo/note.md"), cmd: "read_text_file", keys: ["path"] },
  {
    label: "writeTextFile",
    run: () => api.writeTextFile("/demo/note.md", "x", "UTF-8", "\r\n"),
    cmd: "write_text_file",
    keys: ["path", "content", "encoding", "lineEnding"]
  },
  { label: "fileMetadata", run: () => api.fileMetadata("/demo/note.md"), cmd: "file_metadata", keys: ["path"] },
  { label: "isDirectory", run: () => api.isDirectory("/demo"), cmd: "is_directory", keys: ["path"] },
  { label: "listTextFiles", run: () => api.listTextFiles("/demo"), cmd: "list_text_files", keys: ["dir"] },
  { label: "listFolderTree", run: () => api.listFolderTree("/demo"), cmd: "list_folder_tree", keys: ["dir"] },
  { label: "createFile", run: () => api.createFile("/demo/new.md"), cmd: "create_file", keys: ["path"] },
  { label: "createDir", run: () => api.createDir("/demo/new"), cmd: "create_dir", keys: ["path"] },
  {
    label: "renamePath",
    run: () => api.renamePath("/demo/note.md", "/demo/renamed.md"),
    cmd: "rename_path",
    keys: ["from", "to"]
  },
  { label: "deletePath", run: () => api.deletePath("/demo/a.cpp"), cmd: "delete_path", keys: ["path"] },
  { label: "pathExists", run: () => api.pathExists("/demo/B.ts"), cmd: "path_exists", keys: ["path"] },
  {
    label: "copyPath",
    run: () => api.copyPath("/demo/note.md", "/demo/copy.md"),
    cmd: "copy_path",
    keys: ["from", "to"]
  },
  {
    label: "revealInFileManager",
    run: () => api.revealInFileManager("/demo/note.md"),
    cmd: "reveal_in_file_manager",
    keys: ["path"]
  },
  { label: "listRecent", run: () => api.listRecent(), cmd: "list_recent", keys: [] },
  { label: "pushRecent", run: () => api.pushRecent("/demo/note.md"), cmd: "push_recent", keys: ["path"] },
  { label: "clearRecent", run: () => api.clearRecent(), cmd: "clear_recent", keys: [] }
];

afterEach(() => {
  mock?.uninstall();
  mock = undefined;
  document.body.innerHTML = "";
});

describe("后端命令契约", () => {
  it("16 个包装函数与 Rust 命令名、参数键一一对应", async () => {
    expect(CONTRACT).toHaveLength(16);
    for (const c of CONTRACT) {
      const { mock: m } = await call(c.run);
      const calls = m.invokeLog(c.cmd);
      expect(calls, c.label).toHaveLength(1);
      expect(Object.keys(calls[0].args).sort(), c.label).toEqual([...c.keys].sort());
      m.uninstall();
    }
  });

  it("包装函数只发一次 invoke，不附带隐藏参数", async () => {
    const { mock: m } = await call(() => api.readTextFile("/demo/note.md"));
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toEqual({ cmd: "read_text_file", args: { path: "/demo/note.md" } });
  });
});

describe("读取与写入返回值", () => {
  it("readTextFile 透传内容、编码、行尾、字节大小与超大标记", async () => {
    const { value } = await call(() => api.readTextFile("/demo/note.md"));
    expect(value).toEqual({
      content: "# 标题\n\n正文 one two three\n",
      encoding: "UTF-8",
      line_ending: "\n",
      size: new TextEncoder().encode("# 标题\n\n正文 one two three\n").length,
      large: false
    });
  });

  it("writeTextFile 按 lineEnding 落盘并返回元信息", async () => {
    const { mock: m, value } = await call(() => api.writeTextFile("/demo/x.md", "a\nb\n", "UTF-8", "\r\n"));
    expect(m.fs.content("/demo/x.md")).toBe("a\r\nb\r\n");
    expect(value).toMatchObject({ exists: true, read_only: false });
    expect(value!.size).toBeGreaterThan(0);
    expect(typeof value!.modified).toBe("number");
  });

  it("fileMetadata 对文件与目录都报告 exists", async () => {
    const file = await call(() => api.fileMetadata("/demo/a.cpp"));
    expect(file.value.exists).toBe(true);
    expect(file.value.size).toBe("int main() { return 0; }\n".length);
    file.mock.uninstall();
    const dir = await call(() => api.fileMetadata("/demo"));
    expect(dir.value.exists).toBe(true);
    dir.mock.uninstall();
    const missing = await call(() => api.fileMetadata("/demo/nope.txt"));
    expect(missing.value.exists).toBe(false);
    expect(missing.value.size).toBe(0);
  });

  it("isDirectory / pathExists 区分目录、文件与不存在", async () => {
    const { value: dirTrue } = await call(() => api.isDirectory("/demo/alpha"));
    expect(dirTrue).toBe(true);
    const { mock: m } = await call(() => api.isDirectory("/demo/note.md"));
    expect(m.lastCall("is_directory")).toBeTruthy();
    m.uninstall();
    const file = await call(() => api.pathExists("/demo/B.ts"));
    expect(file.value).toBe(true);
    file.mock.uninstall();
    const missing = await call(() => api.pathExists("/demo/zzz"));
    expect(missing.value).toBe(false);
  });
});

describe("目录列举", () => {
  it("listTextFiles 递归返回文本文件，目录本身不入列", async () => {
    const { value } = await call(() => api.listTextFiles("/demo"));
    expect(value).toEqual([
      "/demo/a.cpp",
      "/demo/B.ts",
      "/demo/config.json",
      "/demo/Dockerfile",
      "/demo/note.md",
      "/demo/alpha/one.md",
      "/demo/alpha/Two.TXT",
      "/demo/Zeta/readme.md"
    ]);
  });

  it("listFolderTree 返回带 children 的树，目录 children 非空", async () => {
    const { value } = await call(() => api.listFolderTree("/demo"));
    expect(value.name).toBe("demo");
    expect(value.path).toBe("/demo");
    expect(value.is_dir).toBe(true);
    const alpha = value.children!.find((c) => c.name === "alpha")!;
    expect(alpha.is_dir).toBe(true);
    expect(alpha.children!.map((c) => c.name)).toEqual(["one.md", "Two.TXT"]);
    const note = value.children!.find((c) => c.name === "note.md")!;
    expect(note.is_dir).toBe(false);
    expect(note.children).toBeNull();
  });
});

describe("最近文件", () => {
  it("pushRecent 去重置顶，listRecent 返回副本，clearRecent 清空", async () => {
    const { mock: m } = await call(() => api.pushRecent("/demo/note.md"));
    await api.pushRecent("/demo/a.cpp");
    await api.pushRecent("/demo/note.md");
    expect(m.recent.map((r) => r.path)).toEqual(["/demo/note.md", "/demo/a.cpp"]);
    const listed = await api.listRecent();
    expect(listed.map((r) => r.name)).toEqual(["note.md", "a.cpp"]);
    listed.length = 0;
    expect((await api.listRecent()).length).toBe(2);
    await api.clearRecent();
    expect(await api.listRecent()).toEqual([]);
  });

  it("最近列表上限 20 条，超出后丢弃最旧", async () => {
    const { mock: m } = await call(() => api.pushRecent("/demo/note.md"));
    for (let i = 0; i < 25; i++) await api.pushRecent(`/demo/f${i}.txt`);
    expect(m.recent).toHaveLength(20);
    expect(m.recent[0].path).toBe("/demo/f24.txt");
    expect(m.recent[19].path).toBe("/demo/f5.txt");
  });
});

describe("错误传递", () => {
  it("后端以字符串拒绝时原样抛出，供 UI 直接展示", async () => {
    mock = installTauriMock({ fs: demoFs() });
    await expect(api.readTextFile("/demo/missing.md")).rejects.toThrow(
      "系统找不到指定的文件。(os error 2): /demo/missing.md"
    );
    await expect(api.createFile("/demo/note.md")).rejects.toThrow("目标已存在");
    await expect(api.renamePath("/demo/note.md", "/demo/a.cpp")).rejects.toThrow("目标名称已存在");
    await expect(api.copyPath("/demo/none.md", "/demo/c.md")).rejects.toThrow("源路径不存在");
    await expect(api.deletePath("/demo/none.md")).rejects.toThrow("路径不存在");
  });

  it("可用 fail 让命令持续失败，模拟磁盘/权限错误", async () => {
    const { mock: m } = await call(() => api.pathExists("/demo"));
    m.fail("write_text_file", "权限不足");
    await expect(api.writeTextFile("/demo/note.md", "x", "UTF-8", "\n")).rejects.toThrow("权限不足");
    expect(m.lastCall("write_text_file")?.args.content).toBe("x");
  });

  it("拒绝值是裸字符串而非 Error 包装", async () => {
    mock = installTauriMock({ fs: demoFs() });
    const reason = await api.createFile("/demo/note.md").catch((e) => e);
    expect(typeof reason).toBe("string");
    expect(String(reason)).toBe("目标已存在");
  });
});

describe("mock 与 Rust 文件层行为对齐", () => {
  it("行尾统计与 Rust 同规则：裸 CR 占多数才算 CR，平局按 LF", () => {
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(detectLineEnding("a\nb\n")).toBe("\n");
    expect(detectLineEnding("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectLineEnding("a\r\nb\nc\r\nd\n")).toBe("\n");
    expect(detectLineEnding("a\rb\rc")).toBe("\r");
    expect(detectLineEnding("a\rb\r\n")).toBe("\r\n");
    expect(detectLineEnding("")).toBe("\n");
    expect(detectLineEnding("only line")).toBe("\n");
  });

  it("按目标行尾保存前先归一，重复保存不会叠加 \\r\\r\\n", () => {
    expect(applyLineEnding("x\r\ny\r\n", "\r\n")).toBe("x\r\ny\r\n");
    expect(applyLineEnding("x\ny\n", "\r")).toBe("x\ry\r");
    expect(applyLineEnding("x\ry\r", "\n")).toBe("x\ny\n");
    const once = applyLineEnding("x\ny", "\r\n");
    expect(applyLineEnding(once, "\r\n")).toBe(once);
  });

  it("读取上报的行尾与内容归一化互不影响", async () => {
    mock = installTauriMock({ fs: { "/demo/cr.txt": "x\ry\rz" } });
    const fc = await api.readTextFile("/demo/cr.txt");
    expect(fc.line_ending).toBe("\r");
    expect(fc.content).toBe("x\ny\nz");
    expect(fc.size).toBe(5);
  });
});
