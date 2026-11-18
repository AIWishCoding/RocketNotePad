import "./styles.css";
import { open as openDialog, save as saveDialog, ask, message } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { openSearchPanel, findNext, findPrevious } from "@codemirror/search";
import { openReplacePanel } from "./find";
import { altMod, ctrlOnly, mod, shiftMod } from "./platform";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  gotoLine,
  gotoLineNumber,
  createState,
  reconfigure,
  selectNextOccurrence
} from "./editor";
import { LANGUAGES, languageByLabel, languageForFile, type LangDef } from "./languages";
import { DEFAULT_FONT_SIZE, cfg, loadConfig, saveConfig, saveConfigNow } from "./config";
import { failStartup, markReady, note, traceCrashes, applyStartupLog } from "./startup";
import {
  readTextFile,
  writeTextFile,
  isDirectory,
  listTextFiles,
  listRecent,
  pushRecent,
  refreshSizeMenu,
  type RecentEntry
} from "./api";
import { Sidebar } from "./sidebar";
import { Minimap } from "./minimap";
import { MarkdownPreview } from "./preview";
import { openPalette, openGoto, type Command } from "./palette";
import { openFontPicker } from "./fontpicker";
import { APP_VERSION, openAbout } from "./about";
import { fontLabel, fontStack } from "./fonts";
import { showEditorContextMenu } from "./editmenu";
import { formatDocument, isFormatSupported } from "./format";

interface Tab {
  id: number;
  path: string | null;
  name: string;
  encoding: string;
  lineEnding: string;
  size: number;
  /** 后端判定为超大文件，只读打开 */
  readOnly: boolean;
  dirty: boolean;
  /** 每次文档变更自增，用于判断自动保存写入的内容是否已被后续编辑覆盖 */
  seq: number;
  saving: boolean;
  state: EditorState;
  /** 手动选择的语言标签；null 表示按扩展名自动判断 */
  lang: string | null;
  /** 预览标签（VS Code 语义）：单击文件临时占用，再次单击另一个文件会替换它 */
  preview: boolean;
}

/** 视图与编辑行为的可调项，全部落在配置文件的字段上 */
const settings = cfg;

/**
 * 字体面板试穿期间的临时外观。settings 就是要落盘的那份对象，试穿值不能写进去：
 * 试穿时切标签、切主题都会触发一次防抖落盘，会把没选定的字体一并写进配置文件。
 */
let look: { fontFamily: string; fontSize: number } | null = null;
const lookFamily = () => look?.fontFamily ?? settings.fontFamily;
const lookSize = () => look?.fontSize ?? settings.fontSize;

let tabs: Tab[] = [];
let activeId = -1;
let nextId = 1;
let untitledCount = 0;
let view: EditorView;
let sidebar: Sidebar;
let minimap: Minimap;
let preview: MarkdownPreview;

const AUTO_SAVE_DELAY = 1500;
let autoSaveTimer: number | undefined;
const autoSaveWarned = new Set<number>();

const $ = (id: string) => document.getElementById(id)!;

function activeTab(): Tab | undefined {
  return tabs.find((t) => t.id === activeId);
}

function persistSettings() {
  settings.restoreTabs = tabs.filter((t) => t.path).map((t) => t.path!);
  settings.restoreActive = activeTab()?.path ?? "";
  saveConfig();
}

function buildDOM() {
  document.getElementById("app")!.innerHTML = `
    <div id="main-area">
      <div id="sidebar">
        <div class="sidebar-header">
          <span>资源管理器</span>
          <span class="tb-spacer"></span>
          <button id="sidebar-add" title="打开文件夹"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4.2a1 1 0 0 1 1-1h2.7l1.5 1.7h6.3a1 1 0 0 1 1 1v1.1"/><path d="M1.35 12.55 2.7 7.75a1 1 0 0 1 .96-.72h10.15a1 1 0 0 1 .96 1.26l-1.3 4.5a1 1 0 0 1-.96.71H2.4a1 1 0 0 1-.96-.7 1 1 0 0 1-.09-.25Z"/></svg></button>
          <button id="sidebar-newfolder" title="新建文件夹"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 3.5a1 1 0 0 1 1-1h3L7 4.5h6.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9Z"/><path d="M8 7v4M6 9h4"/></svg></button>
          <button id="sidebar-newfile" title="新建文件"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5Z"/><path d="M9 1.5v4h4"/><path d="M8 8v4M6 10h4"/></svg></button>
          <button id="sidebar-refresh" title="刷新">⟳</button>
          <button id="sidebar-collapse" title="折叠全部"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5 8 2.5l4.5 4"/><path d="M3.5 12.5 8 8.5l4.5 4"/></svg></button>
        </div>
        <div id="sidebar-tree"></div>
      </div>
      <div id="editor-column">
        <div id="tabbar"></div>
        <div id="editor-wrap">
          <div id="editor-host"></div>
          <div id="preview-pane" class="hidden"></div>
          <canvas id="minimap"></canvas>
        </div>
        <div id="welcome" class="hidden">
          <div class="welcome-logo">🚀</div>
          <h1>RocketNotePad</h1>
          <p class="welcome-sub">高性能本地记事本 · Rust + Tauri</p>
          <div class="welcome-actions">
            <button id="w-new">新建文件</button>
            <button id="w-open">打开文件…</button>
            <button id="w-opendir">打开文件夹…</button>
          </div>
          <div class="welcome-hints">
            <span>${mod("P")} 跳转任意处</span><span>${shiftMod("P")} 命令面板</span><span>${mod("F")} 查找</span><span>${ctrlOnly("G")} 跳转行</span>
          </div>
          <div id="welcome-recent"></div>
        </div>
      </div>
    </div>
    <div id="statusbar">
      <span id="st-pos">行 1, 列 1</span>
      <span id="st-sel"></span>
      <span id="st-size"></span>
      <span id="st-enc"></span>
      <span id="st-lang"></span>
      <span class="tb-spacer"></span>
      <span id="st-font" title="点击选择字体"></span>
      <span id="st-zoom"></span>
      <span id="st-wrap"></span>
      <span id="st-theme"></span>
    </div>
  `;
}

