// @agentany/mock-server（issue #9 双仓分层测试）：hyper-workflow 服务器**设备面**的忠实 mock。
// 单测对 mock、真服务器+真客户端只进集成层（server 仓 r6 三 seam）。协议真相源 @agentany/ws-protocol。
// 每处行为注真源码锚点（hyper-workflow apps/server/src/…）——改真实现须同改此处（漂移由集成层兜底）。
// 已记录的简化（不影响可观察协议行为）：
//   - 口令明文等值比较（真 argon2 timingSafeVerify 的可观察面 = 同样的 200/401）；
//   - 不含 dev 逃生阀（AGENTANY_DEV_TOKEN）——设备路径默认真鉴权，客户端测试全走真 token；
//   - 不含 run/工作流引擎——runs 由测试显式 seed（上传归属校验语义保留）。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type {
  CheckEnvironmentFrame,
  DeviceClientMessage,
  EnvPendingFrame,
  EnvRemediatedFrame,
  EnvReportFrame,
  EnvRequirement,
  Schema,
  ToolCallFrame,
  ToolResultFrame,
} from "@agentany/ws-protocol";

// —— 真服务器常量（锚：device/routes.ts L14、device/server.ts L38、device/registry.ts L19-21）——
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DEVICE_ID_MAX = 128;
const KICK_REASON = "kicked_by_another_device";
const RECONNECT_REASON = "reconnected";
const LOGOUT_REASON = "logout";
const WS_PATH = "/ws/device";

export interface MockUser { username: string; password: string; id?: string }
export interface MockRun { runId: string; ownerUsername: string }

export interface MockServerOptions {
  users?: MockUser[];
  runs?: MockRun[];
  /** 上传落盘根（缺省一次性 tmp 目录）。 */
  uploadRoot?: string;
  /** WS 空闲回收秒数（缺省 255，真服务器 serve 缺省）。 */
  idleTimeout?: number;
  /** 编排等待 tool_result/env_report 的超时 ms（缺省 10s；真 DeviceToolRpc 默认更长）。 */
  toolTimeoutMs?: number;
}

export interface MockUpload { runId: string; name: string; path: string; size: number; bytes: Uint8Array; byUsername: string }

export interface MockServer {
  port: number;
  origin: string;
  uploadRoot: string;
  uploads: MockUpload[];
  url(path?: string): string;
  wsUrl(path?: string): string;
  close(): void;
  addRun(run: MockRun): void;
  /** remote_clients 行状态（"online"|"offline"|undefined）。 */
  clientRow(username: string, deviceId: string): "online" | "offline" | undefined;
  /** registry 当前在线设备的 deviceId（无在线 → undefined）。 */
  currentDevice(username: string): string | undefined;
  waitForDevice(username: string, ms?: number): Promise<void>;
  /** 收到的应用层 ping 数（心跳观测）。 */
  pings(username: string): number;
  /** 该用户设备发来的全部帧（按序；ping 不计——信令）。 */
  frames(username: string): DeviceClientMessage[];
  /** env_remediated 记录（无 correlation，纯记录）。 */
  remediations(): EnvRemediatedFrame[];
  /** 注入掉线：粗暴断开当前连接（客户端视角≈1006，无终态 reason）。 */
  drop(username: string): void;
  /** 编排：向该用户在线设备发 tool_call，等回同 id 的 tool_result（超时/离线 reject）。 */
  sendToolCall(o: { username: string; tool: string; args?: unknown; runId?: string; workflowId?: string; schema?: Schema }): Promise<ToolResultFrame>;
  /** 编排：发 check_environment，等回同 id 的 env_report。 */
  sendCheckEnvironment(o: { username: string; requirements: EnvRequirement[] }): Promise<EnvReportFrame>;
  /** 推送挂起补全请求（真服务端在 pending 建立时推——lifecycle.ts；mock 无 env 引擎，由测试显式触发）。
   * 无 correlation：设备的 env_remediated 记录在 remediations()。 */
  sendEnvPending(o: { username: string; pendingStartId: string; workflowId: string; items: EnvRequirement[] }): void;
}

