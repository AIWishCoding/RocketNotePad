import { EditorState, Compartment, Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  indentMore,
  indentLess
} from "@codemirror/commands";
import {
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  foldGutter,
  indentOnInput
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { search, searchKeymap, gotoLine, highlightSelectionMatches, selectNextOccurrence } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";
import { FindPanel } from "./find";
import { SYSTEM_FONT, fontStack } from "./fonts";

export type ThemeName = "light" | "dark";

export interface EditorOptions {
  theme: ThemeName;
  fontSize: number;
  /** 字体族名，缺省跟随系统默认字体 */
  fontFamily?: string;
  wrap: boolean;
  /** 超大文件按只读打开：不装撤销栈，也不接受输入，内存占用封顶在文本本身 */
  readOnly?: boolean;
}

export const themeComp = new Compartment();
export const fontComp = new Compartment();
export const wrapComp = new Compartment();
export const readOnlyComp = new Compartment();

function readOnlyExtensions(readOnly: boolean | undefined): Extension[] {
  if (!readOnly) return [];
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    // 只读的强制点在事务层：快捷键命令、替换、粘贴之外的任何改动路径都会被丢弃，
    // 只剩选区和效果类事务，保证超大文件不可能被改脏
    EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr))
  ];
}

export const CN_PHRASES: Record<string, string> = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  "by word": "全字匹配",
  regexp: "正则表达式",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "current match": "当前匹配",
  "replaced $ matches": "已替换 $ 处",
  "replaced match on line $": "已替换第 $ 行的匹配",
  "on line": "所在行",
  "match on line $": "第 $ 行存在匹配",
  "Go to line": "跳转到行",
  "Current line": "当前行",
  go: "跳转",
  "Control character": "控制字符",
  "folded code": "已折叠代码",
  unfold: "展开",
  to: "至",
  "Folded lines": "已折叠行",
  "Unfolded lines": "已展开行",
  "Selection deleted": "选区已删除",
  Completions: "补全建议",
  "Opened a new tab": "已打开新标签页",
  "Opened a new pane": "已打开新窗格"
};

// CodeMirror 的 defaultHighlightStyle 给标题加了 underline，浅色主题下源码里会显示下划线，这里改为仅加粗。
const lightSyntaxStyle = HighlightStyle.define([
  { tag: t.meta, color: "#404740" },
  { tag: t.link, textDecoration: "underline" },
  { tag: [t.heading, t.strong], fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.keyword, t.modifier], color: "#708" },
  { tag: [t.standard(t.variableName), t.special(t.variableName), t.macroName], color: "#256" },
  { tag: [t.atom, t.bool, t.url, t.contentSeparator, t.labelName], color: "#219" },
  { tag: [t.literal, t.inserted], color: "#164" },
  { tag: [t.string, t.deleted], color: "#a11" },
  { tag: [t.regexp, t.escape, t.special(t.string)], color: "#e40" },
  { tag: t.definition(t.variableName), color: "#00f" },
  { tag: t.local(t.variableName), color: "#30a" },
  { tag: [t.typeName, t.namespace], color: "#085" },
  { tag: t.className, color: "#167" },
  { tag: t.definition(t.propertyName), color: "#00c" },
  { tag: t.comment, color: "#940" },
  { tag: t.invalid, color: "#f00" }
]);

const darkBuiltinStyle = HighlightStyle.define([
  { tag: t.standard(t.variableName), color: "#d19a66" }
]);

const darkHighlight = EditorView.theme(
  {
    "&": { backgroundColor: "#282c34" },
    ".cm-gutters": { backgroundColor: "#21252b", borderRight: "1px solid #181a1f" },
    ".cm-activeLineGutter": { backgroundColor: "#2c313a" },
    ".cm-activeLine": { backgroundColor: "#2c313a66" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#3e4451 !important"
    },
    ".cm-cursor": { borderLeftColor: "#fff" },
    ".cm-searchMatch": { backgroundColor: "#4d3800" },
    ".cm-searchMatch-selected": { backgroundColor: "#614d1e" },
    ".cm-panels": { backgroundColor: "#21252b", color: "#abb2bf", borderTop: "1px solid #181a1f", borderBottom: "1px solid #181a1f" },
    ".cm-panels input, .cm-panels button": { color: "#282c34" },
    ".cm-tooltip": { backgroundColor: "#21252b", border: "1px solid #181a1f" }
  },
  { dark: true }
);

