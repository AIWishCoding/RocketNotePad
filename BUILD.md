# RocketNotePad 构建、打包与运行指南

高性能本地记事本（Notepad++ / Sublime 风格）。技术栈：Rust + Tauri 2 + CodeMirror 6（TypeScript / Vite）。
支持 macOS 与 Windows 双端。本文档汇总全部环境准备、开发启动、检查测试、打包发布命令。

---

## 1. 环境准备

### 1.1 通用依赖

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| Rust | stable ≥ 1.82 | 通过 rustup 安装 |
| Node.js | ≥ 20（推荐 22） | 前端构建与 Tauri CLI |
| npm | 随 Node.js | 包管理 |

安装 Rust（已装可跳过）：

```bash
# macOS（Homebrew，rustup 为 keg-only）
brew install rustup
rustup default stable

# 或官方脚本（macOS / Linux）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Windows
# 下载 https://rustup.rs 的 rustup-init.exe 运行；
# 另需安装 Visual Studio C++ Build Tools 与 WebView2 Runtime
```

> **本机注意（macOS Homebrew 安装）**：rustup 是 keg-only，未链接进 PATH。
> 每次新开终端执行 cargo / rustc 前需先：
>
> ```bash
> export PATH=/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH
> ```
>
> 或永久写入 `~/.zshrc`：
>
> ```bash
> printf '%s\n' 'export PATH=/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH' >> ~/.zshrc
> ```

### 1.2 平台额外要求

- **macOS**：Xcode Command Line Tools（`xcode-select --install`）；打包 dmg 需要 Finder 自动化权限（见 §6 常见问题）。
- **Windows**：Visual Studio 2022 C++ Build Tools、WebView2 Runtime（安装包默认使用 downloadBootstrapper 自动引导）。

### 1.3 安装项目依赖

```bash
cd RocketNotePad
npm install          # 前端依赖 + Tauri CLI（Rust 依赖在首次 cargo 构建时自动拉取）
```

---

## 2. 开发启动（热重载）

```bash
npm run tauri dev
```

- 自动启动 Vite dev server（http://localhost:1420）并编译运行 Rust 调试版窗口。
- 前端改动即时热更新；Rust 改动自动重编译重启。
- 首次运行需编译全部 Rust 依赖，约数分钟；之后增量编译很快。

仅调试前端界面（浏览器打开 http://localhost:1420，文件 I/O 等原生能力不可用）：

```bash
npm run dev
```

---

## 3. 检查与测试

```bash
# 一键全量：前端类型检查 + vitest（555 例）+ Rust 单元测试（91 例）
npm run test:all

# 只跑前端测试（unit 纯逻辑 + e2e 应用级，全部跑在 jsdom 与 Tauri mock 上，不需要启动窗口）
npm run test            # 等价于 vitest run
npm run test:types      # tsc 检查 src 与 tests 的类型
npx vitest run tests/e2e/app-view.test.ts   # 单个文件
npx vitest run -t "状态栏"                   # 按用例名筛选

# 前端类型检查 + 生产构建（不启动窗口）
npm run build

# Rust 编译检查（在 src-tauri 目录下）
cd src-tauri
cargo check

# Rust 单元测试（编码检测/换行/大文件性能/目录扫描/文件增改）
cargo test --lib

# 查看大文件读取性能输出（ timings 直接打印到 stdout）
cargo test --lib large_file -- --nocapture
cargo test --lib 16mb -- --nocapture        # 16MB UTF-8 / UTF-16 / GB18030 与目录树基准
cargo test --lib detection_scans -- --nocapture  # 编码嗅探只扫前缀的耗时
```

### 3.1 测试分层

