import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery
} from "@codemirror/search";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from "@codemirror/view";
import { ENTER, IS_MAC, mod } from "./platform";

/** 统计匹配数时的上限，避免超大文档每次选区变化都全文遍历 */
const MAX_COUNT = 2000;

export const PREV_MATCH_HINT = `上一个匹配（${IS_MAC ? "⇧⏎" : "Shift+Enter"}）`;
export const NEXT_MATCH_HINT = `下一个匹配（${ENTER}）`;
export const REPLACE_CURRENT_HINT = `替换当前匹配（${ENTER}）`;
export const REPLACE_ALL_HINT = `替换全部匹配（${mod(ENTER)}）`;

let current: FindPanel | null = null;
let expandOnMount = false;

type Match = { from: number; to: number; precise?: boolean; match?: RegExpExecArray };

function unquote(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_, ch: string) => (ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : "\\"));
}

function expandGroups(repl: string, match?: RegExpExecArray): string {
  if (!match) return repl;
  return repl.replace(/\$(\$|&|\d+)/g, (_all, ref: string) => {
    if (ref === "$") return "$";
    if (ref === "&") return match[0];
    const group = match[Number(ref)];
    return group === undefined ? "" : group;
  });
}

/** 对齐 VS Code 的"保留大小写"：按被匹配文本的大小写风格改写替换结果 */
function adaptCase(source: string, repl: string): string {
  const letters = source.replace(/[^A-Za-z]/g, "");
  if (!letters || !repl) return repl;
  if (letters === letters.toUpperCase()) return repl.toUpperCase();
  if (letters[0] === letters[0].toUpperCase() && letters.slice(1) === letters.slice(1).toLowerCase()) {
    return repl.charAt(0).toUpperCase() + repl.slice(1);
  }
  return repl;
}

function makeButton(cls: string, text: string, title: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = cls;
  el.textContent = text;
  el.title = title;
  el.setAttribute("aria-label", title);
  return el;
}

function makeInput(cls: string, placeholder: string): HTMLInputElement {
  const el = document.createElement("input");
  el.className = cls;
  el.placeholder = placeholder;
  el.setAttribute("aria-label", placeholder);
  el.spellcheck = false;
  return el;
}

