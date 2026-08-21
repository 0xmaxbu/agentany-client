// host 侧车（R-6 P5c / ADR-0037 分层：核心执行库无头可测 + 壳薄）：Tauri 壳 ⇄ device-core 的
// JSON-lines stdio 桥。壳负责 UI（onboarding/弹窗/托盘/授权管理）；本进程负责配置、连接与执行——
// 复用 P5a 配置面（client.json/deviceId/device-login）与 P5b 授权面（ConsentGate.onConsent→IPC）。
// 协议（壳 → host）：login / logout / decision / shutdown；
//      （host → 壳）：hello / status / stop / consent / login-result / logged-out。
import {
  AgentClient,
  ConfigError,
  checkServer,
  defaultExecutors,
  ensureDeviceId,
  loginDevice,
  logoutDevice,
  normalizeServerUrl,
  readConfig,
  readGrants,
  writeConfig,
  writeGrants,
  wsUrlOf,
  type ConsentCallback,
  type ConsentDecision,
  type ConsentRequest,
  type DeviceClientStatus,
  type DeviceClientStopReason,
  type GrantsFile,
  type ToolHandler,
} from "@agentany/device-core";

export type ConsentAction = ConsentDecision["action"];

export type ShellCommand =
  | { t: "login"; serverUrl: string; username: string; password: string }
  | { t: "logout" }
  | { t: "decision"; reqId: number; action: ConsentAction }
  | { t: "grants-get" }
  | { t: "grants-put"; grants: GrantsFile }
  | { t: "shutdown" };

export type HostOut =
  | { t: "hello"; deviceId: string; configured: boolean }
  | { t: "status"; s: DeviceClientStatus }
  | { t: "stop"; reason: DeviceClientStopReason }
  | { t: "consent"; reqId: number; req: ConsentRequest }
  | { t: "login-result"; ok: true }
  | { t: "login-result"; ok: false; kind: string; error: string }
  | { t: "logged-out" }
  | { t: "grants"; grants: GrantsFile }
  | { t: "grants-saved" };

export interface HostOptions {
  /** client.json 目录（壳注入；生产 ~/.agentany）。 */
  configDir: string;
  /** grants.json 目录（同上）。 */
  grantsDir: string;
  /** 命令行输入（JSON lines）；返回反注册。 */
  onCommandLine(cb: (line: string) => void): () => void;
  /** 事件输出（壳接 stdout）。 */
  emit(msg: HostOut): void;
  /** 工具执行器（缺省 P2 五件套——生产壳注入 allExecutors）。 */
  handlers?: Record<string, ToolHandler>;
  /** 每 run 设备工作区解析器。 */
  workDir?: (runId: string) => string;
}

export interface HostHandle {
  stop(): void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createHost(o: HostOptions): HostHandle {
  const deviceId = ensureDeviceId({ dir: o.configDir });
  let agent: AgentClient | null = null;
  let reqSeq = 0;
  const pending = new Map<number, (d: ConsentDecision) => void>();

  const onConsent: ConsentCallback = (req) =>
    new Promise<ConsentDecision>((resolve) => {
      const reqId = ++reqSeq;
      pending.set(reqId, resolve);
      o.emit({ t: "consent", reqId, req });
      // 超时兜底在 ConsentGate（60s→deny）；迟到 decision 落空即丢弃（幂等）
    });

  const stopAgent = () => {
    if (agent && agent.getStatus() !== "stopped") agent.stop();
    agent = null;
  };

  const connect = (serverUrl: string, token: string) => {
    stopAgent(); // 换账号/重登：旧连接终态
    agent = new AgentClient({
      wsUrl: wsUrlOf(serverUrl),
      token,
      deviceId,
      handlers: o.handlers ?? defaultExecutors(),
      workDir: o.workDir,
      grantsDir: o.grantsDir,
      onConsent,
      onStatus: (s) => o.emit({ t: "status", s }),
      onStop: (reason) => {
        o.emit({ t: "stop", reason });
        if (agent?.getStatus() === "stopped") agent = null;
      },
    });
    agent.connect();
  };

  const stored = readConfig({ dir: o.configDir }) ?? {};
  const configured = Boolean(stored.serverUrl && stored.token);
  o.emit({ t: "hello", deviceId, configured });
  if (configured) connect(stored.serverUrl!, stored.token!);

  function stop() {
    stopAgent();
    for (const r of pending.values()) r({ action: "deny" }); // fail closed：残留询问一律拒绝
    pending.clear();
  }

  o.onCommandLine((line) => {
    let c: ShellCommand;
    try {
      c = JSON.parse(line) as ShellCommand;
    } catch {
      return; // 非 JSON 行忽略
    }
    if (c.t === "login") {
      void (async () => {
        try {
          await checkServer(c.serverUrl);
          const { token } = await loginDevice({ serverUrl: c.serverUrl, username: c.username, password: c.password, deviceId });
          const serverUrl = normalizeServerUrl(c.serverUrl);
          writeConfig({ serverUrl, deviceId, token }, { dir: o.configDir });
          connect(serverUrl, token);
          o.emit({ t: "login-result", ok: true });
        } catch (e) {
          o.emit({ t: "login-result", ok: false, kind: e instanceof ConfigError ? e.kind : "error", error: (e as Error).message });
        }
      })();
    } else if (c.t === "logout") {
      void (async () => {
        const cfg = readConfig({ dir: o.configDir }) ?? {};
        if (cfg.serverUrl && cfg.token) {
          try {
            await logoutDevice({ serverUrl: cfg.serverUrl, token: cfg.token }, { dir: o.configDir });
            // 服务端吊销即关连（4000 logout）——优先让终态事件自然到达；兜底迟一拍再手动停
            await delay(300);
          } catch {
            /* 不可达：logoutDevice 已清本地 token */
          }
        }
        stopAgent();
        o.emit({ t: "logged-out" });
      })();
    } else if (c.t === "decision") {
      const r = pending.get(c.reqId);
      if (r) {
        pending.delete(c.reqId);
        r({ action: c.action });
      }
    } else if (c.t === "grants-get") {
      o.emit({ t: "grants", grants: readGrants({ dir: o.grantsDir }) });
    } else if (c.t === "grants-put") {
      // 授权管理 UI 显式编辑（ADR-0038 D5：全局放宽只经此处，不来自弹窗一键）
      writeGrants(c.grants, { dir: o.grantsDir });
      o.emit({ t: "grants-saved" });
    } else if (c.t === "shutdown") {
      stop();
    }
  });

  return { stop };
}