| 层 | 位置 | 覆盖内容 |
| --- | --- | --- |
| 后端 | `src-tauri/src/commands/files.rs` 的 `#[cfg(test)]` | 编码识别（UTF-8/BOM/UTF-16/GB18030/BIG5/Shift_JIS/EUC-KR/windows-1252 回退）、行尾检测与归一化、按行尾/编码写回的字节级往返、原子写不留残留、大文件与稀疏文件、目录扫描与树、重命名/删除/复制 |
| 后端 | `src-tauri/src/paths.rs` 的 `#[cfg(test)]` | 各平台应用目录的候选顺序（macOS 只认 `~/.rocketnote`、Windows/Linux 保留 exe 同目录优先）、读第一个存在的位置、写第一个能写的位置并补建父目录、老位置文件的一次性搬移（不覆盖、不删源） |
| 后端 | `src-tauri/src/commands/config.rs` 的 `#[cfg(test)]` | 配置文件在 macOS 落到 `~/.rocketnote`、读写命中同一份、老配置搬移后内容一致、主位置是目录时退回下一候选 |
| 后端 | `src-tauri/src/commands/app.rs` 的 `#[cfg(test)]` | 「关于」面板取的是真正在用的那份配置路径、配置目录是其父目录、crate 版本与 `tauri.conf.json` 打包版本一致 |
| 后端 | `src-tauri/src/commands/format.rs` 的 `#[cfg(test)]` | 各语言到格式化工具的映射、不支持语言的中文报错、行尾归一化、按目录探测可执行文件（含先后顺序）、缺工具时给出安装提示；装有 rustfmt/clang-format 时真实格式化（CI 无工具则跳过） |
| 前端纯逻辑 | `tests/unit/*.test.ts` | 图标、语言识别与高亮加载、编辑器能力配置、Markdown/mermaid 预览、小地图、侧边栏行为、命令契约、配置文件的默认值/校验/迁移/防抖落盘、「关于」面板的分页/焦点/模态/诊断信息、格式化语言判定/SQL 内置格式化/整篇替换编排、编辑区右键菜单的构成/启用状态/各项动作/关闭 |
| 应用级 e2e | `tests/e2e/*.test.ts` | 在 jsdom 中挂载真实 UI 并用 Tauri mock 后端驱动：标签页、打开/保存/另存为、命令面板、菜单命令、查找替换、跳转行、Markdown 预览、主题/缩放/换行/侧栏/小地图开关、状态栏、自动保存、退出确认、超大文件只读打开、配置设置写回配置文件、「关于」面板的打开/关闭/命令串联、编辑区右键菜单与「格式化文档」（SQL 内置/外部工具/缺工具禁用/只读禁用/命令面板入口） |

`tests/helpers/tauri-mock.ts` 用虚拟文件系统实现全部 `invoke` 命令，行为与 Rust 侧对齐（行尾归一化、行尾统计、按行尾展开写回），因此前端用例无需真实窗口；对话框、消息、最近文件通过 `installTauriMock({ dialogs, recent })` 注入。

### 3.2 性能基准与内存封顶

后端把内存和 CPU 的天花板放在三处，都有对应基准用例守住：

| 优化 | 做法 | 基准（release，Apple Silicon） | 守门用例 |
| --- | --- | --- | --- |
| 编码嗅探代价与文件大小无关 | legacy 编码（GB18030/BIG5/Shift_JIS/EUC-KR）只解码第一个高位字节起算的 64 KiB 窗口，用流式解码器（半个字符会被缓冲，不误判为坏字节），整篇只做一次 UTF-8 校验 | 16 MB GB18030 嗅探 26 ms（旧实现要对整篇做四次解码） | `detection_scans_only_a_window_not_the_whole_file` |
| 读取路径少复制 | 解码后立即 `drop` 原始字节，BOM 用 `drain`、坏字节用 `retain` 原地处理，行尾归一化单遍完成（无 `\r` 时直接跳过，不分配等大副本） | 16 MB UTF-8 55 ms、16 MB UTF-16LE 144 ms、16 MB GB18030 676 ms、9 MB 日志 28 ms | `read_16mb_*`、`read_9mb_plain_text_is_flagged_large_but_complete`、`normalize_newlines_*` |
| 超大文件只读打开 | 超过 8 MB（`EDIT_SIZE_LIMIT`）后端返回 `large: true`，前端不装撤销栈、`EditorState.readOnly` + `transactionFilter` 丢弃一切改动事务，查找替换的替换入口同时禁用 | 超过 64 MB 直接拒绝读取，只 stat 不读盘（4 µs） | `only_marks_files_over_the_edit_limit_as_large`、`oversized_rejection_does_not_read_the_file`、`tests/e2e/app-largefile.test.ts` |
| 小地图重绘与行数解耦 | 按像素行采样（最多 1500 行），绘制代价只跟画布高度相关 | 6 万行与 5 千行的单次绘制代价相同 | `tests/unit/minimap.test.ts` 的「重绘代价与文档行数无关」 |
| 拖选/输入不再强制同步布局 | 更新回调里只写缓存过的状态栏文本，读几何量（`scrollHeight`/`clientHeight`）的小地图指示器与预览滚动同步挪到 `requestAnimationFrame`（`src/frame.ts` 的 `perFrame`），一帧最多读一次、位置没变就不写样式；预览没打开时不拼整篇文档字符串，`setActive` 对同一份文档幂等 | 2500 行文档 + 小地图开启，真实浏览器里逐帧拖选 90 帧：中位 16.7 ms、p95 18.7 ms、最大 21 ms，超 32 ms 的帧 0 个、long task 0 个；逐帧输入 90 帧：中位 16.6 ms、p95 17.7 ms、超 32 ms 的帧 0 个 | `tests/unit/frame.test.ts`（200 次选区更新同步读几何量为 0、每帧读取次数固定）、`tests/e2e/app-smoothness.test.ts`（未变字段零重写、预览隐藏时零渲染） |