const lightHighlight = EditorView.theme({
  "&": { backgroundColor: "#ffffff" },
  ".cm-gutters": { backgroundColor: "#f7f7f7", borderRight: "1px solid #e5e5e5" },
  ".cm-activeLineGutter": { backgroundColor: "#ececec" },
  ".cm-activeLine": { backgroundColor: "#f2f6fc88" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#add6ff !important"
  },
  ".cm-searchMatch": { backgroundColor: "#ffe08a" },
  ".cm-searchMatch-selected": { backgroundColor: "#ffc94d" },
  ".cm-panels": { backgroundColor: "#f7f7f7", color: "#333", borderTop: "1px solid #e0e0e0", borderBottom: "1px solid #e0e0e0" }
});

function themeExtensions(theme: ThemeName): Extension[] {
  return theme === "dark"
    ? [oneDark, syntaxHighlighting(darkBuiltinStyle), darkHighlight]
    : [lightHighlight];
}

function fontTheme(size: number, family?: string): Extension {
  return EditorView.theme({
    ".cm-scroller": {
      fontFamily: fontStack(family ?? SYSTEM_FONT),
      fontSize: size + "px",
      lineHeight: "1.55"
    }
  });
}

export function baseExtensions(opts: EditorOptions, onUpdate?: (view: EditorView) => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    // 只读文档不会有编辑，撤销栈（整篇历史副本）没必要付出内存
    ...(opts.readOnly ? [] : [history()]),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      indentWithTab,
      { key: "Tab", run: indentMore, shift: indentLess },
      { key: "Mod-d", run: selectNextOccurrence }
    ]),
    EditorView.clickAddsSelectionRange.of((e) => e.metaKey || e.ctrlKey),
    search({ top: true, createPanel: (view) => new FindPanel(view) }),
    EditorState.phrases.of(CN_PHRASES),
    themeComp.of(themeExtensions(opts.theme)),
    fontComp.of(fontTheme(opts.fontSize, opts.fontFamily)),
    wrapComp.of(opts.wrap ? EditorView.lineWrapping : []),
    readOnlyComp.of(readOnlyExtensions(opts.readOnly)),
    onUpdate
      ? EditorView.updateListener.of((u) => {
          if (u.docChanged || u.selectionSet || u.focusChanged) onUpdate(u.view);
        })
      : []
  ];
}

export function createState(
  doc: string,
  language: Extension | null,
  opts: EditorOptions,
  onUpdate?: (view: EditorView) => void
): EditorState {
  return EditorState.create({
    doc,
    extensions: [language ? language : [], syntaxHighlighting(lightSyntaxStyle, { fallback: true }), ...baseExtensions(opts, onUpdate)]
  });
}

export function reconfigure(view: EditorView, opts: EditorOptions): void {
  view.dispatch({
    effects: [
      themeComp.reconfigure(themeExtensions(opts.theme)),
      fontComp.reconfigure(fontTheme(opts.fontSize, opts.fontFamily)),
      wrapComp.reconfigure(opts.wrap ? EditorView.lineWrapping : []),
      readOnlyComp.reconfigure(readOnlyExtensions(opts.readOnly))
    ]
  });
}

export function gotoLineNumber(view: EditorView, line: number): void {
  const doc = view.state.doc;
  const n = Math.min(Math.max(1, line), doc.lines);
  const pos = doc.line(n).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" })
  });
  view.focus();
}

export { gotoLine, selectNextOccurrence, EditorView, EditorState };
