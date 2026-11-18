import { describe, expect, it, vi } from "vitest";

// 只取配置对象本身：把 defineConfig 换成恒等映射，避免引入 vite/esbuild 在 jsdom 下的 realm 问题
vi.mock("vite", () => ({ defineConfig: (c: unknown) => c }));

import config from "../../vite.config";

describe("Vite 生产构建配置", () => {
  it("关闭 modulepreload polyfill：WKWebView 的 tauri:// 协议不支持 fetch 预加载，否则语言包动态加载失败、代码无高亮", () => {
    expect(config.build?.modulePreload).toEqual({ polyfill: false });
  });
});