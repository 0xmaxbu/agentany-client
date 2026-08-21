// 接入配置（R-6 P5a / issue #6）：base URL 规范化 / wsUrl 推导 / 0600 持久化 / deviceId 稳定性
// + 配置→health→device-login→连线上线→登出全流程（对 @agentany/mock-server，#9 分层）。
// 真服务器+真客户端版本 = server 仓 r6 三 seam（其 mTok 已换 /auth/device-login，集成层）。
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMockServer, type MockServer } from "@agentany/mock-server";
import {
  checkServer,
  clearToken,
  ConfigError,
  ensureDeviceId,
  loginDevice,
  logoutDevice,
  normalizeServerUrl,
  readConfig,
  writeConfig,
  wsUrlOf,
} from "../src/config";
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

const tmpDir = () => mkdtempSync(join(tmpdir(), "agentany-cfg-"));
// 服务端 deviceId 合法性（锚：apps/server/src/device/routes.ts DEVICE_ID_RE；mock 同款）
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

describe("接入配置 · 纯函数与落盘（P5a）", () => {
  test("normalizeServerUrl：容错尾斜杠/空白；拒绝无 scheme 或非 http(s)", () => {
    expect(normalizeServerUrl("http://a:3000/")).toBe("http://a:3000");
    expect(normalizeServerUrl(" https://x.y/// ")).toBe("https://x.y");
    expect(normalizeServerUrl("http://a:3000/base/")).toBe("http://a:3000/base");
    for (const bad of ["", "localhost:3000", "a b", "ftp://x", "http://"]) {
      expect(() => normalizeServerUrl(bad)).toThrow(ConfigError);
    }
  });

  test("wsUrlOf：http→ws / https→wss + /ws/device（与 session.ts onHttp 反向对称）", () => {
    expect(wsUrlOf("http://a:3000")).toBe("ws://a:3000/ws/device");
    expect(wsUrlOf("https://x.y")).toBe("wss://x.y/ws/device");
  });

  test("writeConfig/readConfig：client.json 0600（目录 0700），缺文件 → null", () => {
    const dir = tmpDir();
    expect(readConfig({ dir })).toBeNull();
    writeConfig({ serverUrl: "http://s", deviceId: "d", token: "t" }, { dir });
    expect(readConfig({ dir })).toEqual({ serverUrl: "http://s", deviceId: "d", token: "t" });
    expect(statSync(join(dir, "client.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("ensureDeviceId：首访生成（过服务端 regex）且稳定；已有即复用；不同安装各自身份", () => {
    const dir = tmpDir();
    const id1 = ensureDeviceId({ dir });
    expect(id1).toMatch(DEVICE_ID_RE);
    expect(ensureDeviceId({ dir })).toBe(id1); // 稳定：重启/重连认作同机
    expect(readConfig({ dir })).toEqual({ deviceId: id1 }); // 不引入多余字段
    writeConfig({ serverUrl: "http://s", deviceId: id1, token: "t" }, { dir });
    expect(ensureDeviceId({ dir })).toBe(id1); // 已有字段不被覆盖
    expect(ensureDeviceId({ dir: tmpDir() })).not.toBe(id1);
  });

  test("clearToken：只摘 token，serverUrl/deviceId 保留", () => {
    const dir = tmpDir();
    writeConfig({ serverUrl: "http://s", deviceId: "d", token: "t" }, { dir });
    clearToken({ dir });
    expect(readConfig({ dir })).toEqual({ serverUrl: "http://s", deviceId: "d" });
  });

  test("损坏的 client.json → ConfigError(corrupt)", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "client.json"), "{oops");
    expect(() => readConfig({ dir })).toThrow(ConfigError);
  });
});

describe("接入配置 · 全流程（对 mock-server：health→device-login→上线→登出）", () => {
  let m: MockServer;
  afterEach(() => m?.close());

  test("checkServer：活着 ok；关停后的地址 → unreachable", async () => {
    const dead = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    await checkServer(dead.origin);
    const origin = dead.origin;
    dead.close();
    await expect(checkServer(origin)).rejects.toMatchObject({ kind: "unreachable" });
  });

  test("loginDevice 对死地址 → unreachable（health 预检先行，非含糊网络错）", async () => {
    const dead = createMockServer();
    const origin = dead.origin;
    dead.close();
    await expect(loginDevice({ serverUrl: origin, username: "u1", password: "pw", deviceId: "d-1" })).rejects.toMatchObject({ kind: "unreachable" });
  });

  test("完整接入：deviceId → 登录（坏/好口令）→ 落盘 → 连线上线 → 登出清 token（身份保留）", async () => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }] });
    const dir = tmpDir();
    const deviceId = ensureDeviceId({ dir });

    await expect(loginDevice({ serverUrl: m.origin, username: "u1", password: "wrong", deviceId })).rejects.toMatchObject({ kind: "bad_credentials" });
    const { token, user } = await loginDevice({ serverUrl: m.origin, username: "u1", password: "pw", deviceId });
    expect(token.length).toBeGreaterThan(0);
    expect(user.username).toBe("u1");
    writeConfig({ serverUrl: m.origin, deviceId, token }, { dir });
    expect(readConfig({ dir })).toEqual({ serverUrl: m.origin, deviceId, token }); // 只存 token 不存密码

    const statuses: DeviceClientStatus[] = [];
    const stops: DeviceClientStopReason[] = [];
    const c = new DeviceClient({
      wsUrl: wsUrlOf(m.origin),
      token,
      deviceId,
      pingIntervalMs: 50,
      onStatus: (s) => statuses.push(s),
      onStop: (r) => stops.push(r),
    });
    c.connect();
    await delayUntil(() => c.getStatus() === "online");
    expect(m.currentDevice("u1")).toBe(deviceId);
    expect(m.clientRow("u1", deviceId)).toBe("online");

    await logoutDevice({ serverUrl: m.origin, token }, { dir });
    await delayUntil(() => c.getStatus() === "stopped");
    expect(stops).toEqual(["logout"]); // 服务端吊销即关连（ADR-0033 D4）
    expect(m.clientRow("u1", deviceId)).toBe("offline");
    expect(readConfig({ dir })).toEqual({ serverUrl: m.origin, deviceId }); // token 已清、设备身份保留
  });
});
