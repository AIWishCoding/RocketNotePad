import { readAppConfig, writeAppConfig } from "./api";
import type { ThemeName } from "./editor";
import { SYSTEM_FONT } from "./fonts";

/** 默认字号：13px 在 1080p 屏上偏小，15px 更接近系统记事本的观感 */
export const DEFAULT_FONT_SIZE = 15;

export interface AppConfig {
  theme: ThemeName;
  fontSize: number;
  /** 编辑器字体族名；system 表示跟随操作系统的默认界面字体 */
  fontFamily: string;
  wrap: boolean;
  preview: boolean;
  autoSave: boolean;
  minimap: boolean;
  sidebarVisible: boolean;
  /** 全程记录启动日志；关闭时只在启动出问题时补写一份 */
  startupLog: boolean;
  /** 资源管理器里已挂载的文件夹 */
  folders: string[];
  /** 上次退出时打开的标签路径 */
  restoreTabs: string[];
  /** 上次退出时处于活动状态的标签路径 */
  restoreActive: string;
}

const DEFAULTS: AppConfig = {
  theme: "light",
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: SYSTEM_FONT,
  wrap: true,
  preview: true,
  autoSave: true,
  minimap: true,
  sidebarVisible: true,
  startupLog: false,
  folders: [],
  restoreTabs: [],
  restoreActive: ""
};

/** 全应用共用的配置对象：直接读写它的字段，改完调用 saveConfig() 落盘 */
export const cfg: AppConfig = { ...DEFAULTS };

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStr = (v: unknown): v is string => typeof v === "string";
const isPathList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");
const isTheme = (v: unknown): v is ThemeName => v === "light" || v === "dark";
const isFontSize = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 8 && v <= 72;
const isFontFamily = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 80;

const VALIDATORS: Record<keyof AppConfig, (v: unknown) => boolean> = {
  theme: isTheme,
  fontSize: isFontSize,
  fontFamily: isFontFamily,
  wrap: isBool,
  preview: isBool,
  autoSave: isBool,
  minimap: isBool,
  sidebarVisible: isBool,
  startupLog: isBool,
  folders: isPathList,
  restoreTabs: isPathList,
  restoreActive: isStr
};

/** 只接受合法字段：配置文件可能被手工改坏，坏值按默认值处理而不是让应用起不来 */
function applyValues(src: Record<string, unknown>) {
  for (const key of Object.keys(DEFAULTS) as Array<keyof AppConfig>) {
    const value = src[key];
    if (VALIDATORS[key](value)) (cfg as unknown as Record<string, unknown>)[key] = value;
  }
}

function parseConfig(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const legacyBool = (raw: string): boolean | undefined => (raw === "0" ? false : raw === "1" ? true : undefined);
const legacyList = (raw: string): string[] | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPathList(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** 老版本的设置存在 WebView2 的 localStorage 里，配置文件还没生成时先把它搬过来 */
function migrateFromLocalStorage(): boolean {
  const pairs: Array<[keyof AppConfig, string, (raw: string) => unknown]> = [
    ["theme", "rnp.theme", (r) => (isTheme(r) ? r : undefined)],
    ["fontSize", "rnp.fontSize", (r) => isFontSize(Number(r)) ? Number(r) : undefined],
    ["fontFamily", "rnp.fontFamily", (r) => (isFontFamily(r) ? r : undefined)],
    ["wrap", "rnp.wrap", legacyBool],
    ["preview", "rnp.preview", legacyBool],
    ["autoSave", "rnp.autoSave", legacyBool],
    ["minimap", "rnp.minimap", legacyBool],
    ["sidebarVisible", "rnp.sidebar", legacyBool],
    ["folders", "rnp.folders", (r) => legacyList(r)],
    ["restoreTabs", "rnp.restoreTabs", (r) => legacyList(r)],
    ["restoreActive", "rnp.activePath", (r) => r]
  ];
  let moved = false;
  for (const [field, key, read] of pairs) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    const value = read(raw);
    if (value === undefined) continue;
    (cfg as unknown as Record<string, unknown>)[field] = value;
    moved = true;
  }
  return moved;
}

let loaded = false;
let timer: number | undefined;

/** 启动时调用一次：优先读配置文件，没有则从旧版 localStorage 迁移 */
export async function loadConfig(): Promise<void> {
  let text: string | null = null;
  try {
    text = await readAppConfig();
  } catch {
    text = null;
  }
  const parsed = text === null ? null : parseConfig(text);
  if (parsed) applyValues(parsed);
  loaded = true;
  if (!parsed && migrateFromLocalStorage()) await saveConfigNow();
}

/** 改动合并写入：连点缩放这类操作只落一次盘 */
export function saveConfig(): void {
  if (!loaded) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void saveConfigNow(), 300);
}

export async function saveConfigNow(): Promise<void> {
  if (!loaded) return;
  window.clearTimeout(timer);
  try {
    await writeAppConfig(JSON.stringify(cfg, null, 2));
  } catch {
    // 配置文件写不进去也不能打断编辑，本地状态仍然生效
  }
}

window.addEventListener("beforeunload", () => void saveConfigNow());
