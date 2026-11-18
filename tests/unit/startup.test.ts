import { afterEach, describe, expect, it } from "vitest";
import { installTauriMock, STARTUP_LOG_PATH, type TauriMock } from "../helpers/tauri-mock";
import * as startup from "../../src/startup";

let mock: TauriMock | undefined;

function boot() {
  mock = installTauriMock();
  return mock;
}

afterEach(() => {
  mock?.uninstall();
  mock = undefined;
});

describe("启动里程碑上报", () => {
  it("每条都交给后端，参数键是 message", async () => {
    const m = boot();
    startup.note("界面骨架已建好");
    await Promise.resolve();
    expect(m.lastCall("log_startup")?.args).toEqual({ message: "界面骨架已建好" });
  });

  it("后端记不上日志也不该打断启动", async () => {
    const m = boot();
    m.fail("log_startup", "目录只读");
    expect(() => startup.note("配置已读取")).not.toThrow();
    await Promise.resolve();
  });
});

describe("启动失败可见化", () => {
  it("默认档下先把攒下的过程补写落盘，再把位置念给用户", async () => {
    const m = boot();
    startup.note("编辑器已挂载");
    await startup.failStartup(new Error("挂载失败"));
    const cmds = m.calls.map((c) => c.cmd);
    expect(cmds.indexOf("log_startup")).toBeLessThan(cmds.indexOf("flush_startup_log"));
    expect(cmds.indexOf("flush_startup_log")).toBeLessThan(cmds.indexOf("plugin:dialog|message"));
    expect(m.messages.at(-1)).toMatchObject({ title: "RocketNotePad 启动失败", kind: "error" });
    expect(m.messages.at(-1)?.message).toContain("挂载失败");
    expect(m.messages.at(-1)?.message).toContain(STARTUP_LOG_PATH);
  });

  it("一个位置都写不了时如实说明，不含糊其辞", async () => {
    const m = boot();
    m.fail("flush_startup_log", "全都不可写");
    await startup.failStartup("纯文本错误");
    expect(m.messages.at(-1)?.message).toContain("没能写进任何候选目录");
  });

  it("开关交给后端落地，并把日志位置回传给设置页", async () => {
    const m = boot();
    expect(await startup.applyStartupLog(true)).toBe(STARTUP_LOG_PATH);
    expect(m.lastCall("set_startup_log")?.args).toEqual({ enabled: true });
    expect(await startup.applyStartupLog(false)).toBeNull();
    expect(m.startupLogEnabled()).toBe(false);
  });

  it("后端不响应时开关不会抛错", async () => {
    const m = boot();
    m.fail("set_startup_log", "命令未注册");
    expect(await startup.applyStartupLog(true)).toBeNull();
  });
});