function renderTabs() {
  const bar = $("tabbar");
  bar.innerHTML = "";
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className =
      "tab" + (t.id === activeId ? " active" : "") + (t.preview ? " preview" : "");
    el.title = t.path ?? "未保存的新文件";
    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = (t.dirty ? "● " : "") + t.name;
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    el.appendChild(name);
    el.appendChild(close);
    el.addEventListener("click", () => switchTab(t.id));
    el.addEventListener("dblclick", () => {
      if (t.preview) {
        t.preview = false;
        renderTabs();
      }
    });
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) closeTab(t.id);
    });
    bar.appendChild(el);
  }
  $("welcome").classList.toggle("hidden", tabs.length > 0);
  $("editor-wrap").classList.toggle("hidden", tabs.length === 0);
  updatePreviewVisibility();
}

function updatePreviewVisibility() {
  const t = activeTab();
  const show = !!t && settings.preview && langDefFor(t).label === "Markdown";
  preview?.setActive(show);
  $("editor-wrap").classList.toggle("previewing", show);
}

/** 状态栏每次更新都重写全部字段会让整条状态栏的布局失效；拖选时其实只有光标位和选区长度在变 */
function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

function setTitle(el: HTMLElement, title: string) {
  if (el.title !== title) el.title = title;
}

function renderStatus() {
  const t = activeTab();
  if (!t || !view) {
    for (const id of ["st-pos", "st-sel", "st-size", "st-enc", "st-lang"]) setText($(id), "");
    setText($("st-font"), "");
  } else {
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    setText($("st-pos"), `行 ${line.number}, 列 ${sel.head - line.from + 1}`);
    setText($("st-sel"), sel.empty ? "" : `选中 ${Math.abs(sel.to - sel.from)} 字符`);
    setText($("st-size"), t.path ? formatSize(t.size) + (t.readOnly ? " · 只读" : "") : "未保存");
    setTitle($("st-size"), t.readOnly ? "文件过大，已按只读打开，不能编辑" : "");
    setText($("st-enc"), `${t.encoding} · ${lineEndingLabel(t.lineEnding)}`);
    setText($("st-lang"), langDefFor(t).label);
    setTitle($("st-lang"), t.lang ? `已手动选择 ${t.lang}，点击更改` : "点击选择语言模式");
    setText($("st-font"), fontLabel(lookFamily()));
  }
  setText($("st-zoom"), `缩放 ${lookSize()}px`);
  setText($("st-wrap"), settings.wrap ? "自动换行: 开" : "自动换行: 关");
  setText($("st-theme"), settings.theme === "dark" ? "暗色" : "亮色");
}