export class FindPanel implements Panel {
  readonly dom: HTMLElement;
  private findField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private replaceRow: HTMLDivElement;
  private counter: HTMLSpanElement;
  private toggleBtn: HTMLButtonElement;
  private caseBtn: HTMLButtonElement;
  private wordBtn: HTMLButtonElement;
  private reBtn: HTMLButtonElement;
  private selBtn: HTMLButtonElement;
  private preserveBtn: HTMLButtonElement;
  private replaceBtn: HTMLButtonElement;
  private replaceAllBtn: HTMLButtonElement;
  private query: SearchQuery;
  private expanded = false;
  private preserveCase = false;
  private inSelection: { from: number; to: number; len: number } | null = null;

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);

    const dom = document.createElement("div");
    dom.className = "rnp-find";

    const head = document.createElement("div");
    head.className = "rnp-find-row";

    this.toggleBtn = makeButton("rnp-find-arrow", "❯", "切换为替换");
    this.toggleBtn.addEventListener("click", () => this.setExpanded(!this.expanded));

    this.findField = makeInput("rnp-find-input", "查找");
    this.findField.setAttribute("main-field", "true");
    this.findField.value = this.query.search;
    this.findField.addEventListener("input", () => this.commit());

    this.counter = document.createElement("span");
    this.counter.className = "rnp-find-count";

    this.caseBtn = makeButton("rnp-find-opt", "Aa", "区分大小写");
    this.wordBtn = makeButton("rnp-find-opt", "ab|", "全字匹配");
    this.reBtn = makeButton("rnp-find-opt", ".*", "正则表达式");
    this.selBtn = makeButton("rnp-find-opt", "▣", "在选定内容中查找");
    this.caseBtn.addEventListener("click", () => this.flip(this.caseBtn));
    this.wordBtn.addEventListener("click", () => this.flip(this.wordBtn));
    this.reBtn.addEventListener("click", () => {
      this.inSelection = null;
      this.selBtn.classList.remove("active");
      this.flip(this.reBtn);
    });
    this.selBtn.addEventListener("click", () => {
      if (this.inSelection) {
        this.inSelection = null;
      } else {
        const sel = this.view.state.selection.main;
        // 没有选区时退化为全文查找，避免开关一按就查不到结果
        this.inSelection = sel.empty ? { from: 0, to: this.view.state.doc.length, len: this.view.state.doc.length } : { from: sel.from, to: sel.to, len: this.view.state.doc.length };
      }
      this.selBtn.classList.toggle("active", !!this.inSelection);
      this.commit();
    });

    const prevBtn = makeButton("rnp-find-nav", "↑", PREV_MATCH_HINT);
    const nextBtn = makeButton("rnp-find-nav", "↓", NEXT_MATCH_HINT);
    prevBtn.addEventListener("click", () => this.goto(findPrevious));
    nextBtn.addEventListener("click", () => this.goto(findNext));
    const closeBtn = makeButton("rnp-find-nav rnp-find-close", "✕", "关闭");
    closeBtn.addEventListener("click", () => closeSearchPanel(this.view));

    head.append(this.toggleBtn, this.findField, this.counter, this.caseBtn, this.wordBtn, this.reBtn, this.selBtn, prevBtn, nextBtn, closeBtn);

    this.replaceField = makeInput("rnp-find-input", "替换");
    this.replaceField.value = this.query.replace;
    this.replaceField.addEventListener("input", () => this.commit());

    this.preserveBtn = makeButton("rnp-find-opt", "Ab", "保留大小写");
    this.preserveBtn.addEventListener("click", () => {
      this.preserveCase = !this.preserveCase;
      this.preserveBtn.classList.toggle("active", this.preserveCase);
    });

    const replaceBtn = makeButton("rnp-find-action", "替换", REPLACE_CURRENT_HINT);
    replaceBtn.addEventListener("click", () => this.doReplace());
    const replaceAllBtn = makeButton("rnp-find-action", "全部替换", REPLACE_ALL_HINT);
    replaceAllBtn.addEventListener("click", () => this.doReplaceAll());
    this.replaceBtn = replaceBtn;
    this.replaceAllBtn = replaceAllBtn;

    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "rnp-find-row hidden";
    this.replaceRow.append(this.preserveBtn, this.replaceField, replaceBtn, replaceAllBtn);

    dom.append(head, this.replaceRow);
    dom.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.dom = dom;
    this.applyReadOnly();
    this.refresh();
  }

  get top(): boolean {
    return true;
  }

  mount(): void {
    current = this;
    if (expandOnMount) {
      expandOnMount = false;
      this.focusReplace();
    } else {
      this.findField.focus();
      this.findField.select();
    }
    this.refresh();
  }

  destroy(): void {
    if (current === this) current = null;
  }

  /** 展开替换行并把焦点交给替换输入框 */
  focusReplace(): void {
    this.setExpanded(true);
    this.replaceField.focus();
  }

  update(update: ViewUpdate): void {
    if (update.state.readOnly !== update.startState.readOnly) this.applyReadOnly();
    let changed = false;
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value;
          changed = true;
        }
      }
    }
    if (changed) {
      this.syncFields();
      this.refresh();
      return;
    }
    if (update.docChanged) {
      if (this.inSelection) {
        this.inSelection = null;
        this.selBtn.classList.remove("active");
      }
      this.refresh();
    } else if (update.selectionSet) {
      // findNext/findPrevious 会顺带全选输入框，导航后把光标收回末尾
      if (this.findField === document.activeElement && this.findField.selectionEnd === this.findField.value.length && this.findField.selectionStart === 0) {
        this.caretToEnd();
      }
      this.refresh();
    }
  }

  private flip(btn: HTMLButtonElement): void {
    btn.classList.toggle("active");
    this.commit();
  }

  /** 只读文档（超大文件）不开放替换入口，避免绕过只读保护把文件改脏 */
  private applyReadOnly(): void {
    const ro = this.view.state.readOnly;
    this.replaceBtn.disabled = ro;
    this.replaceAllBtn.disabled = ro;
    this.replaceField.disabled = ro;
    this.replaceBtn.title = ro ? "文件为只读，不能替换" : REPLACE_CURRENT_HINT;
    this.replaceAllBtn.title = ro ? "文件为只读，不能替换" : REPLACE_ALL_HINT;
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.replaceRow.classList.toggle("hidden", !expanded);
    this.toggleBtn.classList.toggle("open", expanded);
    this.toggleBtn.title = expanded ? "收起替换" : "切换为替换";
  }

  private caretToEnd(): void {
    const end = this.findField.value.length;
    this.findField.focus();
    this.findField.setSelectionRange(end, end);
  }

  /** 导航命令会连输入框一起全选，导航完恢复成正常光标 */
  private goto(move: (view: EditorView) => boolean): void {
    move(this.view);
    this.caretToEnd();
    this.refresh();
  }

  private rangeTest = (_match: string, state: EditorState, from: number, to: number): boolean => {
    const range = this.inSelection;
    if (!range || state.doc.length !== range.len) return true;
    return from >= range.from && to <= range.to;
  };

  private buildQuery(): SearchQuery {
    return new SearchQuery({
      search: this.findField.value,
      caseSensitive: this.caseBtn.classList.contains("active"),
      wholeWord: this.wordBtn.classList.contains("active"),
      regexp: this.reBtn.classList.contains("active"),
      replace: this.replaceField.value,
      test: this.inSelection ? this.rangeTest : undefined
    });
  }

  private commit(): void {
    const query = this.buildQuery();
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
    this.refresh();
  }

  private syncFields(): void {
    this.findField.value = this.query.search;
    this.replaceField.value = this.query.replace;
    this.caseBtn.classList.toggle("active", this.query.caseSensitive);
    this.wordBtn.classList.toggle("active", this.query.wholeWord);
    this.reBtn.classList.toggle("active", this.query.regexp);
  }

  private *matches(): Generator<Match> {
    const cursor = this.query.getCursor(this.view.state) as Iterator<Match>;
    for (;;) {
      const step = cursor.next();
      if (step.done) break;
      const value = step.value as Match;
      if (value.precise !== false) yield value;
    }
  }

  private refresh(): void {
    const query = this.query;
    if (!query.search) {
      this.counter.textContent = "";
      this.counter.classList.remove("error");
      return;
    }
    if (!query.valid) {
      this.counter.textContent = "正则有误";
      this.counter.classList.add("error");
      return;
    }
    const sel = this.view.state.selection.main;
    let total = 0;
    let contains = 0;
    let after = 0;
    let overflow = false;
    for (const match of this.matches()) {
      total += 1;
      if (!contains && match.from <= sel.from && match.to >= sel.to) contains = total;
      if (!after && match.from >= sel.to) after = total;
      if (total >= MAX_COUNT) {
        overflow = true;
        break;
      }
    }
    this.counter.classList.remove("error");
    if (total === 0) {
      this.counter.textContent = "无匹配";
    } else {
      this.counter.textContent = `${contains || after || 1} / ${overflow ? `${MAX_COUNT}+` : total}`;
    }
  }

  private replacement(match: Match): { from: number; to: number; insert: string } {
    const text = adaptCase(this.view.state.sliceDoc(match.from, match.to), expandGroups(unquote(this.query.replace), match.match));
    return { from: match.from, to: match.to, insert: text };
  }

  private doReplace(): void {
    if (this.view.state.readOnly) return;
    if (!this.preserveCase) {
      replaceNext(this.view);
      this.caretToEnd();
      return;
    }
    const head = this.view.state.selection.main.from;
    for (const match of this.matches()) {
      if (match.to < head) continue;
      const change = this.replacement(match);
      this.view.dispatch({
        changes: change,
        selection: { anchor: change.from + change.insert.length },
        userEvent: "input.replace"
      });
      return;
    }
  }

  private doReplaceAll(): void {
    if (this.view.state.readOnly) return;
    if (!this.preserveCase) {
      replaceAll(this.view);
      return;
    }
    const changes: ChangeSpec[] = [];
    for (const match of this.matches()) {
      changes.push(this.replacement(match));
    }
    if (!changes.length) return;
    this.view.dispatch({ changes, userEvent: "input.replace.all" });
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
      this.refresh();
      return;
    }
    if (e.altKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
      e.preventDefault();
      this.setExpanded(!this.expanded);
      (this.expanded ? this.replaceField : this.findField).focus();
      return;
    }
    if (e.keyCode !== 13) return;
    if (e.target === this.findField) {
      e.preventDefault();
      if (e.altKey) selectMatches(this.view);
      else this.goto(e.shiftKey ? findPrevious : findNext);
    } else if (e.target === this.replaceField) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey || e.altKey) this.doReplaceAll();
      else this.doReplace();
    }
  }
}

/** 打开查找浮窗并直接展开替换行 */
export function openReplacePanel(view: EditorView): void {
  if (current) {
    current.focusReplace();
    return;
  }
  expandOnMount = true;
  openSearchPanel(view);
}