尚未实现的是分块/惰性加载：8 MB 以上的文件仍要一次性读进内存并整篇交给 CodeMirror，只是从此不可编辑，避免撤销栈和增量结构把占用放大数倍。

在浏览器 harness（`npm run dev` + 注入 mock）里用同一个 10 MB / 16 万行文档对照实测：

| 场景 | JS 堆 | 打开到首屏 | 输入代价 |
| --- | --- | --- | --- |
| `large: true`（只读） | ≈ 37 MB（含侧边栏与标签） | 约 30 ms，只渲染视口内 14 行 | 键入/回车被事务层丢弃，文档与磁盘内容不变，标签不出现 ● |
| 同一文档强制可编辑 | 同量级 | 相近 | 30 次插入耗时 3001 ms，即每次编辑要为撤销栈与增量结构付约 100 ms |

应用本体（.app）空闲态实测 CPU 0.0%，主进程 + WKWebView 四个辅助进程合计约 90–180 MB，随恢复的标签数量浮动。

前端大文件阈值可用 `installTauriMock({ largeFileLimit })` 压低，无需真造 8 MB 文本就能在 jsdom 里跑只读路径。

### 3.3 持续集成

`.github/workflows/test.yml` 在 push/PR 时跑两个 job：`ubuntu` 上做前端类型检查与 vitest，`macos`/`windows` 上跑 `cargo test`（Linux 无 webkit2gtk 开发库，Rust 编译会失败，因此后端 job 只覆盖发布平台）。

当前仓库的远端是 Gitee，GitHub Actions 不会自动触发；需要在 GitHub 建立镜像仓库（或用 Gitee Go 流水线执行同样的 `npm run test:all`）后该工作流才会运行。本地与打包前的验收命令仍是：

```bash
npm run test:all
```

### 3.4 配置持久化（macOS 为 `~/.rocketnote`，Windows 为 exe 同目录）

应用的可调项只有一份真相：`src/config.ts` 导出的 `cfg: AppConfig`。主题、字号（默认 **15px**，
8–72 夹范围）、编辑器字体（`fontFamily`，默认 **`system`** 跟随操作系统默认界面字体，见 §3.7）、
自动换行、Markdown 预览、自动保存、小地图、侧边栏显隐、启动日志（`startupLog`，
默认 **关闭**，见 §3.5），加上「上次文件夹 / 上次标签 / 上次活动文件」，全部是这份对象的字段；
侧边栏、小地图、命令面板直接读写它，不再有第二套 localStorage 状态。

落盘由后端两个命令完成（`src-tauri/src/commands/config.rs`）：

| 命令 | 作用 |
| --- | --- |
| `read_app_config` | 按候选顺序返回第一份存在的文件内容，都没有则 `null` |
| `write_app_config` | 按同一顺序写，第一个写成功的路径胜出，全失败返回错误串 |

候选目录由 `src-tauri/src/paths.rs` 统一决定，配置文件、最近打开、启动日志共用同一套顺序：
macOS 只有一条 —— 用户主目录下的隐藏文件夹 `~/.rocketnote`（`.app` 是交付物，不该往里塞运行期
文件；收进一个隐藏目录后，卸载时还剩什么一眼就能看到）。Windows/Linux 保持便携语义：
`current_exe()` 的父目录优先（整个文件夹拷走，设置一起走），其次 `app.path().app_config_dir()`，
后者兜住装到 `C:\Program Files` 这类普通权限写不进去的位置。

老位置一次性搬移：macOS 上若 `~/.rocketnote` 里还没有这个文件，而 `.app` 包内或
`~/Library/Application Support/com.maple.rocketnotepad/` 有同名文件，就复制过来。只复制、不覆盖、
不删源文件，所以升级后设置与最近打开原样还在，用户想退回旧版本也仍能看到自己的配置。
`clear_recent` 会把老位置那份一起删掉，否则下次启动又会被搬回来。