function lineEndingLabel(lineEnding: string): string {
  return lineEnding === "\r\n" ? "CRLF" : lineEnding === "\r" ? "CR" : "LF";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function currentOpts() {
  const t = activeTab();
  return {
    theme: settings.theme,
    fontSize: lookSize(),
    fontFamily: lookFamily(),
    wrap: settings.wrap,
    readOnly: t?.readOnly === true
  };
}

function viewUpdateListener(v: EditorView) {
  const t = activeTab();
  let docChanged = false;
  if (t) {
    docChanged = v.state.doc !== t.state.doc;
    t.state = v.state;
    if (docChanged) {
      t.seq += 1;
      // 先喂预览再刷标签：renderTabs() 会顺带调 setActive，喂过了它就不会再整篇重渲染一遍。
      // 预览没开时连整篇文档的字符串都不拼，大文件上每敲一下省掉一次全量拷贝
      if (preview?.isActive) preview.update(v.state.doc.toString());
      const wasPreview = t.preview;
      if (wasPreview) t.preview = false;
      if (!t.dirty || wasPreview) {
        t.dirty = true;
        renderTabs();
      }
      if (t.path) scheduleAutoSave();
    }
  }
  renderStatus();
  minimap?.onUpdate(docChanged);
}

function langDefFor(t: Tab): LangDef {
  return t.lang ? languageByLabel(t.lang) : languageForFile(t.name);
}

const langWarned = new Set<string>();
/** 语法包加载失败不阻断打开文件：按纯文本显示并给出一次性中文提示，而不是静默无高亮 */
async function loadLanguageSafe(def: LangDef): Promise<Extension | null> {
  try {
    return await def.load();
  } catch (e) {
    if (!langWarned.has(def.label)) {
      langWarned.add(def.label);
      void message(`「${def.label}」语法高亮加载失败，已按纯文本显示。\n${String(e)}`, {
        title: "语法高亮",
        kind: "warning"
      }).catch(() => undefined);
    }
    return null;
  }
}

/** 按当前语言重建 EditorState，尽量保留光标位置 */
async function applyLanguage(tab: Tab): Promise<void> {
  const language = await loadLanguageSafe(langDefFor(tab));
  const active = tab.id === activeId && !!view;
  // 等语法包的这段时间里可能又敲了字，先把最新文档收回标签，别丢掉这几下输入
  if (active) syncActiveState();
  const sel = active ? view!.state.selection.main : null;
  // 只读标签切换语言时不能丢掉只读状态，哪怕它当前不是活动标签
  const newState = createState(
    tab.state.doc.toString(),
    language,
    { ...currentOpts(), readOnly: tab.readOnly },
    viewUpdateListener
  );
  tab.state = newState;
  if (active && sel) {
    view!.setState(newState);
    const head = Math.min(sel.head, newState.doc.length);
    view!.dispatch({ selection: { anchor: Math.min(sel.anchor, head), head } });
  }
}

async function setTabLanguage(label: string | null): Promise<void> {
  const t = activeTab();
  if (!t || !view || t.lang === label) return;
  syncActiveState();
  t.lang = label;
  renderStatus();
  updatePreviewVisibility();
  await applyLanguage(t);
}

function languageCommands(): Command[] {
  const t = activeTab();
  const auto: Command = {
    id: "lang.auto",
    title: "语言: 按扩展名自动判断",
    hint: t ? languageForFile(t.name).label : "",
    run: () => setTabLanguage(null)
  };
  return [
    auto,
    ...LANGUAGES.map((l) => ({
      id: "lang." + l.label,
      title: "语言: " + l.label,
      run: () => setTabLanguage(l.label)
    }))
  ];
}

function makeTab(
  path: string | null,
  name: string,
  doc: string,
  encoding: string,
  lineEnding: string,
  size: number,
  language: Extension | null,
  large = false
): Tab {
  const tab: Tab = {
    id: nextId++,
    path,
    name,
    encoding,
    lineEnding,
    size,
    readOnly: large,
    dirty: false,
    seq: 0,
    saving: false,
    state: null!,
    lang: null,
    preview: false
  };
  // 新标签还没进入 tabs，currentOpts() 取不到它的只读状态，这里显式带上
  tab.state = createState(doc, language, { ...currentOpts(), readOnly: large }, viewUpdateListener);
  return tab;
}

function newTab() {
  untitledCount++;
  const tab = makeTab(null, `未命名 ${untitledCount}`, "", "UTF-8", "\n", 0, null);
  tabs.push(tab);
  switchTab(tab.id);
}

async function openPath(path: string): Promise<boolean> {
  if (await isDirectory(path)) {
    return openFolder(path);
  }
  return openFileDirect(path);
}

async function openFileDirect(
  path: string,
  focusEditor = true,
  isPreview = false,
  quiet = false
): Promise<boolean> {
  const existing = tabs.find((t) => t.path === path);
  if (existing) {
    if (!isPreview) existing.preview = false;
    switchTab(existing.id, focusEditor);
    return true;
  }
  try {
    const fc = await readTextFile(path, settings.editLimitMB, settings.maxFileMB);
    const name = path.split(/[\\/]/).pop()!;
    const language = await loadLanguageSafe(languageForFile(name));
    const tab = makeTab(
      path,
      name,
      fc.content,
      fc.encoding,
      fc.line_ending,
      fc.size,
      language,
      fc.large === true
    );
    tab.preview = isPreview;
    const slot = isPreview
      ? tabs.find((t) => t.preview && !t.dirty && !t.saving)
      : undefined;
    if (slot) {
      // 复用预览标签：把它整体换成新文件，而不是每次点击都新增标签
      slot.path = tab.path;
      slot.name = tab.name;
      slot.encoding = tab.encoding;
      slot.lineEnding = tab.lineEnding;
      slot.size = tab.size;
      slot.readOnly = tab.readOnly;
      slot.dirty = false;
      slot.seq = 0;
      slot.lang = null;
      slot.state = tab.state;
      if (slot.id === activeId) {
        view.setState(slot.state);
        reconfigure(view, currentOpts());
        if (focusEditor) view.focus();
      } else {
        switchTab(slot.id, focusEditor);
      }
      renderTabs();
      renderStatus();
      minimap?.onUpdate(true);
      updatePreviewVisibility();
    } else {
      tabs.push(tab);
      switchTab(tab.id, focusEditor);
    }
    pushRecent(path);
    persistSettings();
    return true;
  } catch (e) {
    // 启动恢复时文件可能已被删除或移动，静默跳过即可，不该一开机就弹错误
    if (!quiet) await message(String(e), { title: "打开失败", kind: "error" });
    return false;
  }
}

async function openFolder(dir: string): Promise<boolean> {
  await sidebar.addFolder(dir);
  const files = await listTextFiles(dir, settings.editLimitMB);
  if (files.length === 0) {
    await message(
      "该文件夹中没有找到可打开的文本文件。\n仅打开常见文本/代码类型（深度≤4、≤200 个、单个≤8MB）。",
      { title: "打开文件夹", kind: "info" }
    );
    return false;
  }
  if (files.length > 50) {
    const ok = await ask(
      `将打开该文件夹中的 ${files.length} 个文本文件，可能占用较多资源。是否继续？`,
      { title: "打开文件夹", kind: "warning", okLabel: "继续", cancelLabel: "取消" }
    );
    if (!ok) return false;
  }
  for (const p of files) {
    await openFileDirect(p);
  }
  return true;
}

async function openFolderDialog() {
  const selected = await openDialog({ directory: true, multiple: false });
  if (selected) await openFolder(selected);
}

async function openDialogFiles() {
  const selected = await openDialog({
    multiple: true,
    filters: [{ name: "所有文件", extensions: ["*"] }]
  });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  for (const p of paths) await openPath(p);
}

function syncActiveState() {
  const t = activeTab();
  if (t) t.state = view.state;
}

async function saveTab(tab: Tab, saveAs: boolean): Promise<boolean> {
  syncActiveState();
  let path = tab.path;
  if (!path || saveAs) {
    const defaultName = tab.path ? tab.name : undefined;
    const selected = await saveDialog({
      defaultPath: path ?? defaultName,
      filters: [{ name: "所有文件", extensions: ["*"] }]
    });
    if (!selected) return false;
    path = selected;
    tab.path = path;
    tab.name = path.split(/[\\/]/).pop()!;
    await applyLanguage(tab);
    pushRecent(path);
  }
  const target = tab.seq;
  try {
    const meta = await writeTextFile(path, tab.state.doc.toString(), tab.encoding, tab.lineEnding);
    if (tab.seq === target) {
      tab.size = meta.size;
      tab.dirty = false;
      autoSaveWarned.delete(tab.id);
    }
    renderTabs();
    renderStatus();
    updatePreviewVisibility();
    persistSettings();
    return true;
  } catch (e) {
    await message(String(e), { title: "保存失败", kind: "error" });
    return false;
  }
}

/** 自动保存：只处理已落到磁盘路径的标签，Untitled 仍需手动保存 */
async function autoSaveTab(tab: Tab): Promise<void> {
  if (!tab.path || !tab.dirty || tab.saving) return;
  tab.saving = true;
  const target = tab.seq;
  try {
    const meta = await writeTextFile(tab.path, tab.state.doc.toString(), tab.encoding, tab.lineEnding);
    if (tab.seq === target) {
      tab.size = meta.size;
      tab.dirty = false;
      autoSaveWarned.delete(tab.id);
    }
    renderTabs();
    renderStatus();
    persistSettings();
  } catch (e) {
    // 同一个标签只提示一次，避免每次停顿都弹框
    if (!autoSaveWarned.has(tab.id)) {
      autoSaveWarned.add(tab.id);
      await message(`${String(e)}\n"${tab.name}" 仍是未保存状态，可手动保存。`, {
        title: "自动保存失败",
        kind: "error"
      });
    }
  } finally {
    tab.saving = false;
  }
}

function scheduleAutoSave() {
  if (!settings.autoSave) return;
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => void flushAutoSave(), AUTO_SAVE_DELAY);
}

