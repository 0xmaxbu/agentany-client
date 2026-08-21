// DeviceClient 连接层测试（2026-08-21 迁移 @agentany/mock-server——issue #9 双仓分层）：
// 不再内联脚本化 WS，改连忠实 mock（真 token 经 HTTP device-login 换取——P5 接入配置同路径）。
// 顶号/登出走 mock 的**真语义**（registry 挤旧 / logout 关连），不再是脚本注入。
// 真服务器 + 真客户端版本 = server 仓 r6-e2e-client（集成层）。
import { afterEach, describe, expect, test } from "bun:test";
import { createMockServer, type MockServer } from "@agentany/mock-server";
import { DeviceClient, type DeviceClientStatus, type DeviceClientStopReason } from "../src/device-client";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) {
    if (pred()) return;
    await delay(10);
  }
  throw new Error("delayUntil timeout");
};

const login = async (m: MockServer, deviceId = "dev-1"): Promise<string> => {
  const r = await fetch(`${m.origin}/auth/device-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "u1", password: "pw", deviceId }),
  });
  return ((await r.json()) as { token: string }).token;
};

describe("DeviceClient（对 mock-server：连接/心跳/重连/顶号/登出）", () => {
  let m: MockServer;
  afterEach(() => m?.close());

  test("login → 建连 + 心跳：ping/pong 往返，服务端可见", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const token = await login(m);
    const statuses: DeviceClientStatus[] = [];
    const c = new DeviceClient({ wsUrl: m.wsUrl("/ws/device"), token, deviceId: "dev-1", pingIntervalMs: 50, staleAfterMs: 200, onStatus: (s) => statuses.push(s) });
    c.connect();
    await delayUntil(() => c.getStatus() === "online");
    expect(statuses).toContain("online");
    await delayUntil(() => m.pings("u1") >= 2); // ≥2 个心跳被服务端收到
    expect(m.currentDevice("u1")).toBe("dev-1");
    expect(m.clientRow("u1", "dev-1")).toBe("online");
    c.stop();
  });

  test("坏 token：服务端拒升级 → 不虚报 online", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const statuses: DeviceClientStatus[] = [];
    const c = new DeviceClient({ wsUrl: m.wsUrl("/ws/device"), token: "not-a-token", deviceId: "dev-1", reconnectBaseMs: 30, pingIntervalMs: 50, onStatus: (s) => statuses.push(s) });
    c.connect();
    await delay(150);
    expect(statuses).not.toContain("online");
    expect(m.currentDevice("u1")).toBeUndefined(); // 升级全被拒
    c.stop();
  });

  test("掉线自动重连：服务端断连 → 指数退避后重连（心跳恢复）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const token = await login(m);
    const statuses: DeviceClientStatus[] = [];
    const c = new DeviceClient({ wsUrl: m.wsUrl("/ws/device"), token, deviceId: "dev-1", pingIntervalMs: 50, staleAfterMs: 300, reconnectBaseMs: 30, onStatus: (s) => statuses.push(s) });
    c.connect();
    await delayUntil(() => c.getStatus() === "online");
    m.drop("u1"); // 掉线（无终态 reason）
    await delayUntil(() => statuses.includes("reconnecting"));
    await delayUntil(() => c.getStatus() === "online" && m.pings("u1") >= 1, 4000); // 重连后心跳恢复
    expect(m.currentDevice("u1")).toBe("dev-1");
    c.stop();
  });

  test("顶号：另一设备真连入 → 4000 kicked_by_another_device 终态停机，不再重连", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const token = await login(m);
    const stopReasons: DeviceClientStopReason[] = [];
    const c = new DeviceClient({ wsUrl: m.wsUrl("/ws/device"), token, deviceId: "dev-1", pingIntervalMs: 50, reconnectBaseMs: 30, onStop: (r) => stopReasons.push(r) });
    c.connect();
    await delayUntil(() => c.getStatus() === "online");

    const b = new WebSocket(m.wsUrl("/ws/device"), { headers: { Authorization: `Bearer ${token}`, "X-Device-Id": "dev-2" } }); // 真顶号路径：registry 挤旧
    await new Promise<void>((res) => (b.onopen = res));

    await delayUntil(() => c.getStatus() === "stopped");
    expect(stopReasons).toEqual(["kicked"]);
    await delay(150); // 不再重连：旧设备没有回来
    expect(m.currentDevice("u1")).toBe("dev-2");
    b.close();
    c.stop();
  });

  test("登出：POST /auth/device-logout → 4000 logout 终态停机", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const token = await login(m);
    const stopReasons: DeviceClientStopReason[] = [];
    const c = new DeviceClient({ wsUrl: m.wsUrl("/ws/device"), token, deviceId: "dev-1", pingIntervalMs: 50, reconnectBaseMs: 30, onStop: (r) => stopReasons.push(r) });
    c.connect();
    await delayUntil(() => c.getStatus() === "online");

    const r = await fetch(`${m.origin}/auth/device-logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(((await r.json()) as { revoked: boolean }).revoked).toBe(true);

    await delayUntil(() => c.getStatus() === "stopped");
    expect(stopReasons).toEqual(["logout"]);
    c.stop();
  });
});