写入时机：`saveConfig()` 300 ms 防抖合并（连续点缩放不会疯狂写盘），关窗口与 `beforeunload`
走 `saveConfigNow()` 立即冲刷；配置尚未读取成功前不写盘，避免用默认值覆盖掉用户的旧配置。
读取容错：JSON 坏了、类型不对、字段非法一律丢弃该字段并保留其余默认值；文件写失败静默跳过，
不影响本次使用。老用户此前存在 WebView2 localStorage 里的 `rnp.*` 键，首次启动时若配置文件
不存在会自动迁进配置文件。

### 3.5 启动可观测性（`src-tauri/src/startup.rs` + `src/startup.ts`）

release 包在 Windows 上是 GUI 子系统（没有控制台）且 `panic = "abort"`，历史问题就是
「双击没反应、也没提示」——本机看不到任何线索。现在的做法是**里程碑先攒在内存里，出问题才落盘**：

1. 进程一起来先按 `startupLog` 配置定档（`decide_mode`，优先级 `RNP_STARTUP_LOG` 环境变量 →
   `--startup-log` 命令行 → 配置文件 → 默认 `Mode::Off`）。`Off` 档不碰磁盘，每条里程碑只进
   内存队列（上限 128 条，超了丢最早的）；`Always` 档立刻按候选顺序开文件：**应用目录（macOS 是
   `~/.rocketnote`，Windows 是 exe 同目录）→ 系统应用配置目录 → `std::env::temp_dir()`**（前两者在
   「装进 Program Files + 普通权限」和「从来没成功启动过」两种情况下都可能写不了，父目录不存在时先补建一次），
   之后逐条带毫秒时间戳追加。
2. 出问题的四个入口都会先 `flush()` 再弹提示：10 秒看门狗超时、`run()` 返回错误、
   panic 钩子、前端 `failStartup`（走 `flush_startup_log` 命令，返回值就是落盘位置，
   弹窗直接把它念给用户）。头部写明「本次启动没走到正常就绪，以下是攒下来的过程」，
   日志停在第几行就说明卡在哪一步；`Off` 档下三个候选位置一个都写不了时，弹窗换成
   「请拷到自己的文件夹再双击一次」那条路径。
3. 顺利就绪（`mark_page_ready`）时反过来做清理：丢掉内存队列，并删掉上一次出问题留下的
   `rocketnotepad.startup.log`（只删文件名完全匹配的那一个，配置目录里的其他东西不动）。
   已经落过盘的那次不删，记录仍然有用。
4. 记录的内容：进程起来（含参数与系统）→ WebView2 检查结论（含命中来源与版本）→ 应用与插件
   就绪 → 页面开始加载/加载完成（`on_page_load`）→ 前端脚本开始执行 → 配置已读取 → 界面骨架 →
   编辑器挂载 → 页面已就绪 → 恢复上次标签。前端里程碑走 `log_startup` 命令。
5. 漏网的 `window.onerror` / `unhandledrejection` 同样记一条；`main()` 的启动异常直接弹原生
   对话框（旧版是裸调 `main()`，Promise 拒绝被静默吞掉，页面只剩空白）；panic 钩子先补写日志
   再弹窗，退出码固定 1。

开关在命令面板里叫「设置: 启动日志」，标题带当前档位，切换时把 `startupLog` 写进配置文件、
用 `set_startup_log` 同步当前这次运行（打开立即补写并回报路径，关闭则把刚写的文件收走）。
后端单测 `milestones_stay_in_memory_until_something_goes_wrong` 覆盖「默认不落盘 → 出问题补写 →
下次顺利启动清掉」整条链，前端 `tests/e2e/app-commands.test.ts` 覆盖面板切换与持久化。
排查对照表见 `release-win/README-Windows.md`。

### 3.6 启动探针（`probe/`，独立 crate）

日志只能回答「卡在哪一步」，回答不了「连第一行日志都写不出来」的情况——旧的受管 Windows Server
环境上就遇到过：崩溃事件写着自身镜像 `0xc0000409`，但三个候选位置一份日志都没有。为此把探针做成
**跟主程序完全无关的独立 crate**：

```bash
cd probe && cargo xwin build --release --target x86_64-pc-windows-msvc
```

它只链接 std 和 `user32/advapi32`，不碰 tauri、wry、WebView2，栈帧极小（第 0 步就用裸
`OpenOptions + write_all` 写盘，绕开 `format!`/`BufWriter`），依次汇报：能不能写文件、
`%TEMP%/%APPDATA%` 指向哪、系统版本、WebView2 注册表（64/32 位视图都查）与固定版目录、
装目录可写性、`vcruntime140.dll` 是否存在，最后弹窗把结论直接显示给现场的人。