async function flushAutoSave(): Promise<void> {
  if (!settings.autoSave) return;
  window.clearTimeout(autoSaveTimer);
  syncActiveState();
  const tab = activeTab();
  if (tab) await autoSaveTab(tab);
}

async function flushAllAutoSave(): Promise<void> {
  if (!settings.autoSave) return;
  window.clearTimeout(autoSaveTimer);
  syncActiveState();
  for (const tab of tabs) await autoSaveTab(tab);
}

function toggleAutoSave() {
  settings.autoSave = !settings.autoSave;
  if (!settings.autoSave) window.clearTimeout(autoSaveTimer);
  persistSettings();
}

/** 启动日志默认只在出问题时补写一份；打开后每次启动都全程记录 */
async function toggleStartupLog(): Promise<void> {
  settings.startupLog = !settings.startupLog;
  persistSettings();
  const path = await applyStartupLog(settings.startupLog);
  const text = settings.startupLog
    ? `已开启全程记录，本次启动的过程在这里：\n${path ?? "（三个可写位置都写不了，日志没能落盘）"}\n\n再执行一次本命令即可恢复默认（只在启动出问题时才补写一份）。`
    : "已恢复默认：正常启动不再产生日志文件，只有卡住、崩溃或启动失败时才会补写一份 rocketnotepad.startup.log。";
  await message(text, { title: "RocketNotePad 启动日志" }).catch(() => undefined);
}

