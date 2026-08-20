// DeviceClient 骨架测试（P1）：脚本化 WS 服务器（Bun.serve 真端口）模拟 /ws/device——
// 校验 token/deviceId、回 pong、可主动关连（模拟掉线 / 顶号关机）。
// P2 起客户端主 seam 换成「连接真实 hyper-workflow 服务器」做端到端 round-trip（PRD Testing）。
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
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

/** 脚本化设备 WS 服务器：token="t-ok" 才升级；ping→pong。 */
interface ScriptedServer {
  url: string;
  close(): void;
  sockets(): ServerWebSocket<unknown>[];
  kill(reason?: { code: number; reason?: string }): void; // 关最后一个在线连接（掉线/顶号注入）
  pingCount(): number;
  onOpenHandlers: Array<() => void>;
}

function scriptedDeviceServer(opts: { token?: string } = {}): ScriptedServer {
  const token = opts.token ?? "t-ok";
  const sockets: ServerWebSocket<unknown>[] = [];
  let pings = 0;
  const onOpenHandlers: Array<() => void> = []; // 壳层可注入「open 时做坏动作」
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/ws/device") return new Response("not found", { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${token}` || !req.headers.get("X-Device-Id")) {
        return new Response("unauthorized", { status: 401 }); // 无 token / 坏 token → 拒升级
      }
      const ok = srv.upgrade(req);
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
        for (const h of onOpenHandlers) h();
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as { type?: string };
        if (m.type === "ping") {
          pings++;
          ws.send(JSON.stringify({ type: "pong" }));
        }
      },
      close(ws) {
        const i = sockets.indexOf(ws);
        if (i >= 0) sockets.splice(i, 1);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/ws/device`,
    close: () => server.stop(true),
    sockets: () => sockets,
    kill: (k) => {
      const last = sockets[sockets.length - 1];
      if (last) last.close(k?.code ?? 1001, k?.reason ?? "");
    },
    pingCount: () => pings,
    onOpenHandlers,
  };
}

describe("DeviceClient 骨架（连接/心跳/重连/顶号）", () => {
  let srv: ScriptedServer;
  afterEach(() => {
    srv?.close();
  });

  test("建连 + 心跳：online 后按间隔发 ping 收 pong，服务端可见", async () => {
    srv = scriptedDeviceServer();
    let statuses: DeviceClientStatus[] = [];
    const c = new DeviceClient({ wsUrl: srv.url, token: "t-ok", deviceId: "dev1", pingIntervalMs: 50, staleAfterMs: 200, onStatus: (s) => statuses.push(s) });
    c.connect();
    await delayUntil(() => statuses.includes("online"));
    expect(srv.sockets().length).toBe(1);
    await delayUntil(() => srv.pingCount() >= 2); // ≥2 个心跳被服务端收到
    expect(c.getStatus()).toBe("online");
    c.stop();
  });

  test("坏 token：服务端拒升级 → 走重连，不虚报 online", async () => {
    srv = scriptedDeviceServer({ token: "t-ok" });
    let statuses: DeviceClientStatus[] = [];
    const c = new DeviceClient({ wsUrl: srv.url, token: "t-wrong", deviceId: "dev1", reconnectBaseMs: 30, pingIntervalMs: 50, onStatus: (s) => statuses.push(s) });
    c.connect();
    await delay(150);
    expect(srv.sockets().length).toBe(0); // 升级全被拒
    expect(statuses).not.toContain("online");
    c.stop();
  });

  test("掉线自动重连：服务端断连 → 指数退避后重连（新 socket + 心跳恢复）", async () => {
    srv = scriptedDeviceServer();
    let statuses: DeviceClientStatus[] = [];
    const c = new DeviceClient({ wsUrl: srv.url, token: "t-ok", deviceId: "dev1", pingIntervalMs: 50, staleAfterMs: 300, reconnectBaseMs: 30, onStatus: (s) => statuses.push(s) });
    c.connect();
    await delayUntil(() => statuses.includes("online"));
    srv.kill({ code: 1006 }); // 掉线（无终态 reason）
    await delayUntil(() => statuses.includes("reconnecting"));
    await delayUntil(() => statuses.includes("online") && srv.pingCount() >= 1, 4000); // 重连后心跳恢复
    // 重连用的是新 socket（首个已关、现有为后续连接）
    expect(srv.sockets().length).toBe(1);
    c.stop();
  });

  test("被顶号/登出/同机重连 → 终态停机，不再重连", async () => {
    srv = scriptedDeviceServer();
    let stopReasons: DeviceClientStopReason[] = [];
    const c = new DeviceClient({ wsUrl: srv.url, token: "t-ok", deviceId: "dev1", pingIntervalMs: 50, reconnectBaseMs: 30, onStop: (r) => stopReasons.push(r) });
    c.connect();
    await delayUntil(() => c.getStatus() === "online");
    srv.kill({ code: 4000, reason: "kicked_by_another_device" }); // 服务端 registry：被顶号
    await delayUntil(() => c.getStatus() === "stopped");
    expect(stopReasons).toEqual(["kicked"]);
    // 不再重连：等待窗口无新连接
    await delay(150);
    expect(srv.sockets().length).toBe(0);
    c.stop();
  });
});