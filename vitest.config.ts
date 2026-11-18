import { defineConfig } from "vitest/config";

/**
 * 测试专用配置：与 vite.config.ts 分离，避免影响 tauri 开发/构建流程。
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    css: false,
    globals: false,
    restoreMocks: true,
    testTimeout: 20000,
    hookTimeout: 20000
  }
});