async function closeTab(id: number) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (tab.id === activeId) syncActiveState();
  if (settings.autoSave) await autoSaveTab(tab);
  if (tab.dirty) {
    const doSave = await ask(`"${tab.name}" 有未保存的修改，是否保存？`, {
      title: "关闭标签",
      kind: "warning",
      okLabel: "保存",
      cancelLabel: "不保存"
    });
    if (doSave) {
      if (tab.id !== activeId) switchTab(tab.id);
      if (!(await saveTab(tab, false))) return;
    } else {
      const discard = await ask(`确定丢弃 "${tab.name}" 的修改并关闭吗？`, {
        title: "关闭标签",
        kind: "warning",
        okLabel: "丢弃",
        cancelLabel: "取消"
      });
      if (!discard) return;
    }
  }
  tabs.splice(idx, 1);
  if (activeId === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    activeId = -1;
    if (next) switchTab(next.id);
    else renderTabs();
  } else {
    renderTabs();
  }
  persistSettings();
  renderStatus();
}

/** 一键关闭所有标签：未保存修改沿用退出流程统一询问一次，不逐标签弹框 */
async function closeAllTabs() {
  if (!tabs.length) return;
  syncActiveState();
  await flushAllAutoSave();
  const dirty = tabs.filter((t) => t.dirty);
  if (dirty.length) {
    const doSave = await ask(`有 ${dirty.length} 个文件未保存，是否保存后关闭？`, {
      title: "关闭所有标签",
      kind: "warning",
      okLabel: "保存并关闭",
      cancelLabel: "取消"
    });
    if (doSave) {
      for (const t of [...dirty]) {
        if (t.id !== activeId) switchTab(t.id);
        if (!(await saveTab(t, false))) return;
      }
    } else {
      const discard = await ask("确定丢弃所有未保存的修改并关闭吗？", {
        title: "关闭所有标签",
        kind: "warning",
        okLabel: "丢弃",
        cancelLabel: "取消"
      });
      if (!discard) return;
    }
  }
  tabs = [];
  activeId = -1;
  renderTabs();
  renderStatus();
  persistSettings();
}

async function removeTabsByPath(path: string) {
  const affected = tabs.filter(
    (t) => t.path === path || t.path?.startsWith(path + "/") || t.path?.startsWith(path + "\\")
  );
  if (affected.length === 0) return;
  if (affected.some((t) => t.dirty)) {
    const ok = await ask("被删除的文件中有未保存的修改，确定关闭这些标签吗？", {
      title: "文件已删除",
      kind: "warning",
      okLabel: "关闭",
      cancelLabel: "取消"
    });
    if (!ok) return;
  }
  const ids = new Set(affected.map((t) => t.id));
  const activeRemoved = ids.has(activeId);
  tabs = tabs.filter((t) => !ids.has(t.id));
  if (activeRemoved) {
    activeId = -1;
    if (tabs.length) switchTab(tabs[tabs.length - 1].id);
    else renderTabs();
  } else {
    renderTabs();
  }
  persistSettings();
  renderStatus();
}

function switchTab(id: number, focusEditor = true) {
  if (activeId === id) return;
  // 先冲掉上一个标签的待写入内容，再切换活动状态
  void flushAutoSave();
  syncActiveState();
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  activeId = id;
  view.setState(tab.state);
  reconfigure(view, currentOpts());
  renderTabs();
  renderStatus();
  if (focusEditor) view.focus();
  minimap?.onUpdate(true);
  updatePreviewVisibility();
  // 切换活动文件时在资源管理器里展开并选中它（非手动选中，不影响新建落点）
  if (tab.path) void sidebar.focusFile(tab.path);
  persistSettings();
}

/** 预览里的代码块跟着编辑器字体走，靠一个 CSS 变量传递，避免两处各写一份字体栈 */
function applyEditorFont() {
  document.documentElement.style.setProperty("--rnp-editor-font", fontStack(lookFamily()));
}

/** 只改外观，不落盘 */
function applyLook() {
  reconfigure(view, currentOpts());
  applyEditorFont();
  renderStatus();
  minimap?.onUpdate(true);
}

function applySettings() {
  reconfigure(view, currentOpts());
  document.body.dataset.theme = settings.theme;
  applyEditorFont();
  preview?.setTheme(settings.theme);
  renderStatus();
  persistSettings();
}

function chooseFont() {
  openFontPicker({
    current: settings.fontFamily,
    fontSize: settings.fontSize,
    onPreview: (family, fontSize) => {
      look = { fontFamily: family, fontSize };
      applyLook();
    },
    onCommit: (family, size) => {
      look = null;
      settings.fontFamily = family;
      settings.fontSize = size;
      applySettings();
      minimap?.onUpdate(true);
      view.focus();
    },
    onCancel: () => {
      look = null;
      applyLook();
      view.focus();
    }
  });
}

function showAbout() {
  openAbout({
    tabs: tabs.length,
    onPalette: () => openPalette(commands()),
    onClose: () => view.focus()
  });
}

function setFontSize(delta: number) {
  settings.fontSize = Math.min(40, Math.max(9, settings.fontSize + delta));
  applySettings();
  minimap?.onUpdate(true);
}

function toggleTheme() {
  settings.theme = settings.theme === "dark" ? "light" : "dark";
  applySettings();
  minimap?.onUpdate(true);
}

function togglePreview() {
  settings.preview = !settings.preview;
  persistSettings();
  updatePreviewVisibility();
}

