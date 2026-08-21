// host 侧车进程（R-6 P5c / issue #6）：壳层（Tauri）与 device-core 之间的 JSON-lines stdio IPC。
// 本文件测 IPC 协议行为（对 @agentany/mock-server，#9 分层）：login→上线→consent 往返→deny→登出→
// 存量配置自启。真壳（Tauri）只是这个协议的另一方，不进单测。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockServer, type MockServer } from "@agentany/mock-server";
import { readConfig, readGrants, writeConfig, writeGrants } from "@agentany/device-core";
import { createHost, type HostHandle, type HostOut } from "../src/ipc";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) {
    if (pred()) return;
    await delay(10);
  }
  throw new Error("delayUntil timeout");
};

/** 行输出收集 + 行命令推送（无悬挂迭代：命令面是回调注册）。 */
const fakeIo = () => {
  const out: HostOut[] = [];
  let sink: ((line: string) => void) | undefined;
  const queued: string[] = [];
  return {
    out,
    emit: (msg: HostOut) => out.push(msg),
    onCommandLine: (cb: (line: string) => void) => {
      sink = cb;
      for (const l of queued.splice(0)) cb(l);
      return () => (sink = undefined);
    },
    push: (cmd: unknown) => {
      const line = JSON.stringify(cmd);
      if (sink) sink(line);
      else queued.push(line); // host 未注册前先排队
    },
  };
};

