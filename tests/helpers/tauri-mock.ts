/**
 * Tauri 后端模拟：用内存虚拟文件系统实现 src-tauri 暴露的全部命令，
 * 语义对齐 Rust 侧（编码、换行、目录树排序、最近文件），让前端测试可以
 * 在不启动原生窗口的情况下驱动完整应用。
 */

import { version } from "../../package.json";

export type FsEntry = { kind: "dir" } | { kind: "file"; content: string };

export interface MockTreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: MockTreeNode[] | null;
}

export interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

export interface DialogAnswers {
  open: Array<string | null>;
  save: Array<string | null>;
  ask: boolean[];
}

/** 与 Rust 的 read_text_file 一致：编辑器内统一用 \n */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 与 Rust 的 detect_line_ending 一致：裸 \r 占多数才算 CR，其余按 CRLF/LF 多少判定 */
export function detectLineEnding(text: string): "\n" | "\r\n" | "\r" {
  let crlf = 0;
  let cr = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\r") {
      if (text[i + 1] === "\n") {
        crlf++;
        i++;
      } else cr++;
    } else if (text[i] === "\n") lf++;
  }
  if (cr > crlf && cr > lf) return "\r";
  return crlf > lf ? "\r\n" : "\n";
}

/** 与 Rust 修复后的 write_text_file 一致：先归一再展开，重复保存不会叠加成 \r\r\n */
export function applyLineEnding(text: string, le: string): string {
  const lf = toLf(text);
  return le === "\r\n" ? lf.replace(/\n/g, "\r\n") : le === "\r" ? lf.replace(/\n/g, "\r") : lf;
}

export interface TauriMockOptions {
  /** 初始虚拟文件系统：值为 null 表示目录，字符串表示文本内容 */
  fs?: Record<string, string | null>;
  dialogs?: Partial<DialogAnswers>;
  /** 是否像 Rust 一样只保留常见文本文件（默认开启） */
  textFilter?: boolean;
  /** 初始最近打开列表，用于验证欢迎页 */
  recent?: string[];
  /**
   * 与 Rust 的 EDIT_SIZE_LIMIT 对齐的超大文件阈值（字节）。
   * 用例可以用小阈值触发只读逻辑，避免在 jsdom 里真的造几十兆文本。
   */
  largeFileLimit?: number;
  /**
   * 配置文件初始内容（应用目录那份 JSON，macOS 是 `~/.rocketnote`）；字符串按原样写入，
   * 对象会序列化。不给则视为文件还不存在，前端会走 localStorage 迁移分支。
   */
  config?: string | Record<string, unknown>;
  /** 哪些语言已装格式化工具（默认六种外部语言全可用）；用于菜单禁用/缺失提示测试 */
  availableFormatters?: string[];
  /** 自定义 format_document 的返回；默认做「去行尾空白 + 单一末尾换行」的确定性变换 */
  format?: (lang: string, content: string) => string;
  /** 初始剪贴板文本，供粘贴测试 */
  clipboard?: string;
}

/** 与 Rust commands::config::CONFIG_FILE 对应的模拟路径（按 macOS 的默认位置模拟） */
export const APP_DIR = "/Users/maple/.rocketnote";
export const APP_CONFIG_PATH = `${APP_DIR}/rocketnotepad.config.json`;
export const APP_EXE_PATH = "/Applications/RocketNotePad.app/Contents/MacOS/rocketnotepad";
export const STARTUP_LOG_PATH = "/Users/maple/.rocketnote/rocketnotepad.startup.log";

/** 与 Rust files.rs 的 EDIT_SIZE_LIMIT 一致 */
export const EDIT_SIZE_LIMIT = 8 * 1024 * 1024;

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "mdown", "mkd", "log", "json", "jsonc", "yaml", "yml", "toml",
  "ini", "conf", "cfg", "properties", "xml", "svg", "csv", "tsv", "html", "htm", "css",
  "scss", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rs", "go", "java", "kt",
  "c", "h", "cpp", "cc", "hpp", "cs", "swift", "php", "rb", "sh", "bash", "zsh", "ps1",
  "sql", "lua", "r", "pl", "proto", "cmake", "diff", "patch", "env", "editorconfig"
]);
const NO_EXT_NAMES = new Set([
  "dockerfile", "makefile", "readme", "license", "changelog", "todo", "authors", "gemfile"
]);

export function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
}