function gotoPalette() {
  const files = [
    ...tabs.filter((t) => t.path).map((t) => ({ name: t.name, path: t.path! })),
    ...sidebar.flatFiles()
  ];
  const seen = new Set<string>();
  const unique = files.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
  openGoto(unique, (p) => openFileDirect(p), (n) => gotoLineNumber(view, n));
}

/** 命令面板入口：按当前语言整篇格式化活动文档（右键菜单走 editmenu 里的同一套逻辑） */
async function formatActive(): Promise<void> {
  const t = activeTab();
  if (!t || !view || t.readOnly) return;
  const label = langDefFor(t).label;
  if (!isFormatSupported(label)) {
    await message(`暂不支持格式化「${label}」`, { title: "格式化文档", kind: "info" });
    return;
  }
  try {
    await formatDocument(view, label);
    view.focus();
  } catch (e) {
    await message(String(e), { title: "格式化失败", kind: "error" });
  }
}

function commands(): Command[] {
  return [
    { id: "file.new", title: "文件: 新建", hint: mod("N"), run: () => newTab() },
    { id: "file.open", title: "文件: 打开…", hint: mod("O"), run: () => openDialogFiles() },
    { id: "file.open_folder", title: "文件: 打开文件夹…", run: () => openFolderDialog() },
    { id: "file.save", title: "文件: 保存", hint: mod("S"), run: () => { const t = activeTab(); if (t) saveTab(t, false); } },
    { id: "file.save_as", title: "文件: 另存为…", hint: shiftMod("S"), run: () => { const t = activeTab(); if (t) saveTab(t, true); } },
    { id: "file.close_tab", title: "文件: 关闭标签", hint: mod("W"), run: () => { if (activeId >= 0) closeTab(activeId); } },
    { id: "file.close_all", title: "文件: 关闭所有标签", hint: shiftMod("W"), run: () => void closeAllTabs() },
    {
      id: "file.autosave",
      title: `文件: 自动保存（当前${settings.autoSave ? "开启" : "关闭"}）`,
      hint: settings.autoSave ? "停顿 1.5 秒后写入已保存的文件" : "已保存的文件不会自动写入",
      run: () => toggleAutoSave()
    },
    { id: "find.open", title: "查找: 查找/替换", hint: mod("F"), run: () => { if (tabs.length) openSearchPanel(view); } },
    { id: "find.replace", title: "查找: 替换", hint: altMod("E"), run: () => { if (tabs.length) openReplacePanel(view); } },
    { id: "edit.format", title: "编辑: 格式化文档", hint: "SQL 内置 · 其余调用系统工具", run: () => void formatActive() },
    { id: "goto.line", title: "转到: 跳转到行…", hint: ctrlOnly("G"), run: () => { if (tabs.length) gotoLine(view); } },
    { id: "goto.file", title: "转到: 跳转任意处…", hint: mod("P"), run: () => gotoPalette() },
    { id: "view.sidebar", title: "视图: 切换侧边栏", hint: mod("\\"), run: () => sidebar.toggle() },
    { id: "view.wrap", title: "视图: 切换自动换行", run: () => { settings.wrap = !settings.wrap; applySettings(); } },
    { id: "view.theme", title: "视图: 切换明暗主题", run: () => toggleTheme() },
    {
      id: "view.font",
      title: "视图: 选择字体…",
      hint: `当前 ${fontLabel(settings.fontFamily)} · ${settings.fontSize}px`,
      run: () => chooseFont()
    },
    { id: "view.minimap", title: "视图: 切换 Minimap", run: () => minimap.toggle() },
    { id: "view.preview", title: "视图: 切换 Markdown 预览", run: () => togglePreview() },
    { id: "view.zoom_in", title: "视图: 放大", hint: mod("+"), run: () => setFontSize(1) },
    { id: "view.zoom_out", title: "视图: 缩小", hint: mod("-"), run: () => setFontSize(-1) },
    { id: "view.zoom_reset", title: "视图: 重置缩放", hint: mod("0"), run: () => { settings.fontSize = DEFAULT_FONT_SIZE; applySettings(); } },
    {
      id: "settings.startup_log",
      title: `设置: 启动日志（当前${settings.startupLog ? "全程记录" : "只在出问题时写"}）`,
      hint: settings.startupLog ? "每次启动都写 rocketnotepad.startup.log" : "启动正常时不留日志文件",
      run: () => void toggleStartupLog()
    },
    { id: "lang.select", title: "语言: 选择语言…", hint: "也可点击状态栏语言", run: () => openPalette(languageCommands()) },
    {
      id: "help.about",
      title: "帮助: 关于 RocketNotePad",
      hint: `版本 ${APP_VERSION} · 功能、架构与运行环境`,
      run: () => showAbout()
    }
  ];
}

