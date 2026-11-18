import { message } from "@tauri-apps/plugin-dialog";
import { flushStartupLog, logStartup, markPageReady, setStartupLog } from "./api";

/**
 * 前端启动追踪。
 *
 * 窗口建好但脚本出错时，用户看到的只是一块空白且没有任何提示，远程根本问不出细节。
 * 这里把每个里程碑（以及漏网的异常）转发给后端；后端默认只在出问题时才把攒下的过程
 * 写进 rocketnotepad.startup.log，启动失败时再弹一次原生对话框，保证「没页面」一定伴随一句可反馈的话。
 */

/** 后端日志写不进去（目录只读等）不该影响启动，所有上报都吞掉错误 */
export function note(msg: string): void {
  void logStartup(msg).catch(() => undefined);
}

/** 页面可用，取消后端的超时弹窗 */
export function markReady(): void {
  void markPageReady().catch(() => undefined);
}

/** 切换启动日志，返回日志落盘位置（关闭或写不了时 null） */
export function applyStartupLog(enabled: boolean): Promise<string | null> {
  return setStartupLog(enabled).catch(() => null);
}

/** 兜住没人接的错误：漏网的异常与未处理的 Promise 拒绝都记一行 */
export function traceCrashes(): void {
  window.addEventListener("error", (e) => {
    note(`未捕获错误：${e.message}（${e.filename ?? "?"} 第 ${e.lineno ?? 0} 行）`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    note(`未处理的 Promise 拒绝：${reason(e)}`);
  });
}

/** 启动阶段的致命错误：先把过程落盘，再把话摆到用户眼前 */
export async function failStartup(err: unknown): Promise<void> {
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  note(`启动失败：${text}`);
  // 默认档下日志还在内存里，不落盘就没法让用户发回来
  const path = await flushStartupLog().catch(() => null);
  const where = path
    ? `启动过程已经补写到了这个文件，把它发回来就能定位：\n${path}`
    : "启动过程没能写进任何候选目录（macOS 的 ~/.rocketnote、Windows 的 exe 同目录，还有临时目录都不可写），只能靠上面这段报错定位。";
  await message(`界面初始化失败，窗口可能不完整。\n\n${text}\n\n${where}`, {
    title: "RocketNotePad 启动失败",
    kind: "error"
  }).catch(() => undefined);
}

function reason(e: PromiseRejectionEvent): string {
  const r = e.reason;
  return r instanceof Error ? r.message : String(r);
}
