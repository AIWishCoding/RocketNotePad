import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { message } from "@tauri-apps/plugin-dialog";
import { version } from "../package.json";
import { appInfo, revealInFileManager, type AppInfo } from "./api";
import { cfg } from "./config";
import { fontLabel } from "./fonts";
import { LANGUAGES } from "./languages";
import { ENTER, IS_MAC, altMod, ctrlOnly, mod, shiftMod } from "./platform";

/** 展示用版本号跟着 package.json 走，打包时三处版本由测试保证一致 */
export const APP_VERSION = version;

export interface AboutOptions {
  /** 当前打开的标签数，运行环境页要报本次会话的规模 */
  tabs: number;
  onPalette: () => void;
  onClose: () => void;
}

const TABS = [
  { id: "features", label: "功能" },
  { id: "arch", label: "架构" },
  { id: "env", label: "运行环境" },
  { id: "keys", label: "快捷键" }
] as const;

type TabId = (typeof TABS)[number]["id"];

/* ---------- 图标：16×16 线性图形，颜色跟着 currentColor ---------- */

const PATHS: Record<string, string> = {
  tabs: '<rect x="1.5" y="4.5" width="9" height="9" rx="1.4"/><path d="M5 4.5V3a1.5 1.5 0 0 1 1.5-1.5H13A1.5 1.5 0 0 1 14.5 3v7A1.5 1.5 0 0 1 13 11.5h-2.5"/>',
  save: '<path d="M2.5 2.5h8.2L13.5 5.3v8.2h-11z"/><path d="M5 2.5v3.6h5.2V2.5"/><rect x="4.6" y="9" width="6.8" height="4.5"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.4 3.4"/>',
  cursor: '<path d="M3.4 2.2 12 8.1l-3.7.9 2 3.6-1.7.9-2-3.6-2.6 2.7z"/>',
  folder: '<path d="M1.6 4a1 1 0 0 1 1-1h3l1.4 1.6h6.4a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z"/>',
  trash: '<path d="M2.8 4.2h10.4"/><path d="M6 4.2V2.6h4v1.6"/><path d="M4.2 4.2 5 13.4h6l.8-9.2"/><path d="M6.6 6.6v4.4M9.4 6.6v4.4"/>',
  encoding: '<path d="M2.4 6.4h9.2l-2.2-2.2"/><path d="M13.6 9.6H4.4l2.2 2.2"/>',
  shield: '<path d="M8 1.8 13.4 4v4.1c0 3-2.2 5.1-5.4 6.1-3.2-1-5.4-3.1-5.4-6.1V4z"/><path d="m5.8 8 1.7 1.7 3-3.2"/>',
  code: '<path d="m5.4 4.6-3.6 3.5 3.6 3.5"/><path d="m10.6 4.6 3.6 3.5-3.6 3.5"/><path d="m9.2 2.8-2.4 10.4"/>',
  markdown: '<rect x="1.4" y="3.6" width="13.2" height="8.8" rx="1.4"/><path d="M4 10V6l2 2.2L8 6v4"/><path d="M11 6v4M9.4 8.6 11 10.4l1.6-1.8"/>',
  map: '<path d="m1.8 3.6 4-1.6 4.4 1.6 4-1.6v10.4l-4 1.6-4.4-1.6-4 1.6z"/><path d="M5.8 2v10.4M10.2 3.6V14"/>',
  compass: '<circle cx="8" cy="8" r="6.2"/><path d="m10.6 5.4-1.5 4-4 1.5 1.5-4z"/>',
  theme: '<circle cx="8" cy="8" r="6.2"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" stroke="none"/>',
  font: '<path d="M3.2 13 8 2.8 12.8 13"/><path d="M5.1 9.4h5.8"/>',
  history: '<path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9"/><path d="M2.2 2.6v3.2h3.2"/><path d="M8 5.2V8l2 1.4"/>',
  gauge: '<path d="M2 11.6a6.4 6.4 0 1 1 12 0"/><path d="M8 11.6 11 6.8"/><circle cx="8" cy="11.6" r="1" fill="currentColor"/>',
  layers: '<path d="m8 1.8 6.2 3.1L8 8 1.8 4.9z"/><path d="m1.8 8 6.2 3.1L14.2 8"/><path d="m1.8 11.1 6.2 3.1 6.2-3.1"/>',
  bolt: '<path d="M9.2 1.6 3.6 9h3.6l-.8 5.4L12.4 7H8.8z"/>',
  box: '<path d="M8 1.8 14 5v6l-6 3.2L2 11V5z"/><path d="M2 5l6 3.2L14 5"/><path d="M8 8.2v6"/>'
};