export function parentOf(p: string): string {
  const n = normalize(p);
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}

export function baseName(p: string): string {
  return normalize(p).split("/").pop() || p;
}

export function isTextCandidate(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(".")) return false;
  const dot = lower.lastIndexOf(".");
  if (dot > 0) return TEXT_EXT.has(lower.slice(dot + 1));
  return NO_EXT_NAMES.has(lower);
}

export class VirtualFs {
  entries = new Map<string, FsEntry>();
  textFilter: boolean;

  constructor(seed: Record<string, string | null> = {}, textFilter = true) {
    this.textFilter = textFilter;
    for (const [raw, value] of Object.entries(seed)) this.set(raw, value);
  }

  set(raw: string, value: string | null) {
    const p = normalize(raw);
    this.entries.set(p, value === null ? { kind: "dir" } : { kind: "file", content: value });
    let cur = p;
    let dir = parentOf(cur);
    while (dir !== cur && !this.entries.has(dir)) {
      this.entries.set(dir, { kind: "dir" });
      cur = dir;
      dir = parentOf(cur);
    }
  }
  setDir(raw: string) {
    const p = normalize(raw);
    if (!this.entries.has(p)) this.entries.set(p, { kind: "dir" });
  }

  exists(p: string) {
    return this.entries.has(normalize(p));
  }

  isDir(p: string) {
    return this.entries.get(normalize(p))?.kind === "dir";
  }

  content(p: string): string | undefined {
    const e = this.entries.get(normalize(p));
    return e && e.kind === "file" ? e.content : undefined;
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }

  children(dir: string): string[] {
    const d = normalize(dir);
    const out: string[] = [];
    for (const p of this.entries.keys()) {
      if (p !== d && parentOf(p) === d) out.push(p);
    }
    return this.sortLikeRust(out);
  }

