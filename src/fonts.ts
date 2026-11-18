import { IS_MAC, IS_WINDOWS } from "./platform";

/** 配置里的默认值：不写死某一款字体，跟着操作系统自己的界面字体走 */
export const SYSTEM_FONT = "system";

/** 各平台的系统界面字体栈，也就是「系统默认」这一项真正解析出来的结果 */
export const SYSTEM_STACK = IS_MAC
  ? '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif'
  : IS_WINDOWS
    ? '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif'
    : 'system-ui, "Noto Sans", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';

export interface FontChoice {
  /** 写进配置文件的名字；system 表示跟随系统，其余就是字体族名 */
  id: string;
  /** 界面上的中文名 */
  label: string;
  /** 实际交给 CSS/canvas 的字体栈 */
  stack: string;
  /** 等宽字体在记事本里对齐更整齐，选择列表里标出来 */
  mono: boolean;
}

const mono = (id: string, label: string, fallback: string): FontChoice => ({
  id,
  label,
  stack: `"${id}", ${fallback}`,
  mono: true
});

const sans = (id: string, label: string, fallback: string): FontChoice => ({
  id,
  label,
  stack: `"${id}", ${fallback}`,
  mono: false
});

const MAC_MONO = '"SF Mono", Menlo, monospace';
const MAC_CJK = '"PingFang SC", "Helvetica Neue", sans-serif';
const WIN_MONO = 'Consolas, "Courier New", monospace';
const WIN_CJK = '"Microsoft YaHei", "Segoe UI", sans-serif';
const NIX_MONO = '"DejaVu Sans Mono", monospace';
const NIX_CJK = '"Noto Sans CJK SC", "Noto Sans", sans-serif';

const SYSTEM_CHOICE: FontChoice = {
  id: SYSTEM_FONT,
  label: "系统默认",
  stack: SYSTEM_STACK,
  mono: false
};

/** 只列各平台自带的字体：选了就一定在，不会出现「选了个没装的字体结果毫无变化」 */
const MAC_FONTS: FontChoice[] = [
  SYSTEM_CHOICE,
  mono("SF Mono", "SF Mono", MAC_MONO),
  mono("Menlo", "Menlo", MAC_MONO),
  mono("Monaco", "Monaco", MAC_MONO),
  mono("Courier New", "Courier New", MAC_MONO),
  sans("Helvetica Neue", "Helvetica Neue", MAC_CJK),
  sans("Avenir Next", "Avenir Next", MAC_CJK),
  sans("Georgia", "Georgia", "Times New Roman, serif"),
  sans("PingFang SC", "苹方", MAC_CJK),
  sans("Songti SC", "宋体-简", '"Songti TC", serif'),
  sans("Kaiti SC", "楷体-简", '"Kaiti TC", serif'),
  sans("Heiti SC", "黑体-简", MAC_CJK)
];

const WINDOWS_FONTS: FontChoice[] = [
  SYSTEM_CHOICE,
  mono("Consolas", "Consolas", WIN_MONO),
  mono("Cascadia Mono", "Cascadia Mono", WIN_MONO),
  mono("Cascadia Code", "Cascadia Code", WIN_MONO),
  mono("Lucida Console", "Lucida Console", WIN_MONO),
  mono("Courier New", "Courier New", WIN_MONO),
  sans("Segoe UI", "Segoe UI", WIN_CJK),
  sans("Microsoft YaHei", "微软雅黑", WIN_CJK),
  sans("DengXian", "等线", WIN_CJK),
  sans("SimSun", "宋体", '"NSimSun", serif'),
  sans("SimHei", "黑体", WIN_CJK),
  sans("KaiTi", "楷体", '"DFKai-SB", serif'),
  sans("FangSong", "仿宋", '"STFangsong", serif')
];

const LINUX_FONTS: FontChoice[] = [
  SYSTEM_CHOICE,
  mono("DejaVu Sans Mono", "DejaVu Sans Mono", NIX_MONO),
  mono("Liberation Mono", "Liberation Mono", NIX_MONO),
  mono("Ubuntu Mono", "Ubuntu Mono", NIX_MONO),
  mono("Noto Sans Mono CJK SC", "Noto 等宽 CJK", NIX_MONO),
  sans("Noto Sans", "Noto Sans", NIX_CJK),
  sans("Noto Sans CJK SC", "Noto 思源黑体", NIX_CJK),
  sans("Noto Serif CJK SC", "Noto 思源宋体", '"Noto Serif", serif'),
  sans("DejaVu Sans", "DejaVu Sans", NIX_CJK),
  sans("Liberation Sans", "Liberation Sans", NIX_CJK)
];

export const COMMON_FONTS: FontChoice[] = IS_MAC
  ? MAC_FONTS
  : IS_WINDOWS
    ? WINDOWS_FONTS
    : LINUX_FONTS;

/**
 * 自定义字体名要拼进 CSS 与 canvas 的 font 字符串，先把引号、分号、花括号这类
 * 能改变语法结构的字符清掉，免得一个字体名把整条样式声明带偏。
 */
export function normalizeFamily(raw: string): string {
  return raw
    .replace(/["'`;{}\\<>\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function fontChoice(id: string): FontChoice | undefined {
  return COMMON_FONTS.find((f) => f.id === id);
}

/** 把配置里的字体名解析成字体栈；没见过的名字按自定义字体处理，后面挂系统栈兜底 */
export function fontStack(id: string): string {
  if (!id || id === SYSTEM_FONT) return SYSTEM_STACK;
  const known = fontChoice(id);
  if (known) return known.stack;
  const name = normalizeFamily(id);
  return name ? `"${name}", ${SYSTEM_STACK}` : SYSTEM_STACK;
}

export function fontLabel(id: string): string {
  if (!id || id === SYSTEM_FONT) return SYSTEM_CHOICE.label;
  return fontChoice(id)?.label ?? (normalizeFamily(id) || SYSTEM_CHOICE.label);
}

export function isMonoFont(id: string): boolean {
  return fontChoice(id)?.mono ?? false;
}