不要把它加回 `src-tauri` 的 `[[bin]]`：tauri bundler 会把所有二进制一起塞进 `.app`
（实测 `Contents/MacOS/rnp-probe` 就这么混进过交付包），因此主包只保留
`default-run = "rocketnotepad"`。

### 3.7 编辑器字体（`src/fonts.ts` + `src/fontpicker.ts`）

默认值是 `system`，即跟随操作系统的默认界面字体：macOS 走 `-apple-system / PingFang SC`，
Windows 走 `Segoe UI / Microsoft YaHei UI`，Linux 走 `system-ui / Noto Sans CJK`。
不做字体可用性探测（探测要逐个量文本宽度，启动就得多付几十毫秒），清单里只放各平台**自带**的字体：
macOS 11 款（SF Mono、Menlo、苹方、宋体-简…）、Windows 12 款（Consolas、Cascadia、微软雅黑、宋体…）、
Linux 9 款（DejaVu、Liberation、Noto CJK…），等宽项标「等宽」标签。

三个入口都打开同一个面板：视图菜单「字体…」、状态栏的字体名、命令面板「视图: 选择字体…」。
面板里边挑边看——上下键或鼠标悬停即时试穿，`⏎`/点击选定，`Esc`/点遮罩取消并原样还回去；
字号 −/+/重置 就在面板头部，范围仍是 9–40。输入清单里没有的名字会多出一行「使用「xxx」」，
自定义字体下次打开时留在列表首位。

两条实现上的约束：

- **试穿值不进 `cfg`**。`settings` 就是要落盘的那份对象，试穿期间切标签、切主题都会触发一次
  300 ms 防抖落盘，若把试穿值写进去就会把没选定的字体一并存下来。因此试穿走 `main.ts` 里独立的
  `look` 覆盖层，只有 `onCommit` 才写 `settings` 并落盘（`tests/e2e/app-font.test.ts` 的
  「试穿期间别的设置落盘」守住这条）。
- **自定义字体名先消毒再进 CSS/画布**。`normalizeFamily()` 去掉引号、分号、花括号等字符并截到
  80 字符，再包成 `"名字", 系统栈`；小地图的 `ctx.font` 与预览代码块共用同一个 `fontStack()`，
  预览侧靠 CSS 变量 `--rnp-editor-font` 传递，避免两处各写一份字体栈。

### 3.8 「关于」面板（`src/about.ts` + `src-tauri/src/commands/app.rs`）

帮助菜单「关于 RocketNotePad」与命令面板「帮助: 关于 RocketNotePad」打开同一个模态面板，
替代原先的三行原生消息框。四个分页：

- **功能**：按「编辑与标签 / 文件与文件夹 / 阅读与导航 / 外观与会话」四组共 16 张卡片介绍整体能力，
  文案里的数字（1.5 s 自动保存、8 MB 只读阈值、语言种数、9–40 px 字号）都取自真实实现，不写死。
- **架构**：前端 TypeScript / 桥 Tauri 2 IPC / 后端 Rust 三层堆叠图，列出各层真实模块名与职责，
  附「关键取舍」与 macOS / Windows 交付形态。
- **运行环境**：版本、平台、配置路径、可执行文件路径等**由后端 `app_info` 命令实时给出**，
  不在前端猜路径；「复制诊断信息」把整段环境信息写进剪贴板，「打开配置文件夹」用资源管理器定位。
- **快捷键**：按当前平台渲染（macOS 显示 ⌘、Windows 显示 Ctrl），与原生菜单加速键一致。

实现约束：

- **版本单一来源**。前端 `APP_VERSION` 直接 `import { version } from "../package.json"`；
  `tests/unit/about.test.ts` 守住 package.json ↔ tauri.conf.json 一致，
  `commands/app.rs` 的 `the_crate_version_matches_the_bundle_version` 守住 Cargo ↔ tauri.conf.json 一致。
- **真模态**。document 捕获阶段监听 keydown 并 `stopPropagation()`，背后的编辑器收不到任何按键
  （默认动作如复制、滚动仍保留）；Tab 在面板内循环焦点，`Esc`/遮罩/× 关闭并把焦点还给编辑器。
- **路径不猜**。`app_info` 返回 `paths::files_of` 真正命中的那份配置（含 Windows `%APPDATA%` 回退），
  `config_exists` 决定「打开配置文件夹」是定位文件还是退而打开目录。

---

## 4. 打包发布

### 4.1 全平台默认打包（当前系统的全部格式）

```bash
npm run tauri build
```

产物位置：

