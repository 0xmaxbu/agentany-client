// mock-server 符合性测试（issue #9）：每条断言锚定 hyper-workflow 真实源码行——mock 与真服务器
// 协议/行为一致是本包的存在理由（单测对 mock，真+真只在集成层）。
// 锚点缩写：routes=apps/server/src/device/routes.ts server=device/server.ts
//          registry=device/registry.ts files=routes/device-files.ts mw=auth/middleware.ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockServer, type MockServer } from "../src";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) {
    if (pred()) return;
    await delay(10);
  }
  throw new Error("delayUntil timeout");
};
const JH = { "content-type": "application/json" };

/** 原生 WS 设备连接（同 DeviceClient 的握手：Bearer + X-Device-Id）。 */
function wsConnect(url: string, token: string, deviceId: string) {
  const messages: Array<Record<string, unknown>> = [];
  const closed: Array<{ code: number; reason: string }> = [];
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}`, "X-Device-Id": deviceId } });
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("upgrade rejected"));
  });
  ws.onmessage = (ev) => messages.push(JSON.parse(String(ev.data)));
  ws.onclose = (ev) => closed.push({ code: ev.code, reason: ev.reason });
  return { ws, messages, closed, opened };
}

describe("mock-server · HTTP 面（/health + device-login/logout）", () => {
  let m: MockServer;
  afterEach(() => m?.close());

  test("/health 免鉴权 200 {ok:true}（app.ts /health bypass）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const r = await fetch(`${m.origin}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  test("device-login 成功：token + user + 设备行置 online（routes L37-39）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const r = await fetch(`${m.origin}/auth/device-login`, { method: "POST", headers: JH, body: JSON.stringify({ username: "u1", password: "pw", deviceId: "dev-a", deviceName: "Mac" }) });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { token: string; user: { username: string } };
    expect(typeof b.token).toBe("string");
    expect(b.user.username).toBe("u1");
    expect(m.clientRow("u1", "dev-a")).toBe("online"); // login 即 upsert 联机
  });

  test("device-login 参数校验：缺字段 400 / deviceId regex 400（routes L27-32）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const miss = await fetch(`${m.origin}/auth/device-login`, { method: "POST", headers: JH, body: JSON.stringify({ username: "u1" }) });
    expect(miss.status).toBe(400);
    expect(((await miss.json()) as { error: string }).error).toBe("username, password and deviceId required");
    const bad = await fetch(`${m.origin}/auth/device-login`, { method: "POST", headers: JH, body: JSON.stringify({ username: "u1", password: "pw", deviceId: "bad id!" }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid deviceId");
  });

  test("device-login 错密码 / 不存在用户 → 401 invalid credentials（routes L36 防枚举同型）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    for (const body of [{ username: "u1", password: "wrong", deviceId: "dev-a" }, { username: "nope", password: "pw", deviceId: "dev-a" }]) {
      const r = await fetch(`${m.origin}/auth/device-login`, { method: "POST", headers: JH, body: JSON.stringify(body) });
      expect(r.status).toBe(401);
      expect(((await r.json()) as { error: string }).error).toBe("invalid credentials");
    }
  });
});