function handleMenu(id: string) {
  switch (id) {
    case "file.new": newTab(); break;
    case "file.open": openDialogFiles(); break;
    case "file.open_folder": openFolderDialog(); break;
    case "file.save": { const t = activeTab(); if (t) saveTab(t, false); break; }
    case "file.save_as": { const t = activeTab(); if (t) saveTab(t, true); break; }
    case "file.close_tab": if (activeId >= 0) closeTab(activeId); break;
    case "file.close_all": void closeAllTabs(); break;
    case "app.quit": getCurrentWindow().close(); break;
    case "find.open": if (tabs.length) openSearchPanel(view); break;
    case "find.replace": if (tabs.length) openReplacePanel(view); break;
    case "find.next": if (tabs.length) findNext(view); break;
    case "find.prev": if (tabs.length) findPrevious(view); break;
    case "select.next_occurrence": if (tabs.length) selectNextOccurrence(view); break;
    case "view.sidebar": sidebar.toggle(); break;
    case "view.palette": openPalette(commands()); break;
    case "view.goto":
    case "goto.file": gotoPalette(); break;
    case "view.wrap": settings.wrap = !settings.wrap; applySettings(); break;
    case "view.theme": toggleTheme(); break;
    case "view.font": chooseFont(); break;
    case "view.minimap": minimap.toggle(); break;
    case "view.preview": togglePreview(); break;
    case "view.zoom_in": setFontSize(1); break;
    case "view.zoom_out": setFontSize(-1); break;
    case "view.zoom_reset": settings.fontSize = DEFAULT_FONT_SIZE; applySettings(); break;
    case "goto.line": if (tabs.length) gotoLine(view); break;
    case "help.about":
      showAbout();
      break;
    default:
      if (id.startsWith("limits.edit.") || id.startsWith("limits.max.")) applySizeLimits(id);
      break;
  }
}

/** 菜单调档：落配置并重建菜单；两档冲突时自动抬高/压低另一档，保证可编辑 < 拒绝 */
function applySizeLimits(id: string) {
  const v = Number(id.split(".").pop());
  if (!Number.isInteger(v) || v <= 0) return;
  if (id.startsWith("limits.edit.")) {
    settings.editLimitMB = v;
    if (settings.maxFileMB <= v) settings.maxFileMB = v * 2;
  } else {
    settings.maxFileMB = v;
    if (settings.editLimitMB >= v) settings.editLimitMB = Math.max(1, Math.floor(v / 2));
  }
  // 已打开标签的只读态跟着新档位走：readOnly 存在标签上，切标签/重配时生效
  for (const t of tabs) {
    if (t.path) t.readOnly = t.size > settings.editLimitMB * 1024 * 1024;
  }
  reconfigure(view, currentOpts());
  renderStatus();
  saveConfig();
  void refreshSizeMenu(settings.editLimitMB, settings.maxFileMB);
  void message(
    `当前档位：≤${settings.editLimitMB} MB 可编辑，${settings.editLimitMB}–${settings.maxFileMB} MB 只读，>${settings.maxFileMB} MB 拒绝打开。`,
    { title: "文件大小档位", kind: "info" }
  );
}

async function renderRecentMenu() {
  const entries: RecentEntry[] = await listRecent();
  return entries;
}

async function renderWelcomeRecent() {
  const box = $("welcome-recent");
  box.innerHTML = "";
  const entries = await renderRecentMenu();
  if (entries.length === 0) return;
  const title = document.createElement("div");
  title.className = "welcome-recent-title";
  title.textContent = "最近打开";
  box.appendChild(title);
  for (const e of entries.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "recent-item";
    item.title = e.path;
    item.textContent = e.name;
    item.addEventListener("click", () => openPath(e.path));
    box.appendChild(item);
  }
}

