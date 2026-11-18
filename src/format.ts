import type { EditorView } from "@codemirror/view";
import { formatText } from "./api";

export const SQL_LANG = "SQL";

/** 这些语言交给后端调用系统标准格式化工具；SQL 用前端内置格式化器 */
export const EXTERNAL_LANGS = ["Python", "Java", "C", "C++", "Rust", "Go"] as const;

export function isFormatSupported(label: string): boolean {
  return label === SQL_LANG || (EXTERNAL_LANGS as readonly string[]).includes(label);
}

/** SQL 内置纯 JS 格式化器，离线随处可用；动态 import 避免压进主包 */
export async function formatSql(content: string): Promise<string> {
  const { format } = await import("sql-formatter");
  return format(content, {
    language: "sql",
    keywordCase: "upper",
    tabWidth: 2,
    linesBetweenQueries: 1
  });
}

/** 整篇替换文档：单次可撤销事务，光标钳制到新文档长度内 */
export function replaceDocument(view: EditorView, text: string): void {
  const head = Math.min(view.state.selection.main.head, text.length);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: head }
  });
}

/**
 * 格式化整篇文档。SQL 走内置格式化器，其余走后端系统工具。
 * 空文档或格式化后无变化时不产生编辑（也就不会多一条撤销记录、不触发自动保存）。
 * 返回是否真的改动了文档。
 */
export async function formatDocument(view: EditorView, langLabel: string): Promise<boolean> {
  if (view.state.readOnly) return false;
  const content = view.state.doc.toString();
  if (!content.trim()) return false;
  const formatted =
    langLabel === SQL_LANG ? await formatSql(content) : await formatText(langLabel, content);
  // 编辑器内部文档只用 \n；工具可能带回 \r\n，统一掉，行尾风格保存时再按标签展开
  const normalized = formatted.replace(/\r\n?/g, "\n");
  if (normalized === content) return false;
  replaceDocument(view, normalized);
  return true;
}