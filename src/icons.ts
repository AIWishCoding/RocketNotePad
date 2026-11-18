/** 侧边栏图标：内联 SVG，风格对齐 VS Code 资源管理器 */

function svg(inner: string): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${inner}</svg>`;
}

export const chevronSvg = svg(
  '<path d="M6 3.6 10.2 8 6 12.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
);

export const folderClosedSvg = svg(
  '<path d="M1.6 3.6a1 1 0 0 1 1-1h3l1.4 1.6h6.4a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11.8a1 1 0 0 1-1-1V3.6Z" fill="currentColor"/>'
);

export const folderOpenSvg = svg(
  '<path d="M1.6 3.6a1 1 0 0 1 1-1h3l1.4 1.6h6.4a1 1 0 0 1 1 1V6.6H1.6V3.6Z" fill="currentColor" opacity=".65"/>' +
    '<path d="M1 13.2 2.9 8.1h12.3L13.2 13.2H1Z" fill="currentColor"/>'
);

const PAGE =
  '<path d="M3.6 1.8h5.6L13 5.4v8.2a.9.9 0 0 1-.9.9H3.6a.9.9 0 0 1-.9-.9V2.7a.9.9 0 0 1 .9-.9Z" fill="none" stroke="currentColor" stroke-width="1"/>' +
  '<path d="M9.1 2v3.5H12.7" fill="none" stroke="currentColor" stroke-width="1"/>';

const PICTURE =
  '<path d="M2.4 4.2h11.2v7.6H2.4z" fill="none" stroke="currentColor" stroke-width="1"/>' +
  '<path d="m3.4 10.6 3-3.2 2.2 2.3 2.1-2.5 2 3.4z" fill="currentColor"/>' +
  '<circle cx="5.6" cy="6.2" r="1" fill="currentColor"/>';

/** 扩展名 → [角标文字, 颜色]，文字为空时用普通文档轮廓 */
const BY_EXT: Record<string, [string, string]> = {
  md: ["MD", "#519aba"],
  markdown: ["MD", "#519aba"],
  json: ["{}", "#cbcb41"],
  jsonc: ["{}", "#cbcb41"],
  json5: ["{}", "#cbcb41"],
  js: ["JS", "#b0a32a"],
  mjs: ["JS", "#b0a32a"],
  cjs: ["JS", "#b0a32a"],
  jsx: ["JS", "#3178c6"],
  ts: ["TS", "#3178c6"],
  tsx: ["TS", "#2f8fd2"],
  html: ["<>", "#e34c26"],
  htm: ["<>", "#e34c26"],
  vue: ["V", "#41b883"],
  css: ["#", "#6b47b8"],
  scss: ["S", "#c6538c"],
  less: ["L", "#2f6db5"],
  py: ["PY", "#3572a5"],
  rs: ["RS", "#c0652f"],
  go: ["GO", "#1098b5"],
  java: ["J", "#b07219"],
  kt: ["K", "#7f5bce"],
  c: ["C", "#4e6cc0"],
  h: ["H", "#5b7fd4"],
  cpp: ["C+", "#f34b7d"],
  cc: ["C+", "#f34b7d"],
  hpp: ["C+", "#f34b7d"],
  cs: ["C#", "#6a44a8"],
  rb: ["RB", "#cc342d"],
  php: ["P", "#7377ad"],
  swift: ["SW", "#f05138"],
  sh: ["$", "#4d9a6a"],
  bash: ["$", "#4d9a6a"],
  zsh: ["$", "#4d9a6a"],
  bat: ["$", "#8a919c"],
  ps1: ["PS", "#4d65a8"],
  yml: ["Y", "#8250df"],
  yaml: ["Y", "#8250df"],
  toml: ["T", "#8a919c"],
  xml: ["<>", "#0a6fb8"],
  sql: ["DB", "#b17b2f"],
  lua: ["LUA", "#3a3fb5"],
  r: ["R", "#4a6fa5"],
  dart: ["D", "#00a4b5"],
  ex: ["EX", "#9c7fb8"],
  exs: ["EX", "#9c7fb8"],
  clj: ["CLJ", "#4d8a4d"],
  gif: ["", "#a074c4"],
  png: ["", "#a074c4"],
  jpg: ["", "#a074c4"],
  jpeg: ["", "#a074c4"],
  webp: ["", "#a074c4"],
  bmp: ["", "#a074c4"],
  ico: ["", "#a074c4"],
  svg: ["", "#a074c4"],
  pdf: ["PDF", "#db4437"],
  zip: ["Z", "#9a8f7a"],
  tar: ["Z", "#9a8f7a"],
  gz: ["Z", "#9a8f7a"],
  rar: ["Z", "#9a8f7a"],
  xlsx: ["X", "#217346"],
  xls: ["X", "#217346"],
  csv: ["C", "#217346"],
  doc: ["W", "#2b579a"],
  docx: ["W", "#2b579a"],
  pptx: ["P", "#d24726"],
  lock: ["", "#8a919c"],
  gitignore: ["", "#d96a3c"],
  log: ["", "#8a919c"],
  txt: ["", "#8a919c"]
};

export function fileIconSvg(name: string): string {
  const lower = name.toLowerCase();
  let key = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
  if (key === lower && !lower.includes(".")) {
    // 无扩展名的文件名（package.json 之类已带点，这里只剩 LICENSE/Makefile 等）
    key = "";
  }
  const hit = BY_EXT[key];
  const color = hit ? hit[1] : "#8a919c";
  const label = hit ? hit[0] : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"].includes(key)) {
    return svg(`<g color="${color}">${PICTURE}</g>`);
  }
  if (!label) return svg(`<g color="${color}">${PAGE}</g>`);
  const size = label.length >= 3 ? 4 : label.length === 2 ? 5 : 6;
  return svg(
    `<g color="${color}">${PAGE}<text x="8" y="${12.6 - size * 0.12}" text-anchor="middle" font-size="${size}" font-weight="700" font-family="-apple-system, 'PingFang SC', 'Segoe UI', sans-serif" fill="currentColor">${label}</text></g>`
  );
}