| 平台 | 产物 | 路径 |
|------|------|------|
| macOS | .app | `src-tauri/target/release/bundle/macos/RocketNotePad.app` |
| macOS | .dmg | `src-tauri/target/release/bundle/dmg/RocketNotePad_<版本>_aarch64.dmg` |
| Windows | .msi | `src-tauri/target/release/bundle/msi/` |
| Windows | .exe (NSIS) | `src-tauri/target/release/bundle/nsis/` |

### 4.2 指定打包格式

```bash
# 仅 macOS .app（本机 Finder 自动化受限时推荐，见 §6）
npm run tauri build -- --bundles app

# 仅 dmg
npm run tauri build -- --bundles dmg

# Windows 上仅 msi / nsis
npm run tauri build -- --bundles msi
npm run tauri build -- --bundles nsis
```

### 4.3 macOS 通用二进制（Intel + Apple Silicon）

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

### 4.4 Windows 10 产物：在 macOS 上交叉编译（本机已验证）

一次性准备工具链：

```bash
export PATH=/opt/homebrew/opt/rustup/bin:/opt/homebrew/opt/llvm/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin          # 用 xwin 拉取的 MSVC/Windows SDK 头与库链接
brew install makensis lld llvm             # lld-link + llvm-rc/llvm-lib/llvm-mt
```

构建（`nsis` 安装包与免安装裸 exe 一起产出）：