function icon(name: string, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] ?? ""}</svg>`;
}

/** 应用标记：与图标一致的深蓝渐变圆角方块 + 火箭 */
const MARK = `
<svg width="46" height="46" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="rnp-about-mark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3d6bff"/>
      <stop offset="0.55" stop-color="#2b4fd8"/>
      <stop offset="1" stop-color="#16257a"/>
    </linearGradient>
  </defs>
  <rect x="1" y="1" width="46" height="46" rx="11" fill="url(#rnp-about-mark)"/>
  <path d="M24 9c5.2 4.2 8 9.4 8 15.2 0 3.3-1 6.2-2.7 8.6h-10.6C17 30.4 16 27.5 16 24.2 16 18.4 18.8 13.2 24 9Z" fill="#fff" opacity=".95"/>
  <circle cx="24" cy="21" r="3.1" fill="#2b4fd8"/>
  <path d="M18.7 33.2 14 38.4l6.2-1.4M29.3 33.2 34 38.4l-6.2-1.4" fill="#8fb4ff"/>
  <path d="M21.6 34.4h4.8l-2.4 5.2z" fill="#ffd166"/>
</svg>`;

/* ---------- 内容 ---------- */

interface Feature {
  icon: string;
  title: string;
  desc: string;
}

function featureGroups(): Array<{ title: string; tone: string; items: Feature[] }> {
  return [
    {
      title: "编辑与标签",
      tone: "edit",
      items: [
        { icon: "tabs", title: "多标签编辑", desc: `单击文件先用斜体预览标签占位，双击或改动后固定；中键关闭，${shiftMod("W")} 一键关闭所有标签，未保存的标签带 ● 标记。` },
        { icon: "save", title: "停顿即存", desc: "停止输入 1.5 秒自动写回已保存的文件；失焦、切后台、关窗立即冲刷，未命名文件仍需手动保存。" },
        { icon: "search", title: "查找与替换", desc: "编辑器右上角浮窗，支持区分大小写、全词匹配、正则与匹配计数，可逐个替换或全部替换。" },
        { icon: "cursor", title: "顺手的选择", desc: `${mod("D")} 逐个选中相同项，多光标与列选择由编辑器提供；大段拖选逐帧合并，不掉帧。` },
        { icon: "code", title: "格式化文档", desc: "编辑区右键或命令面板一键整理整篇代码：SQL 内置离线格式化，Python/Java/C/C++/Rust/Go 调用系统标准工具（black、clang-format、rustfmt、gofmt），缺工具时给出中文安装提示。" }
      ]
    },
    {
      title: "文件与文件夹",
      tone: "files",
      items: [
        { icon: "folder", title: "文件夹式工作流", desc: "资源管理器可同时挂载多个文件夹，树内新建、重命名、复制粘贴、拖拽移动，右键菜单全中文。" },
        { icon: "trash", title: "删除进回收站", desc: "删除走系统回收站，误删可以还原；关闭标签与退出前统一询问未保存的修改。" },
        { icon: "encoding", title: "编码与换行", desc: "自动嗅探 UTF-8 / UTF-16 / GB18030 / Big5 / Shift_JIS / EUC-KR，保存时保持原编码与 CRLF、LF、CR。" },
        { icon: "shield", title: "大文件保护", desc: "默认 ≤64 MB 可编辑、64–256 MB 只读、>256 MB 拒绝；三档可在设置菜单调节并写入配置。只读档封顶内存，状态栏标出「只读」。" }
      ]
    },
    {
      title: "阅读与导航",
      tone: "read",
      items: [
        { icon: "code", title: `${LANGUAGES.length} 种语言高亮`, desc: "按扩展名自动识别，语法包用到才加载；也可以点状态栏的语言手动指定。" },
        { icon: "markdown", title: "Markdown 实时预览", desc: "右侧同步渲染 GFM 表格、任务列表与 mermaid 图表，内容经 DOMPurify 清洗后再插入。" },
        { icon: "map", title: "Minimap 缩略图", desc: "整篇文档的缩略视图，绘制代价与文档长度解耦，点击或拖动即可跳转。" },
        { icon: "compass", title: "跳转任意处", desc: `${mod("P")} 模糊搜文件、${ctrlOnly("G")} 跳到行、${shiftMod("P")} 命令面板，输入即筛选。` }
      ]
    },
    {
      title: "外观与会话",
      tone: "look",
      items: [
        { icon: "theme", title: "明暗双主题", desc: "亮色与暗色一键切换，编辑器、预览、缩略图、浮窗与右键菜单同步换肤。" },
        { icon: "font", title: "字体自由", desc: "默认跟随操作系统的界面字体，也可从常用字体里挑选或直接输入字体名，字号 9–40px 随时试穿。" },
        { icon: "history", title: "会话恢复", desc: "重开自动恢复上次挂载的文件夹、打开的标签与停留位置，欢迎页列出最近打开的文件。" },
        { icon: "gauge", title: "启动可观测", desc: "默认不留日志；卡住、崩溃或启动失败时自动补写一份过程记录，另有独立探针排查运行环境。" }
      ]
    }
  ];
}

interface Layer {
  icon: string;
  name: string;
  sub: string;
  tone: string;
  chips: Array<[string, string]>;
}

const LAYERS: Layer[] = [
  {
    icon: "layers",
    name: "前端 · TypeScript",
    sub: "跑在系统自带的 WebView 里，只负责界面与编辑体验",
    tone: "front",
    chips: [
      ["main.ts", "标签、会话与命令路由"],
      ["editor.ts", "CodeMirror 6 与热重配"],
      ["sidebar.ts", "资源管理器与文件操作"],
      ["preview.ts", "Markdown 与 mermaid"],
      ["minimap.ts", "缩略图绘制"],
      ["find.ts", "查找替换浮窗"],
      ["palette.ts", "命令面板与模糊匹配"],
      ["fontpicker.ts", "字体选择与试穿"],
      ["frame.ts", "逐帧合并几何读写"],
      ["config.ts", "配置校验与防抖落盘"]
    ]
  },
  {
    icon: "bolt",
    name: "桥 · Tauri 2 IPC",
    sub: "前端 invoke 调用文件、配置、启动三类命令；后端用 menu-action 事件把原生菜单点击送回前端",
    tone: "bridge",
    chips: [
      ["invoke", "文件读写 · 目录树 · 回收站 · 配置 · 启动观测"],
      ["event", "menu-action 单向事件"],
      ["CSP", "default-src 'self'，不加载远程资源"]
    ]
  },
  {
    icon: "box",
    name: "后端 · Rust 原生进程",
    sub: "所有磁盘访问与系统集成都在这一层，前端拿不到任意路径的读写能力",
    tone: "back",
    chips: [
      ["files.rs", "读写、编码嗅探、目录树、回收站"],
      ["config.rs", "配置读写与损坏容错"],
      ["paths.rs", "落盘位置与老版本搬迁"],
      ["startup.rs", "里程碑、看门狗、日志档位"],
      ["menu.rs", "全中文原生菜单与加速键"],
      ["app.rs", "运行环境与真实路径"],
      ["win_dialog.rs", "Windows 原生提示框"]
    ]
  }
];

const TRADEOFFS: Array<[string, string]> = [
  ["为什么是 Tauri", "复用系统 WebView（macOS 的 WKWebView、Windows 的 WebView2），交付一个原生二进制，不打包 Node 运行时和 Chromium，冷启动与常驻内存都远低于内置浏览器的方案。"],
  ["为什么是 CodeMirror 6", "主题、字体、换行、只读各自放进独立的 Compartment，改设置只重配那一个扩展，不重建文档、不丢光标位置与撤销历史。"],
  ["手感是怎么换来的", "几何读写集中到 requestAnimationFrame 里一帧一次，状态栏只改真正变了的字段，预览只在可见时渲染——连续输入与整段拖选都不再触发强制同步布局。"],
  ["大文件怎么扛", "语法包按需动态加载，缩略图抽样绘制，超过阈值的文件只读打开，内存占用与文档长度解耦。"],
  ["安全边界在哪", "Markdown 先经 DOMPurify 清洗再插入；字体名做字符清洗后才进 CSS 与画布；删除一律走系统回收站；WebView 不接管拖放，树内拖拽由应用自己实现。"]
];

const DELIVERY: Array<[string, string]> = [
  ["macOS", ".app 与 .dmg，应用自己的文件收在用户主目录的 ~/.rocketnote，不往 .app 包里写东西。"],
  ["Windows", "x64 绿色 exe 与 NSIS 安装包，配置优先写 exe 同目录（拷走即带走设置），装进 Program Files 这类只读位置时自动退回 %APPDATA%。"],
  ["Linux", "x86_64 的 deb 与 AppImage（Ubuntu 22.04+，依赖 WebKitGTK 4.1），配置收在 ~/.rocketnote。"]
];

function keyGroups(): Array<{ title: string; rows: Array<[string, string]> }> {
  const replaceAll = IS_MAC ? "⌘" + ENTER : "Ctrl+" + ENTER;
  return [
    {
      title: "文件",
      rows: [
        [mod("N"), "新建文件"],
        [mod("O"), "打开文件…"],
        [mod("S"), "保存"],
        [shiftMod("S"), "另存为…"],
        [mod("W"), "关闭标签"],
        [mod("Q"), "退出 RocketNotePad"]
      ]
    },
    {
      title: "编辑",
      rows: [
        [mod("Z"), "撤销"],
        [IS_MAC ? shiftMod("Z") : "Ctrl+Y", "重做"],
        [mod("X") + " / " + mod("C") + " / " + mod("V"), "剪切 / 复制 / 粘贴"],
        [mod("A"), "全选"],
        [mod("D"), "选中下一个相同项"]
      ]
    },
    {
      title: "查找与替换",
      rows: [
        [mod("F"), "查找浮窗"],
        [altMod("E"), "替换浮窗"],
        [IS_MAC ? mod("G") : "F3", "查找下一个"],
        [IS_MAC ? shiftMod("G") : "Shift+F3", "查找上一个"],
        [ENTER, "替换浮窗内：替换当前"],
        [replaceAll, "替换浮窗内：全部替换"]
      ]
    },
    {
      title: "导航",
      rows: [
        [mod("P"), "跳转任意处（文件 / :行号）"],
        [shiftMod("P"), "命令面板"],
        [ctrlOnly("G"), "跳转到行"],
        [mod("Tab") + " / " + shiftMod("Tab"), "下一个 / 上一个标签"],
        ["鼠标中键", "关闭标签"]
      ]
    },
    {
      title: "视图",
      rows: [
        [mod("\\"), "切换侧边栏"],
        [mod("=") + " / " + mod("-"), "放大 / 缩小"],
        [mod("0"), "重置缩放"],
        ["状态栏字体", "打开字体面板"],
        ["状态栏语言", "手动指定语言模式"]
      ]
    },
    {
      title: "资源管理器",
      rows: [
        ["↑ ↓ ← →", "移动与展开折叠"],
        [ENTER, "打开文件 / 展开目录"],
        ["F2", "重命名"],
        ["Delete", "删除到回收站"],
        [mod("C") + " / " + mod("X") + " / " + mod("V"), "复制 / 剪切 / 粘贴"],
        ["拖拽", "移动文件或文件夹"]
      ]
    }
  ];
}

/* ---------- DOM 小工具 ---------- */

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(cls: string, markup: string): HTMLElement {
  const node = el("span", cls);
  node.innerHTML = markup;
  return node;
}

function heading(text: string): HTMLElement {
  return el("h3", "about-group-title", text);
}

function button(cls: string, text: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = cls;
  node.textContent = text;
  return node;
}

/* ---------- 各分页 ---------- */

function featuresPanel(): HTMLElement {
  const panel = el("div", "about-panel");
  panel.appendChild(
    el(
      "p",
      "about-lead",
      "一个装在本地、打开就能写的记事本：文件夹式工作流 + 代码编辑器的顺手操作，全部离线运行，不上传任何内容。"
    )
  );
  for (const group of featureGroups()) {
    panel.appendChild(heading(group.title));
    const grid = el("div", "about-grid about-tone-" + group.tone);
    for (const f of group.items) {
      const card = el("div", "about-card");
      card.appendChild(svgEl("about-card-icon", icon(f.icon)));
      const body = el("div", "about-card-body");
      body.appendChild(el("div", "about-card-title", f.title));
      body.appendChild(el("div", "about-card-desc", f.desc));
      card.appendChild(body);
      grid.appendChild(card);
    }
    panel.appendChild(grid);
  }
  return panel;
}

function archPanel(): HTMLElement {
  const panel = el("div", "about-panel");
  panel.appendChild(
    el("p", "about-lead", "一个 Rust 原生进程加一个系统 WebView，两层之间只有一条 IPC 通道。没有 Node 运行时，也没有内置浏览器。")
  );
  const stack = el("div", "about-stack");
  LAYERS.forEach((layer, i) => {
    if (i > 0) {
      const link = el("div", "about-link");
      link.appendChild(el("span", "about-link-line"));
      link.appendChild(el("span", "about-link-label", i === 1 ? "↕ invoke / event" : "↕ 系统调用"));
      link.appendChild(el("span", "about-link-line"));
      stack.appendChild(link);
    }
    const card = el("div", "about-layer about-layer-" + layer.tone);
    const head = el("div", "about-layer-head");
    head.appendChild(svgEl("about-layer-icon", icon(layer.icon, 18)));
    const titles = el("div", "about-layer-titles");
    titles.appendChild(el("div", "about-layer-name", layer.name));
    titles.appendChild(el("div", "about-layer-sub", layer.sub));
    head.appendChild(titles);
    card.appendChild(head);
    const chips = el("div", "about-chips");
    for (const [name, role] of layer.chips) {
      const chip = el("span", "about-chip");
      chip.appendChild(el("b", "about-chip-name", name));
      chip.appendChild(el("span", "about-chip-role", role));
      chips.appendChild(chip);
    }
    card.appendChild(chips);
    stack.appendChild(card);
  });
  panel.appendChild(stack);

  panel.appendChild(heading("关键取舍"));
  const notes = el("div", "about-notes");
  for (const [title, desc] of TRADEOFFS) {
    const note = el("div", "about-note");
    note.appendChild(el("div", "about-note-title", title));
    note.appendChild(el("div", "about-note-desc", desc));
    notes.appendChild(note);
  }
  panel.appendChild(notes);

  panel.appendChild(heading("交付形态"));
  const deliver = el("div", "about-notes");
  for (const [title, desc] of DELIVERY) {
    const note = el("div", "about-note");
    note.appendChild(el("div", "about-note-title", title));
    note.appendChild(el("div", "about-note-desc", desc));
    deliver.appendChild(note);
  }
  panel.appendChild(deliver);
  return panel;
}

const OS_LABEL: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

function engineLabel(os: string): string {
  if (os === "macos") return "WKWebView（系统自带 WebKit）";
  if (os === "windows") return "WebView2（系统自带 Chromium）";
  return "WebKitGTK（系统自带）";
}

function appearanceText(): string {
  const font = fontLabel(cfg.fontFamily);
  return `${cfg.theme === "dark" ? "暗色" : "亮色"} · ${font} · ${cfg.fontSize}px · 自动换行${cfg.wrap ? "开" : "关"}`;
}

function switchesText(): string {
  const on = (v: boolean) => (v ? "开" : "关");
  return `自动保存${on(cfg.autoSave)} · Minimap${on(cfg.minimap)} · Markdown 预览${on(cfg.preview)}`;
}

/** 运行环境页的数据行；info 为 null 时按 pending 文案占位（读取中 / 不可用） */
function envRows(info: AppInfo | null, tabs: number, pending = "读取中…"): Array<[string, string, boolean]> {
  const value = (v: string | undefined) => (info === null ? pending : v || "不可用");
  const os = info ? `${OS_LABEL[info.os] ?? info.os} · ${info.arch}` : pending;
  return [
    ["版本", APP_VERSION, false],
    ["运行平台", os, false],
    ["应用内核", "Tauri 2 · Rust 原生进程", false],
    ["网页引擎", info ? engineLabel(info.os) : pending, false],
    ["编辑器", "CodeMirror 6", false],
    ["界面语言", "简体中文（含原生菜单与右键菜单）", false],
    ["配置文件", value(info?.config_path), true],
    ["应用目录", value(info?.config_dir), true],
    ["可执行文件", value(info?.exe_path), true],
    ["当前外观", appearanceText(), false],
    ["功能开关", switchesText(), false],
    ["启动日志", cfg.startupLog ? "全程记录每次启动" : "只在启动出问题时补写", false],
    ["本次会话", `${tabs} 个标签 · ${cfg.folders.length} 个文件夹`, false]
  ];
}

/** 复制出去给排障用的纯文本，和运行环境页看到的是同一份事实 */
export function diagnosticsText(info: AppInfo | null, tabs: number): string {
  return ["RocketNotePad " + APP_VERSION, ...envRows(info, tabs).map(([k, v]) => `${k}：${v}`)].join("\n");
}

function envPanel(info: AppInfo | null, tabs: number, pending = "读取中…"): HTMLElement {
  const panel = el("div", "about-panel");
  panel.appendChild(
    el("p", "about-lead", "下面都是这台机器上的真实取值。路径由后端给出，反馈问题时点「复制诊断信息」即可整段带走。")
  );
  const list = el("div", "about-env");
  for (const [key, value, mono] of envRows(info, tabs, pending)) {
    const row = el("div", "about-env-row");
    row.appendChild(el("span", "about-env-key", key));
    row.appendChild(el("span", "about-env-value" + (mono ? " mono" : ""), value));
    list.appendChild(row);
  }
  panel.appendChild(list);
  // 落盘说明跟着后端报的系统走，和上面的路径行保持一致
  const os = info?.os ?? (IS_MAC ? "macos" : "windows");
  panel.appendChild(
    el(
      "p",
      "about-foot-note",
      os === "macos"
        ? "macOS 上应用不往 .app 包里写任何运行期文件，配置、最近打开与启动日志都在 ~/.rocketnote。"
        : "Windows 上配置优先写在 exe 同目录，整个文件夹拷走设置跟着走；目录不可写时自动退回 %APPDATA%。"
    )
  );
  return panel;
}

function keysPanel(): HTMLElement {
  const panel = el("div", "about-panel");
  panel.appendChild(
    el("p", "about-lead", `快捷键按当前系统渲染（${IS_MAC ? "macOS" : "Windows / Linux"}），与原生菜单里显示的完全一致。`)
  );
  const wrap = el("div", "about-keys");
  for (const group of keyGroups()) {
    const block = el("div", "about-key-block");
    block.appendChild(heading(group.title));
    for (const [keys, action] of group.rows) {
      const row = el("div", "about-key-row");
      row.appendChild(el("span", "about-key-action", action));
      row.appendChild(el("kbd", "about-kbd", keys));
      block.appendChild(row);
    }
    wrap.appendChild(block);
  }
  panel.appendChild(wrap);
  return panel;
}

/* ---------- 面板 ---------- */

let overlay: HTMLElement | null = null;

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]';

export function openAbout(opts: AboutOptions): void {
  overlay?.remove();
  const root = el("div", "palette-overlay about-overlay");
  const box = el("div", "palette-box about-box");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "about-title");
  root.appendChild(box);

  /* 头部 */
  const head = el("div", "about-head");
  head.appendChild(svgEl("about-mark", MARK));
  const id = el("div", "about-id");
  const nameRow = el("div", "about-name-row");
  const title = el("h2", "about-name", "RocketNotePad");
  title.id = "about-title";
  nameRow.appendChild(title);
  nameRow.appendChild(el("span", "about-version", "v" + APP_VERSION));
  id.appendChild(nameRow);
  id.appendChild(el("p", "about-tagline", "本地优先的高性能记事本 · 打开即写，停顿即存，关掉不丢"));
  head.appendChild(id);
  const closeBtn = button("about-close", "×");
  closeBtn.title = "关闭";
  closeBtn.setAttribute("aria-label", "关闭");
  head.appendChild(closeBtn);
  box.appendChild(head);

  /* 分页条 */
  const tabBar = el("div", "about-tabs");
  tabBar.setAttribute("role", "tablist");
  tabBar.setAttribute("aria-label", "关于内容");
  const tabButtons = TABS.map((t) => {
    const b = button("about-tab", t.label);
    b.id = "about-tab-" + t.id;
    b.dataset.tab = t.id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", "about-panel-" + t.id);
    tabBar.appendChild(b);
    return b;
  });
  box.appendChild(tabBar);

  /* 正文 */
  const body = el("div", "about-body");
  let info: AppInfo | null = null;
  const slots = new Map<TabId, HTMLElement>();
  for (const t of TABS) {
    const slot = el("div", "about-slot");
    slot.id = "about-panel-" + t.id;
    slot.setAttribute("role", "tabpanel");
    slot.setAttribute("aria-labelledby", "about-tab-" + t.id);
    slot.tabIndex = 0;
    slot.hidden = true;
    body.appendChild(slot);
    slots.set(t.id, slot);
  }
  const put = (tab: TabId, panel: HTMLElement) => slots.get(tab)!.replaceChildren(panel);
  put("features", featuresPanel());
  put("arch", archPanel());
  put("env", envPanel(null, opts.tabs));
  put("keys", keysPanel());
  box.appendChild(body);

  /* 底部 */
  const foot = el("div", "about-foot");
  foot.appendChild(el("span", "about-hint", "Esc 关闭 · ←→ 切换分页"));
  foot.appendChild(el("span", "tb-spacer"));
  const copyBtn = button("about-btn", "复制诊断信息");
  const configBtn = button("about-btn", "打开配置文件夹");
  configBtn.disabled = true;
  const paletteBtn = button("about-btn about-btn-primary", "命令面板");
  foot.append(copyBtn, configBtn, paletteBtn);
  box.appendChild(foot);

  document.body.appendChild(root);
  overlay = root;

  let closed = false;
  let flashTimer: number | undefined;

  const select = (tab: TabId) => {
    tabButtons.forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    for (const [id, slot] of slots) slot.hidden = id !== tab;
    body.scrollTop = 0;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    window.clearTimeout(flashTimer);
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    if (overlay === root) overlay = null;
    opts.onClose();
  };

  const flash = (text: string) => {
    copyBtn.textContent = text;
    copyBtn.classList.add("flashed");
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      copyBtn.textContent = "复制诊断信息";
      copyBtn.classList.remove("flashed");
    }, 1600);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab") {
      const nodes = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.closest("[hidden]"));
      if (nodes.length > 0) {
        const at = nodes.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (at <= 0 ? nodes.length - 1 : at - 1) : (at + 1) % nodes.length;
        e.preventDefault();
        nodes[next].focus();
      }
      e.stopPropagation();
      return;
    }
    const at = tabButtons.indexOf(document.activeElement as HTMLButtonElement);
    if (at >= 0) {
      const move =
        e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -at : e.key === "End" ? TABS.length - 1 - at : 0;
      if (move !== 0) {
        e.preventDefault();
        const next = (at + move + TABS.length) % TABS.length;
        select(TABS[next].id);
        tabButtons[next].focus();
      }
    }
    // 模态：键盘不该穿过面板落到背后的编辑器上（默认动作如复制、滚动仍然保留）
    e.stopPropagation();
  };

  tabButtons.forEach((b) => b.addEventListener("click", () => select(b.dataset.tab as TabId)));
  closeBtn.addEventListener("click", close);
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });
  copyBtn.addEventListener("click", () => {
    writeText(diagnosticsText(info, opts.tabs))
      .then(() => flash("已复制"))
      .catch(() => flash("复制失败"));
  });
  configBtn.addEventListener("click", () => {
    if (!info) return;
    const target = info.config_exists ? info.config_path : info.config_dir;
    revealInFileManager(target).catch(() => {
      void message(`应用目录还没生成，首次保存设置后会出现在：\n${info?.config_dir ?? ""}`, {
        title: "配置文件位置"
      });
    });
  });
  paletteBtn.addEventListener("click", () => {
    close();
    opts.onPalette();
  });
  document.addEventListener("keydown", onKey, true);

  select("features");
  tabButtons[0].focus();

  appInfo()
    .then((value) => {
      if (closed) return;
      info = value;
      put("env", envPanel(info, opts.tabs));
      configBtn.disabled = !info.config_dir;
    })
    .catch(() => {
      if (closed) return;
      put("env", envPanel(null, opts.tabs, "不可用"));
    });
}