function wireEvents() {
  // 失去焦点/切到后台时立刻冲刷，避免停顿计时器还没触发就被打断
  window.addEventListener("blur", () => void flushAutoSave());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushAutoSave();
  });
  $("w-new").addEventListener("click", () => newTab());
  $("w-open").addEventListener("click", () => openDialogFiles());
  $("w-opendir").addEventListener("click", () => openFolderDialog());
  $("st-lang").addEventListener("click", () => {
    if (activeTab()) openPalette(languageCommands());
  });
  $("st-font").addEventListener("click", () => chooseFont());

  // 编辑区右键：自定义菜单（撤销/重做/剪切/复制/粘贴/全选 + 格式化文档），取代 WebView 原生菜单
  $("editor-host").addEventListener("contextmenu", (e) => {
    const t = activeTab();
    if (!t || !view) return;
    e.preventDefault();
    void showEditorContextMenu(e.clientX, e.clientY, view, {
      readOnly: t.readOnly,
      langLabel: langDefFor(t).label
    });
  });

  listen<string>("menu-action", (e) => handleMenu(e.payload)).catch(() => {});

  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    // Ctrl+G (no Cmd): goto line, Sublime style
    if (e.ctrlKey && !e.metaKey && !e.altKey && key === "g") {
      e.preventDefault();
      if (tabs.length) gotoLine(view);
      return;
    }
    if (!mod) return;
    if (key === "p" && e.shiftKey) {
      e.preventDefault();
      openPalette(commands());
    } else if (key === "p") {
      e.preventDefault();
      gotoPalette();
    } else if (key === "\\") {
      e.preventDefault();
      sidebar.toggle();
    } else if (key === "n" && !e.shiftKey) {
      e.preventDefault();
      newTab();
    } else if (key === "o") {
      e.preventDefault();
      openDialogFiles();
    } else if (key === "s" && !e.shiftKey) {
      e.preventDefault();
      const t = activeTab();
      if (t) saveTab(t, false);
    } else if (key === "s" && e.shiftKey) {
      e.preventDefault();
      const t = activeTab();
      if (t) saveTab(t, true);
    } else if (key === "w" && e.shiftKey) {
      e.preventDefault();
      void closeAllTabs();
    } else if (key === "w") {
      e.preventDefault();
      if (activeId >= 0) closeTab(activeId);
    } else if (key === "=" || key === "+") {
      e.preventDefault();
      setFontSize(1);
    } else if (key === "-") {
      e.preventDefault();
      setFontSize(-1);
    } else if (key === "0") {
      e.preventDefault();
      settings.fontSize = DEFAULT_FONT_SIZE;
      applySettings();
    } else if (key === "tab") {
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.id === activeId);
      const dir = e.shiftKey ? -1 : 1;
      if (tabs.length > 1) switchTab(tabs[(idx + dir + tabs.length) % tabs.length].id);
    }
  });

  let handlingClose = false;
  getCurrentWindow()
    .onCloseRequested(async (event) => {
      if (handlingClose) return;
      handlingClose = true;
      try {
        syncActiveState();
        await flushAllAutoSave();
        const dirty = tabs.filter((t) => t.dirty);
        if (dirty.length > 0) {
          event.preventDefault();
          const doSave = await ask(
            `有 ${dirty.length} 个文件未保存，是否保存后退出？`,
            { title: "退出 RocketNotePad", kind: "warning", okLabel: "保存并退出", cancelLabel: "不保存" }
          );
          if (doSave) {
            for (const t of [...dirty]) {
              if (t.id !== activeId) switchTab(t.id);
              if (!(await saveTab(t, false))) return;
            }
          } else {
            const quit = await ask("确定丢弃所有未保存修改并退出吗？", {
              title: "退出 RocketNotePad",
              kind: "warning",
              okLabel: "丢弃并退出",
              cancelLabel: "取消"
            });
            if (!quit) return;
          }
          persistSettings();
          await saveConfigNow();
          await getCurrentWindow().destroy();
        } else {
          persistSettings();
          await saveConfigNow();
        }
      } finally {
        handlingClose = false;
      }
    })
    .catch(() => {});
}

/** 启动时把上次的文件原样恢复：已删除/移动的路径静默丢弃，活动标签回到上次停留的那个 */
async function restoreSession() {
  // 逐个打开时每次都会写回活动路径，先把上次停留的那个存下来，否则恢复完只剩最后一个
  const wanted = settings.restoreActive;
  const opened: string[] = [];
  for (const p of settings.restoreTabs) {
    if (await openFileDirect(p, true, false, true)) opened.push(p);
  }
  if (opened.length !== settings.restoreTabs.length) {
    settings.restoreTabs = opened;
    persistSettings();
  }
  const active = opened.includes(wanted) ? wanted : opened[opened.length - 1];
  if (!active) return;
  const tab = tabs.find((t) => t.path === active);
  if (tab) switchTab(tab.id);
  void sidebar.focusFile(active);
}

async function main() {
  traceCrashes();
  note("脚本开始执行");
  await loadConfig();
  note("配置已读取");
  void refreshSizeMenu(settings.editLimitMB, settings.maxFileMB);
  buildDOM();
  document.body.dataset.theme = settings.theme;
  applyEditorFont();
  note("界面骨架已建好");

  view = new EditorView({
    state: createState("", null, currentOpts(), viewUpdateListener),
    parent: $("editor-host")
  });
  note("编辑器已挂载");

  sidebar = new Sidebar(
    $("sidebar"),
    $("sidebar-tree"),
    (p, isPreview) => openFileDirect(p, false, isPreview),
    () => openFolderDialog(),
    {
      onCreated: (p) => openFileDirect(p),
      onRenamed: (from, to) => {
        let changed = false;
        for (const t of tabs) {
          if (!t.path) continue;
          let newPath: string | null = null;
          if (t.path === from) newPath = to;
          else if (t.path.startsWith(from + "/") || t.path.startsWith(from + "\\")) {
            newPath = to + t.path.slice(from.length);
          }
          if (newPath) {
            t.path = newPath;
            t.name = newPath.split(/[\\/]/).pop()!;
            changed = true;
          }
        }
        if (changed) {
          renderTabs();
          renderStatus();
          updatePreviewVisibility();
          persistSettings();
        }
      },
      onDeleted: (path) => removeTabsByPath(path)
    }
  );
  if (!settings.sidebarVisible) $("sidebar").classList.add("hidden");
  minimap = new Minimap($("minimap") as HTMLCanvasElement, view);
  preview = new MarkdownPreview($("preview-pane"), view, settings.theme);

  wireEvents();
  renderTabs();
  renderStatus();
  renderWelcomeRecent();
  // 界面已经可用，后面的恢复步骤不该再触发后端的超时弹窗
  markReady();
  await restoreSession();
  note("上次的文件夹与标签已恢复");
}

main().catch((err: unknown) => {
  void failStartup(err);
});