  /** 与 Rust build_tree 一致：目录在前 + 忽略大小写 */
  sortLikeRust(paths: string[]): string[] {
    return [...paths].sort((a, b) => {
      const sa = this.isDir(a) ? 0 : 1;
      const sb = this.isDir(b) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const na = baseName(a).toLowerCase();
      const nb = baseName(b).toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
  }

  visibleChildren(dir: string): string[] {
    return this.children(dir)
      .filter((c) => !baseName(c).startsWith("."))
      .filter((c) => !this.textFilter || this.isDir(c) || isTextCandidate(baseName(c)));
  }

  tree(dir: string, depth = 0): MockTreeNode {
    const p = normalize(dir);
    const entry = this.entries.get(p);
    const isDir = entry ? entry.kind === "dir" : false;
    if (!isDir) {
      return { name: baseName(p), path: p, is_dir: false, children: null };
    }
    if (depth >= 6) {
      return { name: baseName(p), path: p, is_dir: true, children: [] };
    }
    return {
      name: baseName(p),
      path: p,
      is_dir: true,
      children: this.visibleChildren(p).map((c) => this.tree(c, depth + 1))
    };
  }

  /** 模拟 scan_dir：先本层文件，再递归子目录 */
  listText(dir: string, acc: string[] = [], depth = 0): string[] {
    if (depth > 4 || acc.length >= 200) return acc;
    const d = normalize(dir);
    for (const p of this.children(d)) {
      if (acc.length >= 200) return acc;
      if (this.isDir(p) || baseName(p).startsWith(".")) continue;
      if (this.textFilter && !isTextCandidate(baseName(p))) continue;
      acc.push(p);
    }
    for (const p of this.children(d)) {
      if (this.isDir(p) && !baseName(p).startsWith(".")) this.listText(p, acc, depth + 1);
    }
    return acc;
  }

  removeTree(p: string) {
    const n = normalize(p);
    for (const key of [...this.entries.keys()]) {
      if (key === n || key.startsWith(n + "/")) this.entries.delete(key);
    }
  }

  move(from: string, to: string) {
    const f = normalize(from);
    const t = normalize(to);
    const moved = [...this.entries].filter(([k]) => k === f || k.startsWith(f + "/"));
    for (const [key, value] of moved) {
      this.entries.delete(key);
      this.entries.set(t + key.slice(f.length), value);
    }
    this.setDir(parentOf(t));
  }

  copy(from: string, to: string) {
    const f = normalize(from);
    const t = normalize(to);
    for (const [key, value] of [...this.entries]) {
      if (key === f || key.startsWith(f + "/")) {
        this.entries.set(t + key.slice(f.length), { ...value });
      }
    }
  }

  snapshot(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const [key, value] of this.entries) {
      out[key] = value.kind === "dir" ? null : value.content;
    }
    return out;
  }
}

export interface RecentEntry {
  path: string;
  name: string;
  opened_at: number;
}

export interface TauriMock {
  fs: VirtualFs;
  calls: Call[];
  recent: RecentEntry[];
  dialogs: DialogAnswers;
  messages: Array<{ message: string; title?: string; kind?: string }>;
  /** 前端上报的启动里程碑，顺序与真实日志一致 */
  startupNotes: string[];
  /** 前端是否已宣告页面就绪 */
  pageReady(): boolean;
  /** 后端当前是不是「全程记录启动日志」，对应配置项 startupLog */
  startupLogEnabled(): boolean;
  /** 前端要求把攒下的里程碑补写落盘的次数 */
  startupLogFlushes(): number;
  /** 配置文件当前内容原文（null 表示文件不存在） */
  configText(): string | null;
  /** 配置文件解析后的对象，内容非法时为 null */
  configJson<T = Record<string, any>>(): T | null;
  /** 当前剪贴板文本（write_text 写入、read_text 读出） */
  clipboardText(): string;
  invokeLog(cmd: string): Call[];
  lastCall(cmd: string): Call | undefined;
  resetInvokeLog(): void;
  /** 让某个命令从下一次调用起持续失败，模拟后端报错 */
  fail(cmd: string, message: string): void;
  /** 撤销 fail，恢复命令的正常行为 */
  clearFailures(): void;
  /** 触发原生菜单等后端事件 */
  emit(event: string, payload?: unknown): void;
  listenerCount(event: string): number;
  uninstall(): void;
}

export function installTauriMock(options: TauriMockOptions = {}): TauriMock {
  const fs = new VirtualFs(options.fs ?? {}, options.textFilter ?? true);
  const largeFileLimit = options.largeFileLimit ?? EDIT_SIZE_LIMIT;
  const calls: Call[] = [];
  const recent: RecentEntry[] = (options.recent ?? []).map((p) => ({
    path: normalize(p),
    name: baseName(p),
    opened_at: Date.now()
  }));
  const messages: Array<{ message: string; title?: string; kind?: string }> = [];
  const startupNotes: string[] = [];
  let pageReady = false;
  let startupLogOn = false;
  let startupLogFlushes = 0;
  const dialogs: DialogAnswers = {
    open: [...(options.dialogs?.open ?? [])],
    save: [...(options.dialogs?.save ?? [])],
    ask: [...(options.dialogs?.ask ?? [])]
  };
  const callbacks = new Map<number, (arg: unknown) => void>();
  const listeners: Array<{ event: string; cbId: number; eventId: number }> = [];
  const failures = new Map<string, string>();
  let configText: string | null =
    options.config === undefined
      ? null
      : typeof options.config === "string"
        ? options.config
        : JSON.stringify(options.config);
  let nextId = 1;
  // 与后端 format.rs 的 candidates 首选工具一致
  const FORMATTER_TOOLS: Record<string, string> = {
    Rust: "rustfmt", Go: "gofmt", C: "clang-format", "C++": "clang-format", Java: "clang-format", Python: "black"
  };
  const availableFormatters = new Set(options.availableFormatters ?? Object.keys(FORMATTER_TOOLS));
  let clipboardText = options.clipboard ?? "";
  const defaultFormat = (content: string): string => {
    const trimmed = content.replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
    return trimmed.length ? trimmed + "\n" : "";
  };
  const previous = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

  const take = <T>(queue: T[], fallback: T): T => (queue.length > 0 ? (queue.shift() as T) : fallback);

  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    const a = args ?? {};
    calls.push({ cmd, args: a });
    const forced = failures.get(cmd);
    if (forced !== undefined) throw forced;
    const str = (k: string): string => String(a[k] ?? "");
    switch (cmd) {
      case "read_text_file": {
        const raw = fs.content(str("path"));
        if (raw === undefined) {
          throw `系统找不到指定的文件。(os error 2): ${str("path")}`;
        }
        const size = new TextEncoder().encode(raw).length;
        // 与 Rust 一致：报告主流行尾，但交给编辑器的内容统一用 \n
        return {
          content: toLf(raw),
          encoding: "UTF-8",
          line_ending: detectLineEnding(raw),
          size,
          large: size > largeFileLimit
        };
      }
      case "write_text_file": {
        const le = typeof a.lineEnding === "string" ? a.lineEnding : "\n";
        const content = applyLineEnding(String(a.content ?? ""), le);
        fs.set(str("path"), content);
        return {
          size: new TextEncoder().encode(content).length,
          modified: Date.now(),
          read_only: false,
          exists: true
        };
      }
      case "file_metadata": {
        const content = fs.content(str("path"));
        return {
          size: content === undefined ? 0 : new TextEncoder().encode(content).length,
          modified: Date.now(),
          read_only: false,
          exists: content !== undefined || fs.isDir(str("path"))
        };
      }
      case "is_directory":
        return fs.isDir(str("path"));
      case "path_exists":
        return fs.exists(str("path"));
      case "list_text_files":
        return fs.listText(str("dir"));
      case "list_folder_tree":
        return fs.tree(str("dir"));
      case "create_file": {
        if (fs.exists(str("path"))) throw "目标已存在";
        fs.set(str("path"), "");
        return null;
      }
      case "create_dir": {
        if (fs.exists(str("path"))) throw "目标已存在";
        fs.set(str("path"), null);
        return null;
      }
      case "rename_path": {
        if (!fs.exists(str("from"))) throw "源路径不存在";
        if (fs.exists(str("to"))) throw "目标名称已存在";
        fs.move(str("from"), str("to"));
        return null;
      }
      case "delete_path": {
        if (!fs.exists(str("path"))) throw "路径不存在";
        fs.removeTree(str("path"));
        return null;
      }
      case "copy_path": {
        if (!fs.exists(str("from"))) throw "源路径不存在";
        if (fs.exists(str("to"))) throw "目标已存在";
        fs.copy(str("from"), str("to"));
        return null;
      }
      case "reveal_in_file_manager":
        return null;
      case "formatter_status": {
        const tool = FORMATTER_TOOLS[str("lang")];
        if (!tool) return { available: false, tool: "" };
        return { available: availableFormatters.has(str("lang")), tool };
      }
      case "format_document": {
        const lang = str("lang");
        const tool = FORMATTER_TOOLS[lang];
        if (!tool) throw `暂不支持格式化 ${lang}`;
        if (!availableFormatters.has(lang)) throw `未找到格式化工具，请先安装并加入 PATH：${tool}`;
        const content = String(a.content ?? "");
        return options.format ? options.format(lang, content) : defaultFormat(content);
      }
      case "plugin:clipboard-manager|write_text":
        clipboardText = String(a.text ?? "");
        return null;
      case "plugin:clipboard-manager|read_text":
        return clipboardText;
      case "list_recent":
        return recent.map((r) => ({ ...r }));
      case "push_recent": {
        const p = str("path");
        const idx = recent.findIndex((r) => r.path === p);
        if (idx >= 0) recent.splice(idx, 1);
        recent.unshift({ path: p, name: baseName(p), opened_at: Date.now() });
        if (recent.length > 20) recent.length = 20;
        return null;
      }
      case "clear_recent":
        recent.length = 0;
        return null;
      case "read_app_config":
        return configText;
      case "app_info":
        return {
          version,
          os: "macos",
          arch: "aarch64",
          config_path: APP_CONFIG_PATH,
          config_dir: APP_DIR,
          config_exists: configText !== null,
          exe_path: APP_EXE_PATH
        };
      case "log_startup":
        startupNotes.push(String(a.message ?? ""));
        return null;
      case "mark_page_ready":
        pageReady = true;
        return null;
      case "set_startup_log": {
        startupLogOn = a.enabled === true;
        // 打开时后端把已攒的过程落盘并回位置，关闭时把文件收走
        return startupLogOn ? STARTUP_LOG_PATH : null;
      }
      case "flush_startup_log": {
        startupLogFlushes += 1;
        // 默认档下这一步就是「出问题了，把内存里的过程补写出来」
        return STARTUP_LOG_PATH;
      }
      case "write_app_config": {
        configText = String(a.content ?? "");
        return APP_CONFIG_PATH;
      }
      case "plugin:dialog|open":
        return take(dialogs.open, null);
      case "plugin:dialog|save":
        return take(dialogs.save, null);
      case "plugin:dialog|ask":
        return take(dialogs.ask, true);
      case "plugin:dialog|message": {
        // Tauri 2 的 ask()/confirm() 也走 message 命令，靠返回被点击的按钮文案判定
        const buttons = a.buttons as string | { ok?: string; cancel?: string } | undefined;
        if (buttons === undefined) {
          messages.push({
            message: str("message"),
            title: a.title === undefined ? undefined : String(a.title),
            kind: a.kind === undefined ? undefined : String(a.kind)
          });
          return "Ok";
        }
        const approved = take(dialogs.ask, true);
        // buttons 可能是 'YesNo' | 'OkCancel' | { OkCancelCustom: [ok, cancel] } 等 Rust 枚举序列化结果
        const labelPair = (b: Exclude<typeof buttons, undefined>): { ok: string; cancel: string } => {
          if (typeof b === "string") {
            return b === "YesNo" ? { ok: "Yes", cancel: "No" } : { ok: "Ok", cancel: "Cancel" };
          }
          const labels = Object.values(b)[0] as unknown as string[] | undefined;
          return { ok: labels?.[0] ?? "Yes", cancel: labels?.[1] ?? "No" };
        };
        const pair = labelPair(buttons);
        return approved ? pair.ok : pair.cancel;
      }
      case "plugin:event|listen": {
        const eventId = nextId++;
        listeners.push({ event: String(a.event ?? ""), cbId: Number(a.handler), eventId });
        return eventId;
      }
      case "plugin:event|unlisten": {
        const id = Number(a.eventId);
        for (let i = listeners.length - 1; i >= 0; i--) {
          if (listeners[i].eventId === id) listeners.splice(i, 1);
        }
        return null;
      }
      case "plugin:app|version":
        return "2.0.0";
      default:
        // plugin:menu|* / plugin:window|* / plugin:webview|* / plugin:event|emit 等
        return null;
    }
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (handler: unknown) => {
      const id = nextId++;
      callbacks.set(id, handler as (arg: unknown) => void);
      return id;
    },
    runCallback: (id: number, arg: unknown) => callbacks.get(id)?.(arg),
    metadata: {
      currentWebview: { label: "main" },
      currentWindow: { label: "main" },
      currentWebviewWindow: { label: "main" }
    },
    convertFileSrc: (p: string) => String(p),
    registerPlugin: () => undefined
  };
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => undefined
  };

  return {
    fs,
    calls,
    recent,
    dialogs,
    messages,
    startupNotes,
    pageReady: () => pageReady,
    startupLogEnabled: () => startupLogOn,
    startupLogFlushes: () => startupLogFlushes,
    configText: () => configText,
    configJson: <T,>(): T | null => {
      if (configText === null) return null;
      try {
        return JSON.parse(configText) as T;
      } catch {
        return null;
      }
    },
    clipboardText: () => clipboardText,
    invokeLog: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    lastCall: (cmd: string) => [...calls].reverse().find((c) => c.cmd === cmd),
    resetInvokeLog: () => {
      calls.length = 0;
    },
    fail: (cmd: string, message: string) => {
      failures.set(cmd, message);
    },
    clearFailures: () => {
      failures.clear();
    },
    emit: (event: string, payload?: unknown) => {
      for (const l of listeners.filter((x) => x.event === event)) {
        callbacks.get(l.cbId)?.({ event, id: l.eventId, payload });
      }
    },
    listenerCount: (event: string) => listeners.filter((l) => l.event === event).length,
    uninstall: () => {
      const w = window as unknown as Record<string, unknown>;
      if (previous === undefined) delete w.__TAURI_INTERNALS__;
      else w.__TAURI_INTERNALS__ = previous;
      delete w.__TAURI_EVENT_PLUGIN_INTERNALS__;
    }
  };
}

/** 演示用文件系统，供多个测试复用 */
export function demoFs(): Record<string, string | null> {
  return {
    "/demo": null,
    "/demo/alpha": null,
    "/demo/alpha/one.md": "# one\nfirst line\nsecond line\n",
    "/demo/alpha/Two.TXT": "two\n",
    "/demo/Zeta": null,
    "/demo/Zeta/readme.md": "# zeta\n",
    "/demo/note.md": "# 标题\n\n正文 one two three\n",
    "/demo/a.cpp": "int main() { return 0; }\n",
    "/demo/B.ts": "export const x: number = 1;\n",
    "/demo/config.json": "{\n  \"a\": 1\n}\n",
    "/demo/Dockerfile": "FROM rust:1\n"
  };
}