interface ConnData { userId: string; username: string; deviceId: string; token: string }
interface Pending { resolve: (x: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export function createMockServer(opts: MockServerOptions = {}): MockServer {
  const users = new Map<string, { id: string; username: string; password: string }>();
  for (const u of opts.users ?? []) users.set(u.username, { id: u.id ?? `u-${randomUUID().slice(0, 8)}`, username: u.username, password: u.password });
  const tokens = new Map<string, string>(); // token → userId（auth_tokens 语义：可吊销）
  const runs = new Map<string, string>(); // runId → ownerUserId
  for (const r of opts.runs ?? []) {
    const owner = users.get(r.ownerUsername);
    if (owner) runs.set(r.runId, owner.id);
  }
  const rows = new Map<string, "online" | "offline">(); // `${userId}|${deviceId}` → remote_clients 行
  const registry = new Map<string, { deviceId: string; ws: ServerWebSocket<ConnData> }>(); // userId → 在线真身（单机）
  const framesByUser = new Map<string, DeviceClientMessage[]>();
  const pingsByUser = new Map<string, number>();
  const remediated: EnvRemediatedFrame[] = [];
  const pending = new Map<string, Pending>(); // correlationId → 编排回调（tool_result / env_report）
  const uploads: MockUpload[] = [];

  let toolSeq = 0;
  let envSeq = 0;
  const toolTimeoutMs = opts.toolTimeoutMs ?? 10_000;
  const uploadRoot = opts.uploadRoot ?? mkdtempSync(join(tmpdir(), "agentany-mock-"));

  const bearerOf = (h?: string | null): string | null => (h && h.startsWith("Bearer ") ? h.slice(7) : null);
  const resolveToken = (tok: string | null): { id: string; username: string } | null => {
    if (!tok) return null;
    const userId = tokens.get(tok);
    if (!userId) return null;
    for (const u of users.values()) if (u.id === userId) return { id: u.id, username: u.username };
    return null;
  };
  const rowKey = (userId: string, deviceId: string) => `${userId}|${deviceId}`;
  const userIdOf = (username: string): string | undefined => users.get(username)?.id;
  const pushFrame = (username: string, m: DeviceClientMessage) => {
    const arr = framesByUser.get(username) ?? [];
    arr.push(m);
    framesByUser.set(username, arr);
  };
  const closeEntry = (e: { ws: ServerWebSocket<ConnData> }, reason: string) => {
    try { e.ws.close(4000, reason); } catch { /* 已关 */ }
  };

  /** 编排统一面：发帧 + 挂 correlation（DeviceToolRpc 语义：超时 reject、过期响应幂等丢弃）。 */
  const dispatch = <T extends { id: string }>(username: string, frame: T): Promise<unknown> => {
    const uid = userIdOf(username);
    const entry = uid ? registry.get(uid) : undefined;
    if (!entry) return Promise.reject(new Error(`device offline: ${username}`));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(frame.id);
        reject(new Error(`${frame.id} timeout`));
      }, toolTimeoutMs);
      pending.set(frame.id, { resolve, reject, timer });
      try {
        entry.ws.send(JSON.stringify(frame));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(frame.id);
        reject(e as Error);
      }
    });
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: opts.idleTimeout ?? 255, // 真 serve 缺省（server.ts L99）
    async fetch(req, srv) {
      // —— /ws/device：upgrade 前验 token（server.ts L46-59）——
      if (new URL(req.url).pathname === WS_PATH) {
        if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
        const token = bearerOf(req.headers.get("authorization"));
        const deviceId = req.headers.get("X-Device-Id");
        if (!token || !deviceId || deviceId.length === 0 || deviceId.length > DEVICE_ID_MAX) return new Response("unauthorized", { status: 401 });
        const u = resolveToken(token);
        if (!u) return new Response("unauthorized", { status: 401 });
        const ok = srv.upgrade(req, { data: { userId: u.id, username: u.username, deviceId, token } });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const url = new URL(req.url);

      // —— /health 免鉴权（app.ts L27）——
      if (req.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });

      // —— POST /auth/device-login（公开；device/routes.ts L19-40）——
      if (req.method === "POST" && url.pathname === "/auth/device-login") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const username = body.username, password = body.password, deviceId = body.deviceId;
        if (typeof username !== "string" || typeof password !== "string" || typeof deviceId !== "string") {
          return Response.json({ error: "username, password and deviceId required" }, { status: 400 });
        }
        if (!DEVICE_ID_RE.test(deviceId)) return Response.json({ error: "invalid deviceId" }, { status: 400 });
        const u = users.get(username);
        if (!u || u.password !== password) return Response.json({ error: "invalid credentials" }, { status: 401 });
        const token = randomUUID();
        tokens.set(token, u.id);
        rows.set(rowKey(u.id, deviceId), "online"); // login 即 upsert 联机（routes.ts L38）
        return Response.json({ token, user: { id: u.id, username: u.username } }, { status: 200 });
      }

      // —— POST /auth/device-logout（需 token；device/routes.ts L42-52 + mw L52）——
      if (req.method === "POST" && url.pathname === "/auth/device-logout") {
        const tok = bearerOf(req.headers.get("authorization"));
        const u = resolveToken(tok);
        if (!u) return Response.json({ error: "unauthorized" }, { status: 401 });
        tokens.delete(tok!); // 吊销
        const cur = registry.get(u.id);
        if (cur) closeEntry(cur, LOGOUT_REASON); // 关在线连接（close handler 反注册+置离线）
        for (const key of rows.keys()) if (key.startsWith(`${u.id}|`)) rows.set(key, "offline"); // 兜底全置离线（routes.ts L49）
        return Response.json({ revoked: true });
      }

      // —— POST /files/device-upload（routes/device-files.ts L12-35 + mw L52）——
      if (req.method === "POST" && url.pathname === "/files/device-upload") {
        const u = resolveToken(bearerOf(req.headers.get("authorization")));
        if (!u) return Response.json({ error: "unauthorized" }, { status: 401 });
        const form = await req.formData().catch(() => null);
        if (!form) return Response.json({ error: "multipart form required" }, { status: 400 });
        const runId = String(form.get("runId") ?? "");
        const file = form.get("file");
        if (!runId || !(file instanceof File)) return Response.json({ error: "runId and file required" }, { status: 400 });
        const name = basename(file.name);
        if (!name || name === "." || name === "..") return Response.json({ error: "invalid filename" }, { status: 400 });
        const owner = runs.get(runId);
        if (!owner) return Response.json({ error: "run not found" }, { status: 404 });
        if (owner !== u.id) return Response.json({ error: "uploader is not run owner" }, { status: 403 });
        const bytes = new Uint8Array(await file.arrayBuffer());
        const dir = join(uploadRoot, "runs", runId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), bytes);
        const rel = join("runs", runId, name);
        uploads.push({ runId, name, path: rel, size: bytes.byteLength, bytes, byUsername: u.username });
        return Response.json({ path: rel, name, size: bytes.byteLength });
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const d = ws.data as ConnData;
        rows.set(rowKey(d.userId, d.deviceId), "online"); // 连接时刻为准（server.ts L64）
        const old = registry.get(d.userId); // 单机顶号（registry.ts L33-42）：先登记后关旧
        registry.set(d.userId, { deviceId: d.deviceId, ws });
        if (old && old.ws !== ws) closeEntry(old, old.deviceId === d.deviceId ? RECONNECT_REASON : KICK_REASON);
      },
      message(ws, raw) {
        const d = ws.data as ConnData;
        let msg: unknown;
        try { msg = JSON.parse(String(raw)); } catch { return; } // 非 JSON 帧忽略（server.ts L73-75）
        if ((msg as { type?: string }).type === "ping") {
          pingsByUser.set(d.username, (pingsByUser.get(d.username) ?? 0) + 1);
          try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* 交给 idleTimeout/close */ }
          return;
        }
        const m = msg as DeviceClientMessage;
        pushFrame(d.username, m);
        if (m.type === "tool_result" || m.type === "env_report") {
          const p = pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(m.id);
            p.resolve(m); // 过期响应：无 pending 即丢弃（幂等，对齐 DeviceToolRpc）
          }
        } else if (m.type === "env_remediated") {
          remediated.push(m);
        }
      },
      close(ws) {
        const d = ws.data as ConnData;
        const cur = registry.get(d.userId);
        if (cur && cur.ws === ws) registry.delete(d.userId); // detach 只删自身（registry.ts L45-47）
        // 离线语义：本连接关后无「同 deviceId 新连接在线」才置离线（server.ts L86-91）
        const now = registry.get(d.userId);
        if (!now || now.deviceId !== d.deviceId) rows.set(rowKey(d.userId, d.deviceId), "offline");
      },
    },
  });

  const base = (scheme: string, path = "") => `${scheme}://127.0.0.1:${server.port}${path}`;
  const currentDev = (username: string): string | undefined => {
    const uid = userIdOf(username);
    return uid ? registry.get(uid)?.deviceId : undefined;
  };

  return {
    port: server.port as number,
    origin: base("http"),
    uploadRoot,
    uploads,
    url: (p = "") => base("http", p),
    wsUrl: (p = "") => base("ws", p),
    // 先粗暴 terminate 在线 socket 再 stop：Bun.serve stop(true) 在「本进程已有服务端主动
    // close(4000) 过 + 另有连接仍开」时会挂（bun:test 内实测 5s 超时）；terminate 解除。
    close: () => {
      for (const e of registry.values()) {
        try { e.ws.terminate(); } catch { /* 已关 */ }
      }
      server.stop(true);
    },
    addRun: (r) => {
      const owner = users.get(r.ownerUsername);
      if (owner) runs.set(r.runId, owner.id);
    },
    clientRow: (username, deviceId) => {
      const uid = userIdOf(username);
      return uid ? rows.get(rowKey(uid, deviceId)) : undefined;
    },
    currentDevice: currentDev,
    waitForDevice: async (username, ms = 3000) => {
      const t0 = Date.now();
      while (!currentDev(username)) {
        if (Date.now() - t0 > ms) throw new Error(`device not online within ${ms}ms`);
        await new Promise<void>((r) => setTimeout(r, 10));
      }
    },
    pings: (username) => pingsByUser.get(username) ?? 0,
    frames: (username) => framesByUser.get(username) ?? [],
    remediations: () => remediated,
    drop: (username) => {
      const uid = userIdOf(username);
      const e = uid ? registry.get(uid) : undefined;
      try { e?.ws.terminate(); } catch { /* 已关 */ }
    },
    sendToolCall: (o) =>
      dispatch(o.username, {
        type: "tool_call",
        id: `tool-${++toolSeq}`, // 真 DeviceToolRpc id 方案（tool.ts L41）
        tool: o.tool,
        args: o.args ?? {},
        schema: o.schema ?? { _t: "any" },
        runId: o.runId ?? "run-mock",
        workflowId: o.workflowId ?? "wf-mock", // ADR-0038 D2：真服务端从 run 补值（bridge/server.ts）
      } as ToolCallFrame) as Promise<ToolResultFrame>,
    sendCheckEnvironment: (o) =>
      dispatch(o.username, {
        type: "check_environment",
        id: `env-${++envSeq}`,
        requirements: o.requirements,
      } as CheckEnvironmentFrame) as Promise<EnvReportFrame>,
    sendEnvPending: (o) => {
      const uid = userIdOf(o.username);
      const entry = uid ? registry.get(uid) : undefined;
      if (!entry) return;
      const frame: EnvPendingFrame = { type: "env_pending", pendingStartId: o.pendingStartId, workflowId: o.workflowId, items: o.items };
      try {
        entry.ws.send(JSON.stringify(frame));
      } catch {
        /* 已关：丢弃（真服务端同姿态——推送失败靠 TTL 兜底） */
      }
    },
  };
}
