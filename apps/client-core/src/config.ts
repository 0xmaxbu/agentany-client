// 接入配置（R-6 P5a / issue #6 / PRD US 1,5,14）：客户端接入的本地配置与登录原语。
// - 持久化：~/.agentany/client.json（0600，目录 0700），字段 {serverUrl, deviceId, token}——**只存 token 不存密码**。
// - deviceId：crypto.randomUUID() 首次生成并持久化（过服务端 [A-Za-z0-9._-]{1,64}；改服务器地址不换设备身份，
//   重连认作同机——锚：服务端 device/routes.ts 注释）。单 profile；改配置重启生效（无热重载）。
// - 地址语义：用户只填 base URL；客户端推导 wsUrl（http→ws / https→wss + /ws/device，
//   与 session.ts onHttp 反推导对称）。不提供手贴 token 入口。
// - 登录：先 GET /health 预检（免鉴权）→「地址不对/服务未启动」级清晰报错；再 POST /auth/device-login 换长效 token。
// - 登出：POST /auth/device-logout（服务端吊销+关连）+ 本地清 token（best-effort：服务器不可达也照清）。
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type ConfigErrorKind =
  | "invalid_url" // base URL 不合法（无 scheme / 非 http(s)）
  | "unreachable" // health 预检失败（地址不对/服务未启动）
  | "bad_credentials" // device-login 401
  | "login_failed" // device-login 其他非 2xx
  | "corrupt"; // 本地 client.json 损坏

export class ConfigError extends Error {
  constructor(message: string, readonly kind: ConfigErrorKind) {
    super(message);
  }
}

/** 落盘形状（缺省 ~/.agentany/client.json；测试注入 dir）。 */
export interface StoredConfig {
  serverUrl?: string;
  deviceId?: string;
  token?: string; // 未登录即缺省
}

export interface ConfigOpts {
  dir?: string;
}

const defaultDir = (): string => join(homedir(), ".agentany");
const filePath = (o?: ConfigOpts): string => join(o?.dir ?? defaultDir(), "client.json");

/** base URL 规范化：trim + 去尾斜杠；须为 http(s) 且带主机，否则 invalid_url。 */
export function normalizeServerUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ConfigError("服务器地址须为 http(s)://host[:port] 形式（可带尾斜杠）", "invalid_url");
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) {
    throw new ConfigError("服务器地址须为 http(s)://host[:port] 形式（可带尾斜杠）", "invalid_url");
  }
  return s;
}

/** 推导设备 WS 地址（http→ws / https→wss + /ws/device）。 */
export function wsUrlOf(serverUrl: string): string {
  return `${normalizeServerUrl(serverUrl).replace(/^http/, "ws")}/ws/device`;
}

export function readConfig(o?: ConfigOpts): StoredConfig | null {
  let raw: string;
  try {
    raw = readFileSync(filePath(o), "utf8");
  } catch {
    return null; // 未配置（首跑 onboarding 判据）
  }
  try {
    return JSON.parse(raw) as StoredConfig;
  } catch {
    throw new ConfigError("本地配置文件损坏（client.json）", "corrupt");
  }
}

/** 整体覆写落盘（0600 / 目录 0700；显式 chmod——跨运行时确定，不受 umask/残留权限影响）。 */
export function writeConfig(cfg: StoredConfig, o?: ConfigOpts): void {
  const dir = o?.dir ?? defaultDir();
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* 已存在目录的权限不强制回改 */
  }
  const p = join(dir, "client.json");
  writeFileSync(p, JSON.stringify(cfg, undefined, 2));
  chmodSync(p, 0o600);
}

/** 取稳定设备身份：已有即复用；没有则生成 UUID 并写回（不动其他字段）。 */
export function ensureDeviceId(o?: ConfigOpts): string {
  const cfg = readConfig(o) ?? {};
  if (typeof cfg.deviceId === "string" && cfg.deviceId) return cfg.deviceId;
  const deviceId = randomUUID();
  writeConfig({ ...cfg, deviceId }, o);
  return deviceId;
}

/** 本地摘除 token（serverUrl/deviceId 保留——登出后重登同身份）。 */
export function clearToken(o?: ConfigOpts): void {
  const cfg = readConfig(o);
  if (cfg?.token === undefined) return;
  writeConfig({ ...cfg, token: undefined }, o);
}

/** 连接前预检：GET /health（免鉴权，app.ts）。失败 = 地址不对或服务未启动（5s 超时）。 */
export async function checkServer(serverUrl: string): Promise<void> {
  const base = normalizeServerUrl(serverUrl); // invalid_url 先于连接错误
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    throw new ConfigError(`无法连接服务器（地址不对或未启动）：${(e as Error).message}`, "unreachable");
  }
}

export interface DeviceLoginResult {
  token: string;
  user: { id: string; username: string };
}

/** 设备登录（POST /auth/device-login，公开端点）：health 预检 → 用户账密换长效 token。纯 RPC，不落盘。 */
export async function loginDevice(o: {
  serverUrl: string;
  username: string;
  password: string;
  deviceId: string;
  deviceName?: string;
}): Promise<DeviceLoginResult> {
  await checkServer(o.serverUrl);
  let r: Response;
  try {
    r = await fetch(`${normalizeServerUrl(o.serverUrl)}/auth/device-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: o.username, password: o.password, deviceId: o.deviceId, deviceName: o.deviceName }),
    });
  } catch (e) {
    throw new ConfigError(`无法连接服务器（地址不对或未启动）：${(e as Error).message}`, "unreachable");
  }
  if (r.status === 401) throw new ConfigError("用户名或密码错误", "bad_credentials");
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new ConfigError(`登录失败（HTTP ${r.status}${err.error ? `: ${err.error}` : ""}）`, "login_failed");
  }
  return (await r.json()) as DeviceLoginResult;
}

/** 登出 = 服务端吊销（best-effort，不可达/已失效不阻塞）+ 本地清 token。 */
export async function logoutDevice(o: { serverUrl: string; token: string }, c?: ConfigOpts): Promise<void> {
  try {
    await fetch(`${normalizeServerUrl(o.serverUrl)}/auth/device-logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${o.token}` },
    });
  } catch {
    /* 服务器不可达：本地照清（token 亦不可再验证） */
  }
  clearToken(c);
}
