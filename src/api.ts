import { invoke } from "@tauri-apps/api/core";

export interface FileContent {
  content: string;
  encoding: string;
  line_ending: string;
  size: number;
  /** 后端判定为超大文件，前端应只读打开 */
  large?: boolean;
}

export interface FileMeta {
  size: number;
  modified: number;
  read_only: boolean;
  exists: boolean;
}

export interface RecentEntry {
  path: string;
  name: string;
  opened_at: number;
}

/** 「关于」面板里的运行环境信息，路径都是后端真正在用的那份 */
export interface AppInfo {
  version: string;
  os: string;
  arch: string;
  config_path: string;
  config_dir: string;
  config_exists: boolean;
  exe_path: string;
}

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

export function readTextFile(path: string): Promise<FileContent> {
  return invoke<FileContent>("read_text_file", { path });
}

export function writeTextFile(
  path: string,
  content: string,
  encoding: string,
  lineEnding: string
): Promise<FileMeta> {
  return invoke<FileMeta>("write_text_file", {
    path,
    content,
    encoding,
    lineEnding
  });
}

export function fileMetadata(path: string): Promise<FileMeta> {
  return invoke<FileMeta>("file_metadata", { path });
}

export function isDirectory(path: string): Promise<boolean> {
  return invoke<boolean>("is_directory", { path });
}

export function listTextFiles(dir: string): Promise<string[]> {
  return invoke<string[]>("list_text_files", { dir });
}

export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeNode[] | null;
}

export function listFolderTree(dir: string): Promise<TreeNode> {
  return invoke<TreeNode>("list_folder_tree", { dir });
}

export function createFile(path: string): Promise<void> {
  return invoke("create_file", { path });
}

export function createDir(path: string): Promise<void> {
  return invoke("create_dir", { path });
}

export function renamePath(from: string, to: string): Promise<void> {
  return invoke("rename_path", { from, to });
}

export function deletePath(path: string): Promise<void> {
  return invoke("delete_path", { path });
}

export function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

export function copyPath(from: string, to: string): Promise<void> {
  return invoke("copy_path", { from, to });
}

export function revealInFileManager(path: string): Promise<void> {
  return invoke("reveal_in_file_manager", { path });
}

/** 格式化结果由后端调用系统工具产出；SQL 不走这里（前端内置格式化器） */
export function formatText(lang: string, content: string): Promise<string> {
  return invoke<string>("format_document", { lang, content });
}

export interface FormatterStatus {
  available: boolean;
  tool: string;
}

/** 探测某语言的格式化工具是否可用，供右键菜单决定启用状态与提示 */
export function formatterStatus(lang: string): Promise<FormatterStatus> {
  return invoke<FormatterStatus>("formatter_status", { lang });
}

export function listRecent(): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("list_recent");
}

export function pushRecent(path: string): Promise<void> {
  return invoke("push_recent", { path });
}

export function clearRecent(): Promise<void> {
  return invoke("clear_recent");
}

/** 配置文件内容；后端还没写过时返回 null */
export function readAppConfig(): Promise<string | null> {
  return invoke<string | null>("read_app_config");
}

/** 返回实际落盘的绝对路径（首选目录不可写时是系统应用配置目录） */
export function writeAppConfig(content: string): Promise<string> {
  return invoke<string>("write_app_config", { content });
}

/** 把一条前端里程碑交给后端（默认只在出问题时才落盘） */
export function logStartup(message: string): Promise<void> {
  return invoke<void>("log_startup", { message });
}

/** 告知后端页面已可用，取消超时弹窗 */
export function markPageReady(): Promise<void> {
  return invoke<void>("mark_page_ready");
}

/** 切换本次运行的启动日志；开启时返回日志落盘位置，关闭返回 null */
export function setStartupLog(enabled: boolean): Promise<string | null> {
  return invoke<string | null>("set_startup_log", { enabled });
}

/** 让后端把内存里攒的启动过程补写出来，返回落盘位置（一个位置都写不了时 null） */
export function flushStartupLog(): Promise<string | null> {
  return invoke<string | null>("flush_startup_log");
}
