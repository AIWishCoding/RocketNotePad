import { DEFAULT_FONT_SIZE } from "./config";
import { COMMON_FONTS, SYSTEM_FONT, fontStack, normalizeFamily } from "./fonts";
import { fuzzyScore } from "./palette";
import { ENTER } from "./platform";

const SAMPLE = "AaBbGg 汉字排版 0123";
const MIN_SIZE = 9;
const MAX_SIZE = 40;

export interface FontPickerOptions {
  current: string;
  fontSize: number;
  /** 上下键与悬停时实时试穿，不写配置 */
  onPreview: (family: string, fontSize: number) => void;
  /** 选定：写配置并落盘 */
  onCommit: (family: string, fontSize: number) => void;
  /** 取消：恢复打开前的字体与字号 */
  onCancel: () => void;
}

interface Row {
  id: string;
  label: string;
  mono: boolean;
  custom: boolean;
}

let overlay: HTMLElement | null = null;

function rows(query: string, current: string): Row[] {
  const q = query.trim();
  const candidates: Row[] = COMMON_FONTS.map((f) => ({
    id: f.id,
    label: f.label,
    mono: f.mono,
    custom: false
  }));
  // 当前用的是没收录的自定义字体时也要列出来，否则一打开面板就把它挤掉了
  const name = normalizeFamily(q);
  const currentName = normalizeFamily(current);
  if (
    currentName &&
    currentName !== SYSTEM_FONT &&
    !COMMON_FONTS.some((f) => f.id.toLowerCase() === currentName.toLowerCase())
  ) {
    candidates.unshift({ id: currentName, label: currentName, mono: false, custom: true });
  }
  const matched = candidates
    .map((row) => ({ row, score: fuzzyScore(q, `${row.label} ${row.id}`) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.row);
  // 输入没收录的字体名时给一条自定义项，装了别的字体也能直接用
  if (name && !candidates.some((r) => r.id.toLowerCase() === name.toLowerCase())) {
    matched.push({ id: name, label: `使用「${name}」`, mono: false, custom: true });
  }
  return matched;
}

export function openFontPicker(opts: FontPickerOptions): void {
  overlay?.remove();
  const root = document.createElement("div");
  root.className = "palette-overlay";
  root.innerHTML = `
    <div class="palette-box font-box" role="dialog" aria-label="选择字体">
      <div class="font-head">
        <span class="font-title">字体</span>
        <div class="font-size">
          <span class="font-size-label">字号</span>
          <button class="font-step font-minus" title="缩小字号" aria-label="缩小字号">−</button>
          <span class="font-size-value"></span>
          <button class="font-step font-plus" title="放大字号" aria-label="放大字号">+</button>
          <button class="font-size-reset" title="恢复默认字号">重置</button>
        </div>
      </div>
      <input class="palette-input font-input" placeholder="搜索字体；输入名称可直接使用自定义字体" spellcheck="false" />
      <div class="font-list" role="listbox" aria-label="字体列表"></div>
      <div class="font-foot">↑↓ 试穿 · ${ENTER} 选定 · Esc 取消</div>
    </div>
  `;
  document.body.appendChild(root);
  overlay = root;

  const input = root.querySelector<HTMLInputElement>(".font-input")!;
  const list = root.querySelector<HTMLElement>(".font-list")!;
  const sizeValue = root.querySelector<HTMLElement>(".font-size-value")!;
  let items: Row[] = [];
  let selected = 0;
  let size = opts.fontSize;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    root.remove();
    if (overlay === root) overlay = null;
  };

  const preview = () => {
    const row = items[selected];
    if (row) opts.onPreview(row.id, size);
  };

  const renderSize = () => {
    sizeValue.textContent = `${size}px`;
  };

  const renderList = () => {
    list.innerHTML = "";
    items.forEach((row, i) => {
      const el = document.createElement("div");
      el.className = "font-item" + (i === selected ? " selected" : "");
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", String(i === selected));
      el.dataset.font = row.id;

      const name = document.createElement("span");
      name.className = "font-name";
      name.textContent = row.label;
      const sample = document.createElement("span");
      sample.className = "font-sample";
      sample.style.fontFamily = fontStack(row.id);
      sample.textContent = SAMPLE;
      const tags = document.createElement("span");
      tags.className = "font-tags";
      if (row.id === opts.current) tags.appendChild(tag("当前", "font-tag-current"));
      if (row.custom) tags.appendChild(tag("自定义", ""));
      else if (row.mono) tags.appendChild(tag("等宽", ""));
      else if (row.id === SYSTEM_FONT) tags.appendChild(tag("跟随系统", ""));

      el.append(name, sample, tags);
      el.addEventListener("mouseenter", () => {
        if (selected === i) return;
        selected = i;
        markSelected();
        preview();
      });
      el.addEventListener("mousedown", (e) => e.preventDefault());
      el.addEventListener("click", () => commit(i));
      list.appendChild(el);
    });
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "无匹配字体";
      list.appendChild(empty);
    }
  };

  const markSelected = () => {
    [...list.children].forEach((el, i) => {
      el.classList.toggle("selected", i === selected);
      el.setAttribute("aria-selected", String(i === selected));
    });
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  };

  const commit = (i: number) => {
    const row = items[i];
    close();
    if (row) opts.onCommit(row.id, size);
    else opts.onCancel();
  };

  const cancel = () => {
    close();
    opts.onCancel();
  };

  const filter = () => {
    items = rows(input.value, opts.current);
    const at = items.findIndex((r) => r.id === opts.current);
    selected = at >= 0 ? at : 0;
    renderList();
  };

  const stepSize = (delta: number) => {
    size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, size + delta));
    renderSize();
    preview();
  };

  root.querySelector(".font-minus")!.addEventListener("click", () => stepSize(-1));
  root.querySelector(".font-plus")!.addEventListener("click", () => stepSize(1));
  root.querySelector(".font-size-reset")!.addEventListener("click", () => {
    size = DEFAULT_FONT_SIZE;
    renderSize();
    preview();
  });

  input.addEventListener("input", filter);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.max(0, Math.min(selected + 1, items.length - 1));
      markSelected();
      preview();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
      markSelected();
      preview();
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(selected);
    }
  });
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) cancel();
  });

  renderSize();
  filter();
  preview();
  input.focus();
}

function tag(text: string, extra: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "font-tag" + (extra ? " " + extra : "");
  el.textContent = text;
  return el;
}