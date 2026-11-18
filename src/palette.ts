import type { FlatFile } from "./sidebar";

export interface Command {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
}

let overlay: HTMLElement | null = null;

export function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return 1000 - t.indexOf(q);
  let qi = 0;
  let score = 0;
  let last = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += last === ti - 1 ? 8 : 2;
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

function closeOverlay() {
  overlay?.remove();
  overlay = null;
}

interface Entry {
  label: string;
  sub?: string;
  action: () => void;
}

function showOverlay(placeholder: string, entries: () => Entry[], onInput?: (value: string) => Entry[] | null) {
  closeOverlay();
  overlay = document.createElement("div");
  overlay.className = "palette-overlay";
  overlay.innerHTML = `
    <div class="palette-box">
      <input class="palette-input" placeholder="${placeholder}" spellcheck="false" />
      <div class="palette-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector<HTMLInputElement>(".palette-input")!;
  const list = overlay.querySelector<HTMLElement>(".palette-list")!;
  let items: Entry[] = [];
  let selected = 0;

  const renderList = () => {
    list.innerHTML = "";
    items.slice(0, 50).forEach((item, i) => {
      const el = document.createElement("div");
      el.className = "palette-item" + (i === selected ? " selected" : "");
      const label = document.createElement("span");
      label.textContent = item.label;
      el.appendChild(label);
      if (item.sub) {
        const sub = document.createElement("span");
        sub.className = "palette-sub";
        sub.textContent = item.sub;
        el.appendChild(sub);
      }
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        run(i);
      });
      list.appendChild(el);
    });
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "无匹配项";
      list.appendChild(empty);
    }
  };

  const filter = () => {
    const q = input.value.trim();
    if (onInput) {
      const custom = onInput(q);
      if (custom) {
        items = custom;
        selected = 0;
        renderList();
        return;
      }
    }
    const all = entries();
    items = all
      .map((e) => ({ e, s: fuzzyScore(q, e.label + " " + (e.sub ?? "")) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.e);
    selected = 0;
    renderList();
  };

  const run = (i: number) => {
    const item = items[i];
    closeOverlay();
    item?.action();
  };

  input.addEventListener("input", filter);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeOverlay();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, Math.min(items.length, 50) - 1);
      renderList();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
      renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(selected);
    }
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeOverlay();
  });
  filter();
  input.focus();
}

export function promptText(title: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    closeOverlay();
    const box = document.createElement("div");
    box.className = "palette-overlay";
    box.innerHTML = `
      <div class="palette-box prompt-box">
        <div class="prompt-title"></div>
        <input class="palette-input" spellcheck="false" />
        <div class="prompt-buttons">
          <button class="prompt-cancel">取消</button>
          <button class="prompt-ok">确定</button>
        </div>
      </div>
    `;
    box.querySelector(".prompt-title")!.textContent = title;
    document.body.appendChild(box);
    overlay = box;
    const input = box.querySelector<HTMLInputElement>(".palette-input")!;
    input.value = initial;
    const done = (value: string | null) => {
      closeOverlay();
      resolve(value);
    };
    box.querySelector(".prompt-ok")!.addEventListener("click", () => {
      const v = input.value.trim();
      if (v) done(v);
    });
    box.querySelector(".prompt-cancel")!.addEventListener("click", () => done(null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const v = input.value.trim();
        if (v) done(v);
      } else if (e.key === "Escape") {
        done(null);
      }
    });
    box.addEventListener("mousedown", (e) => {
      if (e.target === box) done(null);
    });
    input.focus();
    input.select();
  });
}

export function openPalette(commands: Command[]) {
  showOverlay("输入命令…", () =>
    commands.map((c) => ({ label: c.title, sub: c.hint, action: c.run }))
  );
}

export function openGoto(
  files: FlatFile[],
  openFile: (path: string) => void,
  gotoLine: (line: number) => void
) {
  showOverlay(
    "跳转到文件…（输入 :行号 可跳转当前文件的行）",
    () => files.map((f) => ({ label: f.name, sub: f.path, action: () => openFile(f.path) })),
    (q) => {
      const m = q.match(/^(.*?):(\d+)$/);
      if (m && m[1] === "") {
        const line = parseInt(m[2], 10);
        return [{ label: `跳转到第 ${line} 行`, action: () => gotoLine(line) }];
      }
      if (m && m[1]) {
        const name = m[1];
        const line = parseInt(m[2], 10);
        const matched = files
          .map((f) => ({ f, s: fuzzyScore(name, f.name) }))
          .filter((x) => x.s >= 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 20);
        return matched.map(({ f }) => ({
          label: `${f.name}:${line}`,
          sub: f.path,
          action: () => {
            openFile(f.path);
            setTimeout(() => gotoLine(line), 100);
          }
        }));
      }
      return null;
    }
  );
}
