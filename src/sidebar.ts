import {
  listFolderTree,
  createFile,
  createDir,
  renamePath,
  deletePath,
  copyPath,
  pathExists,
  revealInFileManager,
  type TreeNode
} from "./api";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { IS_MAC, mod } from "./platform";
import { cfg, saveConfig } from "./config";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { chevronSvg, fileIconSvg, folderClosedSvg, folderOpenSvg } from "./icons";

export interface FlatFile {
  name: string;
  path: string;
}

export interface SidebarHooks {
  onCreated: (path: string) => void;
  onRenamed: (from: string, to: string) => void;
  onDeleted: (path: string) => void;
  /** 从工作区摘掉一个根文件夹：调用方负责关掉该文件夹下已打开的标签 */
  onCloseFolder: (dir: string) => void;
}

type Pending =
  | { kind: "create"; dir: string; isDir: boolean; value: string }
  | { kind: "rename"; node: TreeNode; value: string };

type CtxAdd = (
  label: string,
  fn: () => void,
  opts?: { hint?: string; danger?: boolean; disabled?: boolean }
) => void;

let fileClipboard: { paths: string[]; cut: boolean } | null = null;

const REVEAL_LABEL = IS_MAC
  ? "在访达中显示"
  : /Windows/i.test(navigator.userAgent)
    ? "在资源管理器中显示"
    : "在文件管理器中显示";

const COLLAPSE_ALL_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5 8 2.5l4.5 4"/><path d="M3.5 12.5 8 8.5l4.5 4"/></svg>';
const EXPAND_ALL_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2.5 8 6.5l4.5-4"/><path d="M3.5 8.5 8 12.5l4.5-4"/></svg>';

function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

/** 内联新建的默认名：文件带 .txt 保证打开即是纯文本，目录不带后缀 */
export const NEW_FILE_BASE = "新建文件.txt";
export const NEW_DIR_BASE = "新建文件夹";

/** 重名时在名称后追加递增编号；文件把编号插在扩展名之前，保住后缀 */
export function numberedName(base: string, n: number): string {
  if (n <= 1) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return `${stem} ${n}${ext}`;
}

export class Sidebar {
  private folders: string[] = [...cfg.folders];
  private trees = new Map<string, TreeNode>();
  private expanded = new Set<string>(this.folders);
  private files: FlatFile[] = [];
  private ctxMenu: HTMLElement | null = null;
  private pending: Pending | null = null;
  private committing = false;
  private selectedPath: string | null = null;
  /** 只有用户亲手点选/键盘移到的行才算「手动选中」；启动恢复、新建后的自动高亮不算 */
  private manualPath: string | null = null;
  private active = false;
  private dragPath: string | null = null;
  private rowEls = new Map<string, HTMLElement>();
  private nodeIndex = new Map<string, { node: TreeNode; isRoot: boolean }>();
  private visibleRows: string[] = [];
  private ready: Promise<void>;

