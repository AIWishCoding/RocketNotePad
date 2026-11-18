import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"]
    }
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    // WKWebView 的 tauri:// 自定义协议不支持 fetch()，Vite 默认的 modulepreload polyfill
    // 会用 fetch 预加载分包，导致旧版 macOS 上动态 import 的语言包加载失败、代码无高亮。
    // 关掉 polyfill 后改用原生 import() 与 rel="preload"，自定义协议下可正常加载。
    modulePreload: { polyfill: false }
  }
});