```bash
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

产物位置：

| 文件 | 说明 |
|------|------|
| `src-tauri/target/x86_64-pc-windows-msvc/release/rocketnotepad.exe` | 免安装单文件，PE32+ / Windows GUI，前端资源已内嵌，只依赖系统 DLL，双击即可运行 |
| `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/RocketNotePad_<版本>_x64-setup.exe` | NSIS 安装包（开始菜单项、卸载器、可选 WebView2 引导） |

交叉编译环境两个已知卡点（本机网络/工具链相关，不是工程缺陷）：

1. **NSIS 插件下载被墙**：打包器会从 GitHub Releases 取 `nsis_tauri_utils.dll`（SHA-1
   `75197fee…b860`），GitHub 直连超时。预先按官方缓存布局放好即可跳过下载，文件必须与哈希一致：

   ```bash
   D="$HOME/Library/Caches/tauri/NSIS/Plugins/x86-unicode/additional"
   mkdir -p "$D" && cp /path/to/nsis_tauri_utils.dll "$D/"
   shasum "$D/nsis_tauri_utils.dll"    # 应为 75197fee3c6a814fe035788d1c34ead39349b860
   ```

   同一目录还需存在 NSIS 3.13 官方发行包解压后的 `NSIS.exe`（SHA-1 `6d45d4e8…2ecf2`），
   否则每次都会重新触发下载：`unzip nsis-3.13.zip && cp -R nsis-3.13 "$HOME/Library/Caches/tauri/NSIS"`
   （zip 的 SHA-1 `db14f8af…9b8e` 即打包器内置校验值，SourceForge 官方发布可直连）。

2. **`makensis` 在纯后台进程里崩**：Homebrew 的 makensis 3.13（arm64）在本机编译任意脚本都会在
   `ExeHeadStringList::add` 抛 `std::bad_alloc` 退出 134，关掉 ASLR 即正常。打包失败时可单独用
   调试器（`target.disable-aslr` 默认为 true）编译已经生成的脚本：

   ```bash
   cd src-tauri/target/x86_64-pc-windows-msvc/release/nsis/x64
   lldb -b -f /opt/homebrew/bin/makensis -o "run -V1 installer.nsi" -o quit
   # 产出 nsis-output.exe，即安装包本体
   ```

> 交叉编译产物只做了静态校验（PE 头、导入表、NSIS 魔数）与 macOS 侧同版本前端逻辑测试；
> 真机运行验证需在 Windows 10 上进行。
>
> Windows 侧的「静默失败」已在代码里兜住：release 是 GUI 子系统且 `panic = "abort"`，
> 原先 WebView2 运行时缺失时只会静默中止（双击毫无反应）。现在
> `src-tauri/src/win_start.rs` 会在启动前查注册表与 `Microsoft\EdgeWebView\Application`，
> 缺失时弹中文提示（可选择继续启动或退出），并给 panic 兜底弹窗、把 `Builder::run()` 的错误
> 也弹出来；`tauri.conf.json` 的 `bundle.windows.webviewInstallMode` 用 `embedBootstrapper`
> （安装包内嵌约 1.9 MB 引导器，装运行时不需要用户再手动找链接）。

### 4.5 CI 双端打包（GitHub Actions）

仓库已配置 `.github/workflows/build.yml`：推送 `v*` 标签或手动触发（workflow_dispatch）后，
在 `macos-latest`（universal）与 `windows-latest` 上自动构建并上传安装包 artifacts：

```bash
git tag v0.2.0
git push origin v0.2.0
```

> 当前 `origin` 指向 Gitee，GitHub Actions 不会被触发；要用 CI 出双端包需先把仓库镜像/推送到
> GitHub（属对外可见操作，需另行确认）。本机可用 §4.4 的交叉编译路线直接产出 Windows 包。

### 4.6 安装到本机 macOS（`/Applications`）

本机用户在 `admin` 组里，`/Applications` 是 `drwxrwxr-x root admin`，不需要 sudo：

```bash
export PATH=/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH
npm run tauri build                                   # 产出 .app 与 .dmg
cp -R src-tauri/target/release/bundle/macos/RocketNotePad.app /Applications/
# 让启动台/右键「打开方式」与图标缓存认到新构建
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/RocketNotePad.app
touch /Applications/RocketNotePad.app
open -a /Applications/RocketNotePad.app
```

装好后确认三件事（本机已验证）：

```bash
ls -l ~/.rocketnote                     # rocketnotepad.config.json + recent.json
ls -l /Applications/RocketNotePad.app/Contents/MacOS   # 只有二进制，包内不再有运行期文件
ls -l ~/Library/Application\ Support/com.maple.rocketnotepad  # 老文件仍在，没被删
```

`~/.rocketnote/rocketnotepad.startup.log` 只在启动出问题时出现；`open -a /Applications/RocketNotePad.app
--args --startup-log` 可以全程留一次痕，正常退出后下一次顺利启动会把它清掉。

### 4.7 macOS 签名与「文件已损坏」提示（分发给其他 Mac）

把 dmg/`.app` 通过微信、浏览器下载等渠道传到另一台 Mac 后，双击常报**「RocketNotePad」已损坏，
应移到废纸篓**。这不是文件真的坏了，而是 macOS Gatekeeper 的两件事叠加：

1. **隔离属性**：下载/接收的文件被打上 `com.apple.quarantine`（可用 `xattr -l <文件>` 看到，
   微信渠道形如 `0082;…;WeChat;`）。
2. **签名不完整**：早期打包只做了链接器级的 ad-hoc 签名（`codesign -dv` 显示
   `flags=…(adhoc,linker-signed)`、`Sealed Resources=none`），资源没有封签。Gatekeeper 校验时
   报 `code has no resources but signature indicates they must be present`，叠加隔离属性就判定「已损坏」。

**打包侧已做的根治**：`src-tauri/tauri.conf.json` 的 `bundle.macOS` 增加 `"signingIdentity": "-"`，
让 Tauri 在打包时做一次**完整的 ad-hoc 封签**。重打后的 `.app` 校验应为：

```bash
codesign -dv --verbose=2 /Applications/RocketNotePad.app
#   flags=0x10002(adhoc,runtime)            ← 不再是 linker-signed，且启用 hardened runtime
#   Sealed Resources version=2 rules=13 …   ← 资源已封签（不再是 none）
ls /Applications/RocketNotePad.app/Contents/_CodeSignature/CodeResources   # 封签清单已生成
codesign --verify --deep --strict --verbose=2 /Applications/RocketNotePad.app
#   valid on disk / satisfies its Designated Requirement
```

封签后，`spctl --assess` 仍会 `rejected`，但原因变成常规的**「身份不明的开发者 / 未公证」**
（可右键打开绕过），不再是结构性「已损坏」。

**接收方 Mac 的即时处理**（任选其一，针对已经传过去的包）：

```bash
# 方式 A（最稳）：装好后去掉 app 的隔离属性
xattr -dr com.apple.quarantine /Applications/RocketNotePad.app

# 方式 B：挂载前去掉 dmg 的隔离属性，再拖入 Applications
xattr -d com.apple.quarantine ~/Downloads/RocketNotePad_0.2.0_aarch64.dmg

# 方式 C（无需命令行）：在「应用程序」里右键点 RocketNotePad →「打开」→ 弹窗再点「打开」
#   仅对封签后的「身份不明开发者」提示有效；旧的「已损坏」提示无法这样绕过，须用 A/B
```

**彻底消除提示（长期方案）**：用 Apple Developer ID 签名并公证（notarize）。配置好
`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`（或 `APPLE_API_KEY` 等）后，Tauri 会自动签名+公证，
其他 Mac 双击即开、无任何提示。当前打包日志里的 `skipping app notarization, no APPLE_ID …`
即表示尚未公证，属预期。

> **架构提醒**：默认 dmg 为 `aarch64`，**只支持 Apple Silicon（M 系列）**。Intel Mac 需按 §4.3
> 打 `universal-apple-darwin` 通用二进制，否则在 Intel 上同样无法运行。

---

## 5. 启动已打包产物

```bash
# macOS：直接运行 .app
open src-tauri/target/release/bundle/macos/RocketNotePad.app

