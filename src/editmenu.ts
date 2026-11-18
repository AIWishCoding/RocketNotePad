import { undo, redo, selectAll } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { message } from "@tauri-apps/plugin-dialog";
import { IS_MAC, mod, shiftMod } from "./platform";
import { formatterStatus } from "./api";
import { SQL_LANG, formatDocument, isFormatSupported } from "./format";

export interface EditorMenuInfo {
  readOnly: boolean;
  langLabel: string;
}

type Opts = { hint?: string; disabled?: boolean };

let menu: HTMLElement | null = null;

export function closeEditorMenu(): void {
  menu?.remove();
  menu = null;
}

function selectedText(view: EditorView): string {
  const sel = view.state.selection.main;
  return sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to);
}

async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    await message(String(e), { title: "操作失败", kind: "error" });
  }
}

async function runFormat(view: EditorView, label: string): Promise<void> {
  try {
    await formatDocument(view, label);
    view.focus();
  } catch (e) {
    await message(String(e), { title: "格式化失败", kind: "error" });
  }
}

/**
 * 编辑区右键菜单：保留原生菜单的撤销/重做/剪切/复制/粘贴/全选，并新增「格式化文档」。
 * 复用资源管理器同一套 .ctx-menu 视觉。格式化项按语言与工具可用性决定启用/禁用与提示。
 */
export async function showEditorContextMenu(
  x: number,
  y: number,
  view: EditorView,
  info: EditorMenuInfo
): Promise<void> {
  closeEditorMenu();
  const label = info.langLabel;
  const hasSel = !view.state.selection.main.empty;

  // 先确定格式化项状态：外部工具语言要问后端是否装了工具（只探测不执行，很快）
  let fmtDisabled = false;
  let fmtHint = "";
  if (info.readOnly) {
    fmtDisabled = true;
    fmtHint = "只读文件";
  } else if (!isFormatSupported(label)) {
    fmtDisabled = true;
    fmtHint = "暂不支持该语言";
  } else if (label === SQL_LANG) {
    fmtHint = "内置";
  } else {
    try {
      const st = await formatterStatus(label);
      if (st.available) {
        fmtHint = st.tool;
      } else {
        fmtDisabled = true;
        fmtHint = `未安装 ${st.tool}`;
      }
    } catch {
      fmtDisabled = true;
      fmtHint = "工具检测失败";
    }
  }

  const m = document.createElement("div");
  m.className = "ctx-menu";
  const add = (text: string, fn: () => void, opts: Opts = {}) => {
    const item = document.createElement("div");
    item.className = "ctx-item" + (opts.disabled ? " disabled" : "");
    const span = document.createElement("span");
    span.textContent = text;
    item.appendChild(span);
    if (opts.hint) {
      const hint = document.createElement("span");
      hint.className = "ctx-hint";
      hint.textContent = opts.hint;
      item.appendChild(hint);
    }
    if (!opts.disabled) {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        closeEditorMenu();
        fn();
      });
    }
    m.appendChild(item);
  };
  const sep = () => {
    const s = document.createElement("div");
    s.className = "ctx-sep";
    m.appendChild(s);
  };

  add("撤销", () => void guard(async () => { undo(view); view.focus(); }), {
    hint: mod("Z"),
    disabled: info.readOnly
  });
  add("重做", () => void guard(async () => { redo(view); view.focus(); }), {
    hint: IS_MAC ? shiftMod("Z") : mod("Y"),
    disabled: info.readOnly
  });
  sep();
  add("剪切", () => void guard(async () => {
    const sel = view.state.selection.main;
    if (sel.empty) return;
    await writeText(view.state.sliceDoc(sel.from, sel.to));
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" }, selection: { anchor: sel.from } });
    view.focus();
  }), { hint: mod("X"), disabled: info.readOnly || !hasSel });
  add("复制", () => void guard(async () => {
    const text = selectedText(view);
    if (text) await writeText(text);
  }), { hint: mod("C"), disabled: !hasSel });
  add("粘贴", () => void guard(async () => {
    const text = await readText();
    if (!text) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length }
    });
    view.focus();
  }), { hint: mod("V"), disabled: info.readOnly });
  add("全选", () => { selectAll(view); view.focus(); }, { hint: mod("A") });
  sep();
  add("格式化文档", () => void runFormat(view, label), { hint: fmtHint, disabled: fmtDisabled });

  document.body.appendChild(m);
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  m.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
  m.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";
  menu = m;
}

// 菜单外的左键点击 / Esc 关闭；菜单项自身 stopPropagation，不会冒泡到这里
document.addEventListener("click", () => closeEditorMenu());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeEditorMenu();
});