describe("host IPC（对 mock-server）", () => {
  let m: MockServer;
  let h: HostHandle;
  afterEach(async () => {
    await h?.stop();
    m?.close();
  });

  const setup = async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }], runs: [{ runId: "run-1", ownerUsername: "u1" }] });
    const io = fakeIo();
    const configDir = mkdtempSync(join(tmpdir(), "agentany-host-cfg-"));
    const grantsDir = mkdtempSync(join(tmpdir(), "agentany-host-grants-"));
    const workRoot = mkdtempSync(join(tmpdir(), "agentany-host-wd-"));
    h = createHost({
      configDir,
      grantsDir,
      workDir: (runId) => join(workRoot, runId),
      onCommandLine: io.onCommandLine,
      emit: io.emit,
      handlers: {
        bash: async (args) => ({ ok: true, code: 0, stdout: `ran:${String((args as { command?: string }).command)}` }),
        "browser.navigate": async () => ({ ok: true, code: 0, stdout: "nav" }),
      },
    });
    return { io, configDir, grantsDir };
  };

  test("login → hello(deviceId) → login-result → status online；deviceId 落盘", async () => {
    const { io, configDir } = await setup();
    await delayUntil(() => io.out.some((e) => e.t === "hello"));
    const hello = io.out.find((e) => e.t === "hello") as Extract<HostOut, { t: "hello" }>;
    expect(hello.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readConfig({ dir: configDir }).deviceId).toBe(hello.deviceId);

    io.push({ t: "login", serverUrl: `${m.origin}/`, username: "u1", password: "pw" }); // 尾斜杠容错
    await delayUntil(() => io.out.some((e) => e.t === "login-result"));
    expect(io.out.find((e) => e.t === "login-result")).toMatchObject({ t: "login-result", ok: true });
    await delayUntil(() => io.out.some((e) => e.t === "status" && e.s === "online"));
    expect(m.currentDevice("u1")).toBe(hello.deviceId);
    expect(readConfig({ dir: configDir })).toMatchObject({ serverUrl: m.origin, token: expect.any(String) });
  });

  test("坏口令 → login-result {ok:false, kind:'bad_credentials'}（不连接）", async () => {
    const { io } = await setup();
    io.push({ t: "login", serverUrl: m.origin, username: "u1", password: "wrong" });
    await delayUntil(() => io.out.some((e) => e.t === "login-result"));
    expect(io.out.find((e) => e.t === "login-result")).toMatchObject({ t: "login-result", ok: false, kind: "bad_credentials" });
    await delay(50);
    expect(io.out.some((e) => e.t === "status")).toBe(false); // 未连接
  });

  test("consent 往返：借用类 tool_call → consent 事件（reqId/host/workflowId）→ allow_always → 执行 + 站点锚；二次免问", async () => {
    const { io, grantsDir } = await setup();
    io.push({ t: "login", serverUrl: m.origin, username: "u1", password: "pw" });
    await delayUntil(() => io.out.some((e) => e.t === "status" && e.s === "online"));

    const resP = m.sendToolCall({ username: "u1", tool: "browser.navigate", args: { url: "https://github.com/a" }, runId: "run-1", workflowId: "wf-9" });
    await delayUntil(() => io.out.some((e) => e.t === "consent"));
    const c = io.out.find((e) => e.t === "consent") as Extract<HostOut, { t: "consent" }>;
    expect(c.req).toMatchObject({ kind: "tool", tool: "browser.navigate", host: "github.com", workflowId: "wf-9" });
    io.push({ t: "decision", reqId: c.reqId, action: "allow_always" });
    expect((await resP).ok).toBe(true);
    await m.sendToolCall({ username: "u1", tool: "browser.navigate", args: { url: "https://github.com/b" }, runId: "run-1", workflowId: "wf-9" });
    await delay(100);
    expect(io.out.filter((e) => e.t === "consent")).toHaveLength(1); // 站点锚免问
    expect(readGrants({ dir: grantsDir }).remembered).toEqual([{ workflowId: "wf-9", face: "browser", host: "github.com" }]);
  });

  test("decision deny → tool_result code:denied（透传）", async () => {
    const { io } = await setup();
    io.push({ t: "login", serverUrl: m.origin, username: "u1", password: "pw" });
    await delayUntil(() => io.out.some((e) => e.t === "status" && e.s === "online"));
    const resP = m.sendToolCall({ username: "u1", tool: "browser.navigate", args: { url: "https://gitlab.com/a" }, runId: "run-1", workflowId: "wf-9" });
    await delayUntil(() => io.out.some((e) => e.t === "consent"));
    const c = io.out.find((e) => e.t === "consent") as Extract<HostOut, { t: "consent" }>;
    io.push({ t: "decision", reqId: c.reqId, action: "deny" });
    const res = await resP;
    expect(res.ok).toBe(false);
    expect(res.code).toBe("denied");
  });

  test("logout → logged-out + stop(logout) + 本地 token 清（deviceId 保留）", async () => {
    const { io, configDir } = await setup();
    io.push({ t: "login", serverUrl: m.origin, username: "u1", password: "pw" });
    await delayUntil(() => io.out.some((e) => e.t === "status" && e.s === "online"));
    io.push({ t: "logout" });
    await delayUntil(() => io.out.some((e) => e.t === "logged-out"));
    await delayUntil(() => io.out.some((e) => e.t === "stop" && e.reason === "logout"));
    const cfg = readConfig({ dir: configDir });
    expect(cfg.token).toBeUndefined();
    expect(cfg.deviceId).toBeDefined();
    await delayUntil(() => m.currentDevice("u1") === undefined);
  });

  test("存量配置自启：client.json 已有 serverUrl+token → start 即连（无 login 命令）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const io = fakeIo();
    const configDir = mkdtempSync(join(tmpdir(), "agentany-host-cfg-"));
    const grantsDir = mkdtempSync(join(tmpdir(), "agentany-host-grants-"));
    const r = await fetch(`${m.origin}/auth/device-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u1", password: "pw", deviceId: "dev-h" }),
    });
    const { token } = (await r.json()) as { token: string };
    writeConfig({ serverUrl: m.origin, deviceId: "dev-h", token }, { dir: configDir });
    writeGrants({ version: 1 }, { dir: grantsDir });
    h = createHost({
      configDir, grantsDir, workDir: () => mkdtempSync(join(tmpdir(), "agentany-wd-")),
      onCommandLine: io.onCommandLine, emit: io.emit, handlers: {},
    });
    await delayUntil(() => io.out.some((e) => e.t === "status" && e.s === "online"));
    expect(m.currentDevice("u1")).toBe("dev-h");
  });

  test("授权管理：grants-get 回当前档；grants-put 写盘即刻生效（deny 规则拦下一次调用）", async () => {
    const { io, grantsDir } = await setup();
    io.push({ t: "login", serverUrl: m.origin, username: "u1", password: "pw" });
    await delayUntil(() => io.out.some((e) => e.t === "status" && e.s === "online"));
    io.push({ t: "grants-get" });
    await delayUntil(() => io.out.some((e) => e.t === "grants"));
    expect(io.out.find((e) => e.t === "grants")).toMatchObject({ t: "grants", grants: { version: 1 } });
    io.push({ t: "grants-put", grants: { version: 1, rules: [{ tool: "bash", policy: "deny" }] } });
    await delayUntil(() => io.out.some((e) => e.t === "grants-saved"));
    const res = await m.sendToolCall({ username: "u1", tool: "bash", args: { command: "ls" }, runId: "run-1", workflowId: "wf-9" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("denied");
    expect(readGrants({ dir: grantsDir }).rules).toEqual([{ tool: "bash", policy: "deny" }]);
  });
});