# macOS：挂载 dmg 后拖入 Applications
open src-tauri/target/release/bundle/dmg/*.dmg

# macOS：运行裸二进制（调试用）
./src-tauri/target/release/rocketnotepad

# Windows：双击 msi / exe 安装后从开始菜单启动；
# 或免安装运行裸二进制
src-tauri\target\release\rocketnotepad.exe
```

开发期快速重启 release 版（替换旧窗口）：

```bash
pkill -f "RocketNotePad.app/Contents/MacOS"
open src-tauri/target/release/bundle/macos/RocketNotePad.app
```

---

## 6. 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| `cargo: command not found` | Homebrew rustup 为 keg-only，先执行 §1.1 的 PATH export |
| dmg 打包报 `Finder AppleEvent 已超时 (-1712)` | 本机/无头环境 Finder 自动化受限；改用 `--bundles app`，dmg 交由 CI 或授权桌面生成 |
| 其他 Mac 安装提示「文件已损坏，应移到废纸篓」 | Gatekeeper 隔离属性 + 早期未封签的 ad-hoc 签名所致；接收方 `xattr -dr com.apple.quarantine /Applications/RocketNotePad.app` 或右键「打开」即可。打包侧已加 `signingIdentity:"-"` 完整封签根治，长期可 Developer ID + 公证，见 §4.7 |
| Intel Mac 装不上 / 打不开 aarch64 dmg | 默认 dmg 仅支持 Apple Silicon；Intel 需打 universal 通用二进制，见 §4.3、§4.7 |
| 首次 `tauri dev/build` 很慢 | 需编译约 360 个 Rust crate，属正常；后续增量很快 |
| Windows 启动缺 WebView2 | 安装包内嵌 bootstrapper 会静默补装（`embedBootstrapper`）；免安装版缺失时启动自检会弹中文提示，见 §4.4 |
| 双击后没窗口也没任何提示 | 启动日志默认只在出问题时补写，先在 exe 同目录（其次 `%APPDATA%\com.maple.rocketnotepad\`、`%TEMP%\`）找 `rocketnotepad.startup.log`：有则最后一行即卡住的那步，见 §3.5；三处都没有就先跑 `release-win/rnp-probe.exe`，见 §3.6 |
| macOS 上设置与最近打开存在哪 | 用户主目录下的隐藏文件夹 `~/.rocketnote`（`rocketnotepad.config.json`、`recent.json`，出问题时补写的 `rocketnotepad.startup.log` 也在这里）；`.app` 包内不再写任何文件。旧版本放在 `~/Library/Application Support/com.maple.rocketnotepad/` 的两份会在首次启动时复制过来一次，源文件保留，见 §3.4 |
| Windows 弹窗「Couldn't recognize "Windows accelerator modifier: Modifiers(META)"」 | 菜单加速键用了 `Command`/`Cmd`/`Super`/`Meta`，Windows 的 ACCEL 表表达不了；改用 `CmdOrCtrl`，`menu.rs::check_accel` 会在装配阶段挡住 |
| macOS 交叉打 Windows 包时 `Downloading …nsis_tauri_utils.dll` 超时 | GitHub 直连不通，预置 NSIS 官方缓存目录可跳过下载，见 §4.4 |
| `Failed to bundle app with makensis`（`std::bad_alloc`） | 本机 brew makensis 在后台进程下崩溃，用 `lldb` 关闭 ASLR 单独编译 installer.nsi，见 §4.4 |
| 前端 chunk > 500kB 警告 | 主 chunk 为 CodeMirror 全语言包所致（约 52 种语言），gzip 后约 459kB；mermaid 及其图表/布局子 chunk 走按需动态加载，只有打开含 mermaid 的 Markdown 预览才会拉取，可忽略 |

---

## 7. 命令速查

```bash
npm install                                  # 安装依赖
npm run tauri dev                            # 开发启动（热重载）
npm run build                                # 前端类型检查 + 构建
cd src-tauri && cargo check                  # Rust 编译检查
cd src-tauri && cargo test --lib             # Rust 单元测试
npm run tauri build                          # 全格式打包
npm run tauri build -- --bundles app         # 仅 .app
npm run tauri build -- --target universal-apple-darwin   # macOS 通用二进制
open src-tauri/target/release/bundle/macos/RocketNotePad.app   # 启动产物
```
