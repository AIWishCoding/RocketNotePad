/**
 * 快捷键文案按平台渲染：macOS 用 ⌘/⇧/⌥/⌃ 符号，Windows 与 Linux 用 Ctrl/Shift/Alt 字样，
 * 否则在 Windows 上会显示按不出来的 ⌘ 组合。
 */
export const IS_MAC = /Macintosh|Mac OS X/i.test(navigator.userAgent);

export const IS_WINDOWS = /Windows/i.test(navigator.userAgent);

/** Enter 在不同平台的写法（macOS 沿用符号 ⏎） */
export const ENTER = IS_MAC ? "⏎" : "Enter";

export const mod = (key: string) => (IS_MAC ? `⌘${key}` : `Ctrl+${key}`);
export const shiftMod = (key: string) => (IS_MAC ? `⇧⌘${key}` : `Ctrl+Shift+${key}`);
export const altMod = (key: string) => (IS_MAC ? `⌥⌘${key}` : `Ctrl+Alt+${key}`);
export const ctrlOnly = (key: string) => (IS_MAC ? `⌃${key}` : `Ctrl+${key}`);