describe("mock-server · /ws/device upgrade + 注册表（顶号/登出语义）", () => {
  let m: MockServer;
  afterEach(() => m?.close());

  test("合法 token+deviceId 升级成功；坏 token 拒升级（server L49-55）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const tok = (await (await fetch(`${m.origin}/auth/device-login`, { method: "POST", headers: JH, body: JSON.stringify({ username: "u1", password: "pw", deviceId: "dev-a" }) })).json()) as { token: string };

    const a = wsConnect(m.wsUrl("/ws/device"), tok.token, "dev-a");
    await a.opened;
    expect(m.currentDevice("u1")).toBe("dev-a");

    const bad = wsConnect(m.wsUrl("/ws/device"), "not-a-token", "dev-a");
    await expect(bad.opened).rejects.toThrow("upgrade rejected");
  });

  test("心跳：ping → pong，服务端计数（server L77-79）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const { token } = await (await fetch(`${m.origin}/auth/device-login`, { method: "POST", headers: JH, body: JSON.stringify({ username: "u1", password: "pw", deviceId: "dev-a" }) })).json() as { token: string };
    const a = wsConnect(m.wsUrl("/ws/device"), token, "dev-a");
    await a.opened;
    a.ws.send(JSON.stringify({ type: "ping" }));
    a.ws.send(JSON.stringify({ type: "ping" }));
    await delayUntil(() => m.pings("u1") >= 2);
    expect(a.messages.filter((x) => x.type === "pong")).toHaveLength(2);
  });

  test("顶号：换 deviceId 新连接挤旧（4000 kicked_by_another_device），registry 只剩新（registry L33-42）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const { token } = await (await fetch(`${m.origin}/auth/device-login`, { method: "POST", headers: JH, body: JSON.stringify({ username: "u1", password: "pw", deviceId: "dev-a" }) })).json() as { token: string };
    const a = wsConnect(m.wsUrl("/ws/device"), token, "dev-a");
    await a.opened;

    const b = wsConnect(m.wsUrl("/ws/device"), token, "dev-b");
    await b.opened;
    await delayUntil(() => a.closed.length === 1);
    expect(a.closed[0]).toEqual({ code: 4000, reason: "kicked_by_another_device" });
    expect(m.currentDevice("u1")).toBe("dev-b");
    expect(m.clientRow("u1", "dev-a")).toBe("offline"); // 被挤：旧设备行离线（server close L91）
    expect(m.clientRow("u1", "dev-b")).toBe("online");
  });

  test("同机重连：同 deviceId 覆盖旧连接（4000 reconnected 非顶号）（registry L37）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const { token } = await (await fetch(`${m.origin}/auth/device-login`, { method: "POST", headers: JH, body: JSON.stringify({ username: "u1", password: "pw", deviceId: "dev-a" }) })).json() as { token: string };
    const a = wsConnect(m.wsUrl("/ws/device"), token, "dev-a");
    await a.opened;
    const b = wsConnect(m.wsUrl("/ws/device"), token, "dev-a");
    await b.opened;
    await delayUntil(() => a.closed.length === 1);
    expect(a.closed[0]).toEqual({ code: 4000, reason: "reconnected" });
    expect(m.clientRow("u1", "dev-a")).toBe("online"); // 同设备新连接在 → 不误标离线（server close L89-91）
  });

  test("device-logout：revoked + 在线连接 4000 logout 关 + token 失效（routes L42-52）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const { token } = await (await fetch(`${m.origin}/auth/device-login`, { method: "POST", headers: JH, body: JSON.stringify({ username: "u1", password: "pw", deviceId: "dev-a" }) })).json() as { token: string };
    const a = wsConnect(m.wsUrl("/ws/device"), token, "dev-a");
    await a.opened;

    const r = await fetch(`${m.origin}/auth/device-logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { revoked: boolean }).revoked).toBe(true);
    await delayUntil(() => a.closed.length === 1);
    expect(a.closed[0]).toEqual({ code: 4000, reason: "logout" });
    expect(m.clientRow("u1", "dev-a")).toBe("offline");
    const again = wsConnect(m.wsUrl("/ws/device"), token, "dev-a"); // token 已吊销 → 拒升级
    await expect(again.opened).rejects.toThrow("upgrade rejected");
  });

  test("device-logout 无 token → 401 unauthorized（mw L52）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const r = await fetch(`${m.origin}/auth/device-logout`, { method: "POST" });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toBe("unauthorized");
  });
});

describe("mock-server · tool_call 编排 + 产物回传", () => {
  let m: MockServer;
  afterEach(() => m?.close());

  const setup = async (opts: Parameters<typeof createMockServer>[0] = {}) => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }, { username: "u2", password: "pw" }], ...opts });
    const { token } = await (await fetch(`${m.origin}/auth/device-login`, { method: "POST", headers: JH, body: JSON.stringify({ username: "u1", password: "pw", deviceId: "dev-a" }) })).json() as { token: string };
    return token;
  };

  test("tool_call 编排：id 形如 tool-<n>，tool_result 按 id 关联 resolve（tool.ts L41）", async () => {
    const token = await setup();
    const a = wsConnect(m.wsUrl("/ws/device"), token, "dev-a");
    await a.opened;
    a.ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as Record<string, unknown>;
      a.messages.push(f);
      if (f.type === "tool_call") a.ws.send(JSON.stringify({ type: "tool_result", id: f.id, ok: true, stdout: "echo" }));
    };
    const res = m.sendToolCall({ username: "u1", tool: "bash", args: { command: "true" }, runId: "run-1" });
    await delayUntil(() => a.messages.some((x) => x.type === "tool_call"));
    const frame = a.messages.find((x) => x.type === "tool_call")!;
    expect(String(frame.id)).toMatch(/^tool-\d+$/);
    expect(frame.tool).toBe("bash");
    expect(frame.runId).toBe("run-1");
    expect(await res).toMatchObject({ type: "tool_result", id: frame.id, ok: true, stdout: "echo" });
  });

  test("tool_call 超时 → reject（DeviceToolRpc 超时语义）", async () => {
    const token = await setup({ toolTimeoutMs: 80 });
    const a = wsConnect(m.wsUrl("/ws/device"), token, "dev-a");
    await a.opened; // 不回 tool_result
    await expect(m.sendToolCall({ username: "u1", tool: "bash" })).rejects.toThrow(/timeout/);
  });

  test("设备离线时编排直接拒绝（寻址面=registry）（tool.ts 寻址）", async () => {
    await setup();
    await expect(m.sendToolCall({ username: "u1", tool: "bash" })).rejects.toThrow(/offline/);
  });

  test("device-upload 成功：{path:runs/<runId>/<name>} + 真实落盘字节（files L28-34）", async () => {
    const token = await setup({ runs: [{ runId: "run-1", ownerUsername: "u1" }] });
    const fd = new FormData();
    fd.append("runId", "run-1");
    fd.append("file", new Blob([new Uint8Array([1, 2, 3])]), "out.bin");
    const r = await fetch(`${m.origin}/files/device-upload`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: fd });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ path: "runs/run-1/out.bin", name: "out.bin", size: 3 });
    const abs = join(m.uploadRoot, "runs", "run-1", "out.bin");
    expect(existsSync(abs)).toBe(true);
    expect([...readFileSync(abs)]).toEqual([1, 2, 3]);
  });

  test("device-upload 分支：无 token 401 / run 不存在 404 / 非所有者 403 / 缺 file 400（files L15-26 + mw L52）", async () => {
    const token = await setup({ runs: [{ runId: "run-1", ownerUsername: "u1" }] });
    const { token: tok2 } = await (await fetch(`${m.origin}/auth/device-login`, { method: "POST", headers: JH, body: JSON.stringify({ username: "u2", password: "pw", deviceId: "dev-b" }) })).json() as { token: string };

    const noAuth = new FormData();
    noAuth.append("runId", "run-1");
    noAuth.append("file", new Blob(["x"]), "f");
    expect((await fetch(`${m.origin}/files/device-upload`, { method: "POST", body: noAuth })).status).toBe(401);

    const noRun = new FormData();
    noRun.append("runId", "run-x");
    noRun.append("file", new Blob(["x"]), "f");
    expect((await fetch(`${m.origin}/files/device-upload`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: noRun })).status).toBe(404);

    const notOwner = new FormData();
    notOwner.append("runId", "run-1");
    notOwner.append("file", new Blob(["x"]), "f");
    const r403 = await fetch(`${m.origin}/files/device-upload`, { method: "POST", headers: { authorization: `Bearer ${tok2}` }, body: notOwner });
    expect(r403.status).toBe(403);
    expect(((await r403.json()) as { error: string }).error).toBe("uploader is not run owner");

    const noFile = new FormData();
    noFile.append("runId", "run-1");
    expect((await fetch(`${m.origin}/files/device-upload`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: noFile })).status).toBe(400);
  });
});