  constructor(
    private el: HTMLElement,
    private treeEl: HTMLElement,
    private onOpenFile: (path: string, preview: boolean) => void,
    private onAddFolder: () => void,
    private hooks: SidebarHooks
  ) {
    el.querySelector<HTMLButtonElement>("#sidebar-add")!.addEventListener("click", onAddFolder);
    el.querySelector<HTMLButtonElement>("#sidebar-newfile")?.addEventListener("click", () =>
      this.newAtTarget(false)
    );
    el.querySelector<HTMLButtonElement>("#sidebar-newfolder")?.addEventListener("click", () =>
      this.newAtTarget(true)
    );
    el.querySelector<HTMLButtonElement>("#sidebar-refresh")?.addEventListener("click", () => {
      void this.refresh();
    });
    el.querySelector<HTMLButtonElement>("#sidebar-collapse")?.addEventListener("click", () => {
      if (this.expanded.size > 0) this.collapseAll();
      else this.expandAll();
      this.render();
    });
    // 行自身的右键菜单已 stopPropagation，冒泡到这里的只有空白区
    treeEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.treeEl.focus({ preventScroll: true });
      this.showBlankCtx(e.clientX, e.clientY);
    });
    document.addEventListener("click", () => this.closeCtx());
    treeEl.tabIndex = -1;
    document.addEventListener("mousedown", (e) => {
      const t = e.target as Node;
      this.active = this.el.contains(t) || !!this.ctxMenu?.contains(t);
    });
    document.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.ready = this.refresh();
  }

  /** 目录树整体折叠时按钮显示「展开全部」，反之显示「折叠全部」 */
  private syncCollapseBtn() {
    const btn = this.el.querySelector<HTMLElement>("#sidebar-collapse");
    if (!btn) return;
    const collapsed = this.expanded.size === 0;
    btn.title = collapsed ? "展开全部" : "折叠全部";
    btn.innerHTML = collapsed ? EXPAND_ALL_ICON : COLLAPSE_ALL_ICON;
  }

  private collapseAll() {
    this.expanded.clear();
  }

  private expandAll() {
    const walk = (node: TreeNode) => {
      if (!node.is_dir) return;
      this.expanded.add(node.path);
      node.children?.forEach(walk);
    };
    for (const dir of this.folders) {
      this.expanded.add(dir);
      const tree = this.trees.get(dir);
      if (tree) walk(tree);
    }
  }

  /** 展开目标文件所在的各级目录并选中它，用于启动时把上次编辑的文件亮出来 */
  async focusFile(path: string) {
    await this.ready;
    const root = this.folders.find((f) => path === f || path.startsWith(f + "/") || path.startsWith(f + "\\"));
    if (!root) return;
    this.expanded.add(root);
    let cur = root;
    const parts = path.slice(root.length + 1).split(/[\\/]/);
    for (const part of parts.slice(0, -1)) {
      cur = joinPath(cur, part);
      this.expanded.add(cur);
    }
    this.render();
    this.select(path, true);
  }

  get visible(): boolean {
    return !this.el.classList.contains("hidden");
  }

  toggle() {
    this.el.classList.toggle("hidden");
    cfg.sidebarVisible = this.visible;
    saveConfig();
  }

  /** 已挂载文件夹以配置文件为准：侧边栏内部保留同一份数组引用，赋值即同步 */
  private saveFolders() {
    cfg.folders = this.folders;
    saveConfig();
  }

  async addFolder(dir: string) {
    if (!this.folders.includes(dir)) {
      this.folders.push(dir);
      this.expanded.add(dir);
      this.saveFolders();
    }
    await this.refresh();
    if (!this.visible) this.el.classList.remove("hidden");
  }

  private removeFolder(dir: string) {
    this.folders = this.folders.filter((f) => f !== dir);
    this.trees.delete(dir);
    this.expanded.delete(dir);
    this.saveFolders();
    this.render();
    void this.hooks.onCloseFolder(dir);
  }

  async refresh() {
    for (const dir of [...this.folders]) {
      try {
        this.trees.set(dir, await listFolderTree(dir));
      } catch {
        this.folders = this.folders.filter((f) => f !== dir);
        this.trees.delete(dir);
      }
    }
    this.saveFolders();
    this.collectFiles();
    this.render();
  }

  private collectFiles() {
    this.files = [];
    const walk = (node: TreeNode) => {
      if (!node.is_dir) {
        this.files.push({ name: node.name, path: node.path });
      } else if (node.children) {
        node.children.forEach(walk);
      }
    };
    for (const dir of this.folders) {
      const t = this.trees.get(dir);
      if (t) walk(t);
    }
  }

  flatFiles(): FlatFile[] {
    return this.files;
  }

  /* ---------- selection & keyboard ---------- */

  private select(path: string | null, scroll = false, manual = false) {
    this.selectedPath = path;
    if (manual) this.manualPath = path;
    for (const [p, el] of this.rowEls) el.classList.toggle("selected", p === path);
    if (scroll && path) this.rowEls.get(path)?.scrollIntoView({ block: "nearest" });
  }

  private toggleDir(path: string) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
    this.render();
  }

  private targetDir(): string | null {
    // 没手动选过任何行时落在第一个已打开文件夹的根（第一级），不跟随启动恢复/自动高亮
    const sel = this.manualPath && this.nodeIndex.has(this.manualPath) ? this.manualPath : null;
    if (sel) {
      const info = this.nodeIndex.get(sel)!;
      return info.node.is_dir ? info.node.path : parentDir(info.node.path);
    }
    return this.folders[0] ?? null;
  }

  /** 顶部按钮与空白区右键共用的新建入口：按当前落点新建，没有已打开文件夹时转为打开文件夹 */
  private newAtTarget(isDir: boolean) {
    const dir = this.targetDir();
    if (dir) void this.startCreate(dir, isDir);
    else this.onAddFolder();
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      this.closeCtx();
      return;
    }
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
    if (!this.visible || (!this.active && !this.el.contains(document.activeElement))) return;
    const mod = e.metaKey || e.ctrlKey;
    const info = this.selectedPath ? this.nodeIndex.get(this.selectedPath) : undefined;
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "c" && this.selectedPath) {
        e.preventDefault();
        this.setClipboard([this.selectedPath], false);
        return;
      }
      if (k === "x" && this.selectedPath && info && !info.isRoot) {
        e.preventDefault();
        this.setClipboard([this.selectedPath], true);
        return;
      }
      if (k === "v") {
        e.preventDefault();
        void this.paste();
        return;
      }
    }
    if (e.key === "F2" && info && !info.isRoot) {
      e.preventDefault();
      this.startRename(info.node);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && info && !info.isRoot) {
      e.preventDefault();
      void this.remove(info.node);
      return;
    }
    if (e.key === "Enter" && info) {
      e.preventDefault();
      if (info.node.is_dir) {
        this.toggleDir(info.node.path);
      } else {
        // 回车等同于双击，固定打开而不是预览
        this.onOpenFile(info.node.path, false);
      }
      return;
    }
    if (e.key === "ArrowRight" && info) {
      e.preventDefault();
      if (!info.node.is_dir) return;
      if (!this.expanded.has(info.node.path)) this.toggleDir(info.node.path);
      else {
        const first = info.node.children?.[0];
        if (first) this.select(first.path, true, true);
      }
      return;
    }
    if (e.key === "ArrowLeft" && info) {
      e.preventDefault();
      if (info.node.is_dir && this.expanded.has(info.node.path)) {
        this.toggleDir(info.node.path);
        return;
      }
      if (!info.isRoot) this.select(parentDir(info.node.path), true, true);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (this.visibleRows.length === 0) return;
      e.preventDefault();
      const idx = this.selectedPath ? this.visibleRows.indexOf(this.selectedPath) : -1;
      const next =
        e.key === "ArrowDown"
          ? Math.min(idx + 1, this.visibleRows.length - 1)
          : Math.max(idx - 1, 0);
      this.select(this.visibleRows[next], true, true);
    }
  }

  /* ---------- inline create / rename ---------- */

  private async startCreate(dir: string, isDir: boolean) {
    this.pending = { kind: "create", dir, isDir, value: await this.freeName(dir, isDir) };
    this.expanded.add(dir);
    this.render();
  }

  /** 逐个试默认名 + 递增编号，直到磁盘上真的没有同名项（树只列文本文件，二进制/隐藏文件靠后端挡） */
  private async freeName(dir: string, isDir: boolean): Promise<string> {
    const base = isDir ? NEW_DIR_BASE : NEW_FILE_BASE;
    for (let n = 1; n <= 999; n++) {
      const name = numberedName(base, n);
      let exists = false;
      try {
        exists = await pathExists(joinPath(dir, name));
      } catch {
        exists = false;
      }
      if (!exists) return name;
    }
    return numberedName(base, 1000);
  }

  private startRename(node: TreeNode) {
    this.pending = { kind: "rename", node, value: node.name };
    this.render();
  }

  private cancelPending() {
    this.pending = null;
    this.render();
  }

  private makeInput(p: Pending): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "tree-input";
    input.spellcheck = false;
    input.value = p.value;
    // 行的 click 会 treeEl.focus() 抢走焦点，触发输入框 blur 立即提交；
    // 挡住冒泡，点击名称才能正常定位光标/选词/右键编辑，而不是刚点开就保存
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("dblclick", (e) => e.stopPropagation());
    input.addEventListener("contextmenu", (e) => e.stopPropagation());
    input.addEventListener("input", () => {
      p.value = input.value;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.commitPending();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.cancelPending();
      }
    });
    input.addEventListener("blur", () => {
      if (this.pending === p && !this.committing) void this.commitPending();
    });
    return input;
  }

  private focusPendingInput() {
    requestAnimationFrame(() => {
      const p = this.pending;
      if (!p) return;
      const input = this.treeEl.querySelector<HTMLInputElement>(".tree-input");
      if (!input) return;
      input.focus();
      const isDir = p.kind === "rename" ? p.node.is_dir : p.isDir;
      const dot = input.value.lastIndexOf(".");
      const end = dot > 0 && !isDir ? dot : input.value.length;
      input.setSelectionRange(0, end);
    });
  }

  private async commitPending(): Promise<void> {
    const p = this.pending;
    if (!p || this.committing) return;
    const input = this.treeEl.querySelector<HTMLInputElement>(".tree-input");
    const value = (input ? input.value : p.value).trim();
    if (!value) {
      this.cancelPending();
      return;
    }
    const badSep = p.kind === "rename" ? /[\\/]/.test(value) : value.includes("\\");
    if (badSep) {
      await message("名称不能包含路径分隔符", { title: "名称无效", kind: "error" });
      this.render();
      return;
    }
    this.committing = true;
    try {
      if (p.kind === "create") {
        const path = joinPath(p.dir, value);
        if (p.isDir) await createDir(path);
        else await createFile(path);
        this.pending = null;
        this.expanded.add(p.dir);
        if (p.isDir) this.expanded.add(path);
        await this.refresh();
        this.select(path, true);
        if (!p.isDir) this.hooks.onCreated(path);
      } else {
        if (value === p.node.name) {
          this.pending = null;
          this.render();
          return;
        }
        const to = joinPath(parentDir(p.node.path), value);
        await renamePath(p.node.path, to);
        this.pending = null;
        this.migrateExpanded(p.node.path, to);
        await this.refresh();
        this.select(to, true);
        this.hooks.onRenamed(p.node.path, to);
      }
    } catch (e) {
      await message(String(e), {
        title: p.kind === "create" ? "新建失败" : "重命名失败",
        kind: "error"
      });
      this.render();
    } finally {
      this.committing = false;
    }
  }

  private migrateExpanded(from: string, to: string) {
    for (const p of [...this.expanded]) {
      if (p === from) {
        this.expanded.delete(p);
        this.expanded.add(to);
      } else if (p.startsWith(from + "/") || p.startsWith(from + "\\")) {
        this.expanded.delete(p);
        this.expanded.add(to + p.slice(from.length));
      }
    }
  }

  /* ---------- clipboard: cut / copy / paste ---------- */

  private setClipboard(paths: string[], cut: boolean) {
    fileClipboard = { paths, cut };
    this.render();
  }

  private canNest(src: string, destDir: string): boolean {
    return src !== destDir && !destDir.startsWith(src + "/") && !destDir.startsWith(src + "\\");
  }

  private canMove(src: string, destDir: string): boolean {
    return this.canNest(src, destDir) && parentDir(src) !== destDir;
  }

  private async suffixName(dir: string, name: string): Promise<string> {
    const dot = name.lastIndexOf(".");
    const hasExt = dot > 0;
    const base = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : "";
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? `${base} copy${ext}` : `${base} copy ${n}${ext}`;
      const p = joinPath(dir, candidate);
      if (!(await pathExists(p))) return p;
    }
    throw new Error("无法生成不重复的名称");
  }

  private async paste(targetDir?: string): Promise<void> {
    const clip = fileClipboard;
    if (!clip || clip.paths.length === 0) return;
    const dir = targetDir ?? this.targetDir();
    if (!dir) return;
    let moved = false;
    for (const src of clip.paths) {
      if (!this.canNest(src, dir)) {
        await message("不能将项目粘贴到其自身内部", { title: "粘贴失败", kind: "error" });
        continue;
      }
      try {
        let dest = joinPath(dir, baseName(src));
        if (await pathExists(dest)) dest = await this.suffixName(dir, baseName(src));
        if (clip.cut) {
          await renamePath(src, dest);
          this.migrateExpanded(src, dest);
          this.hooks.onRenamed(src, dest);
          moved = true;
        } else {
          await copyPath(src, dest);
        }
      } catch (e) {
        await message(String(e), { title: "粘贴失败", kind: "error" });
      }
    }
    if (clip.cut && moved) fileClipboard = null;
    this.expanded.add(dir);
    await this.refresh();
  }

  private async copyPathText(path: string, relative: boolean): Promise<void> {
    let text = path;
    if (relative) {
      const root = this.folders.find(
        (f) => path === f || path.startsWith(f + "/") || path.startsWith(f + "\\")
      );
      if (root) text = path === root ? baseName(path) : path.slice(root.length + 1);
    }
    try {
      await writeText(text);
    } catch (e) {
      await message(String(e), { title: "复制路径失败", kind: "error" });
    }
  }

  private async reveal(path: string): Promise<void> {
    try {
      await revealInFileManager(path);
    } catch (e) {
      await message(String(e), { title: "打开文件管理器失败", kind: "error" });
    }
  }

  /* ---------- delete / drag-drop move ---------- */

  private async remove(node: TreeNode) {
    const ok = await ask(
      `确定删除 "${node.name}" 吗？${node.is_dir ? "文件夹及其内容将" : "将"}移入回收站。`,
      { title: "删除确认", kind: "warning", okLabel: "删除", cancelLabel: "取消" }
    );
    if (!ok) return;
    try {
      await deletePath(node.path);
      await this.refresh();
      this.hooks.onDeleted(node.path);
    } catch (e) {
      await message(String(e), { title: "删除失败", kind: "error" });
    }
  }

  private async movePaths(srcs: string[], destDir: string): Promise<void> {
    const valid = srcs.filter((s) => this.canMove(s, destDir));
    if (valid.length === 0) return;
    const names = valid.map(baseName).join("、");
    const ok = await ask(`确定将 ${names} 移动到 "${baseName(destDir)}" 吗？`, {
      title: "移动确认",
      kind: "info",
      okLabel: "移动",
      cancelLabel: "取消"
    });
    if (!ok) return;
    for (const src of valid) {
      const dest = joinPath(destDir, baseName(src));
      try {
        await renamePath(src, dest);
        this.migrateExpanded(src, dest);
        this.hooks.onRenamed(src, dest);
        this.selectedPath = dest;
      } catch (e) {
        await message(String(e), { title: "移动失败", kind: "error" });
      }
    }
    this.expanded.add(destDir);
    await this.refresh();
  }

  /* ---------- context menu ---------- */

  private closeCtx() {
    this.ctxMenu?.remove();
    this.ctxMenu = null;
  }

  /** 右键菜单统一外壳：创建、填充、挂载、定位并登记，节点菜单与空白区菜单共用同一套视觉与关闭逻辑 */
  private openCtx(x: number, y: number, fill: (add: CtxAdd, sep: () => void) => void) {
    this.closeCtx();
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    const add: CtxAdd = (label, fn, opts = {}) => {
      const item = document.createElement("div");
      item.className =
        "ctx-item" + (opts.danger ? " ctx-danger" : "") + (opts.disabled ? " disabled" : "");
      const text = document.createElement("span");
      text.textContent = label;
      item.appendChild(text);
      if (opts.hint) {
        const hint = document.createElement("span");
        hint.className = "ctx-hint";
        hint.textContent = opts.hint;
        item.appendChild(hint);
      }
      if (!opts.disabled) {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeCtx();
          fn();
        });
      }
      menu.appendChild(item);
    };
    const sep = () => {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      menu.appendChild(s);
    };
    fill(add, sep);
    document.body.appendChild(menu);
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
    menu.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";
    this.ctxMenu = menu;
  }

  private showCtx(x: number, y: number, node: TreeNode, isRoot: boolean) {
    this.openCtx(x, y, (add, sep) => {
      if (node.is_dir) {
        add("新建文件…", () => this.startCreate(node.path, false));
        add("新建文件夹…", () => this.startCreate(node.path, true));
        sep();
      }
      if (!isRoot) {
        add("剪切", () => this.setClipboard([node.path], true), { hint: mod("X") });
        add("复制", () => this.setClipboard([node.path], false), { hint: mod("C") });
      }
      add("粘贴", () => this.paste(node.is_dir ? node.path : parentDir(node.path)), {
        hint: mod("V"),
        disabled: !fileClipboard
      });
      sep();
      add("复制路径", () => this.copyPathText(node.path, false));
      if (!isRoot) add("复制相对路径", () => this.copyPathText(node.path, true));
      add(REVEAL_LABEL, () => this.reveal(node.path));
      sep();
      add("刷新", () => this.refresh());
      if (isRoot) {
        add("关闭文件夹", () => this.removeFolder(node.path));
      } else {
        add("重命名…", () => this.startRename(node), { hint: "F2" });
        add("删除", () => this.remove(node), {
          hint: IS_MAC ? "⌘⌫" : "Delete",
          danger: true
        });
      }
    });
  }

  /** 空白区右键：与顶部「新建文件夹/新建文件」按钮完全一致，落点同样走 targetDir()，顺序也与工具栏一致 */
  private showBlankCtx(x: number, y: number) {
    this.openCtx(x, y, (add, sep) => {
      add("新建文件夹…", () => this.newAtTarget(true));
      add("新建文件…", () => this.newAtTarget(false));
      sep();
      add("刷新", () => this.refresh());
    });
  }

  /* ---------- rendering ---------- */

  private render() {
    this.treeEl.innerHTML = "";
    this.rowEls.clear();
    this.nodeIndex.clear();
    this.visibleRows = [];
    this.syncCollapseBtn();
    if (this.folders.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "没有打开的文件夹\n点击上方“打开文件夹”按钮选择目录";
      this.treeEl.appendChild(empty);
      return;
    }
    for (const dir of this.folders) {
      const tree = this.trees.get(dir);
      if (!tree) continue;
      this.treeEl.appendChild(this.row(tree, true));
      if (this.expanded.has(dir)) {
        const p = this.pending;
        if (p && p.kind === "create" && p.dir === dir) {
          this.treeEl.appendChild(this.createInputRow(1, p));
        }
        if (tree.children) {
          for (const child of tree.children) {
            this.treeEl.appendChild(this.renderNode(child, 1));
          }
        }
      }
    }
    if (this.selectedPath && !this.nodeIndex.has(this.selectedPath)) this.selectedPath = null;
    if (this.pending) this.focusPendingInput();
  }

  private renderNode(node: TreeNode, depth: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.appendChild(this.row(node, false, depth));
    if (node.is_dir && this.expanded.has(node.path)) {
      const p = this.pending;
      if (p && p.kind === "create" && p.dir === node.path) {
        wrap.appendChild(this.createInputRow(depth + 1, p));
      }
      if (node.children) {
        for (const child of node.children) {
          wrap.appendChild(this.renderNode(child, depth + 1));
        }
      }
    }
    return wrap;
  }

  private createInputRow(depth: number, p: Extract<Pending, { kind: "create" }>): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.setProperty("--d", String(depth));
    const caret = document.createElement("span");
    caret.className = "tree-caret";
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = p.isDir ? folderClosedSvg : fileIconSvg(p.value);
    row.append(caret, icon, this.makeInput(p));
    return row;
  }

  private row(node: TreeNode, isRoot: boolean, depth = 0): HTMLElement {
    this.nodeIndex.set(node.path, { node, isRoot });
    this.visibleRows.push(node.path);
    const isOpenDir = node.is_dir && this.expanded.has(node.path);
    const row = document.createElement("div");
    row.className = "tree-row" + (isRoot ? " tree-root" : "");
    if (node.path === this.selectedPath) row.classList.add("selected");
    if (fileClipboard?.cut && fileClipboard.paths.includes(node.path)) row.classList.add("cut");
    row.style.setProperty("--d", String(depth));
    const caret = document.createElement("span");
    caret.className = "tree-caret" + (isOpenDir ? " open" : "");
    if (node.is_dir) caret.innerHTML = chevronSvg;
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    if (node.is_dir) {
      icon.className += isOpenDir ? " tree-icon-dir open" : " tree-icon-dir";
      icon.innerHTML = isOpenDir ? folderOpenSvg : folderClosedSvg;
    } else {
      icon.innerHTML = fileIconSvg(node.name);
    }
    const p = this.pending;
    if (p && p.kind === "rename" && p.node.path === node.path) {
      row.append(caret, icon, this.makeInput(p));
    } else {
      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = node.name;
      label.title = node.path;
      row.append(caret, icon, label);
    }
    this.rowEls.set(node.path, row);
    row.addEventListener("click", () => {
      this.select(node.path, false, true);
      this.treeEl.focus({ preventScroll: true });
      if (node.is_dir) this.toggleDir(node.path);
      else this.onOpenFile(node.path, true);
    });
    row.addEventListener("dblclick", () => {
      if (!node.is_dir) this.onOpenFile(node.path, false);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.select(node.path, false, true);
      this.treeEl.focus({ preventScroll: true });
      this.showCtx(e.clientX, e.clientY, node, isRoot);
    });

    const renaming = !!p && p.kind === "rename" && p.node.path === node.path;
    row.draggable = !renaming;
    row.addEventListener("dragstart", (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      dt.setData("application/x-rnp-path", node.path);
      dt.effectAllowed = "move";
      this.dragPath = node.path;
    });
    row.addEventListener("dragend", () => {
      this.dragPath = null;
      this.treeEl.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    });
    const targetDir = node.is_dir ? node.path : parentDir(node.path);
    row.addEventListener("dragover", (e) => {
      const src = this.dragPath;
      if (!src || !this.canMove(src, targetDir)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      const src = this.dragPath || e.dataTransfer?.getData("application/x-rnp-path");
      row.classList.remove("drag-over");
      if (!src || !this.canMove(src, targetDir)) return;
      e.preventDefault();
      e.stopPropagation();
      void this.movePaths([src], targetDir);
    });
    return row;
  }
}