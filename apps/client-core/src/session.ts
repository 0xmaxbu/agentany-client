// Agent 会话（R-6 P2 + P5b）：DeviceClient（纯连接）组合 ToolDispatcher（分派+回传）与
// DeviceEnvHandler（环境探测/补全）——真实客户端入口。所有 tool_call 经 ConsentGate（ADR-0038
// 统一拦截点：规则引擎 + onConsent 弹窗抽象；无回调 = fail closed）。
// 壳层（Tauri/无头 CLI）只用这一个类：connect/stop/onStatus/onStop。
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeviceClient, type DeviceClientOpts, type DeviceClientStatus, type DeviceClientStopReason } from "./device-client";
import { ToolDispatcher } from "./dispatcher";
import { ConsentGate, type ConsentCallback } from "./consent";
import { DeviceEnvHandler, type EnvCommandResult } from "./env";
import type { ToolCallFrame } from "@agentany/ws-protocol";
import type { ToolHandler } from "./executor-types";
import { defaultExecutors } from "./executors";

export interface AgentClientOpts {
  wsUrl: string;
  token: string;
  deviceId: string;
  /** 服务端 HTTP 基址（产物上传/将来其它）。缺省从 wsUrl 推导（ws:→http:, wss:→https:）。 */
  httpBase?: string;
  /** 工具名 → 执行器；缺省 = P2 五件套。 */
  handlers?: Record<string, ToolHandler>;
  /** 每 run 设备工作区解析器；缺省 ~/.agentany/workspaces/<runId>。 */
  workDir?: (runId: string) => string;
  /** 会话借用授权（ADR-0038）：弹窗决策回调（Tauri 壳真弹窗/测试假实现；缺省 = 需询问即拒绝）。 */
  onConsent?: ConsentCallback;
  /** grants.json 目录（缺省 ~/.agentany；测试注入）。 */
  grantsDir?: string;
  /** browser 无 url 动作取当前页 host（站点授权「点击跟随」；壳层/浏览器装配注入）。 */
  browserCurrentHost?: () => string | undefined;
  /** env 探测/安装命令执行（缺省 bash -lc 本机；测试注入）。 */
  runEnvCommand?: (command: string) => Promise<EnvCommandResult>;
  // —— DeviceClient 透传 ——
  pingIntervalMs?: number;
  getToken?: () => string | Promise<string>;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onStatus?: (s: DeviceClientStatus) => void;
  onStop?: (reason: DeviceClientStopReason) => void;
}

/** runId 工作区默认解析：~/.agentany/workspaces/<runId>（runId 简陋消毒防路径穿越）。 */
const defaultWorkDir = (runId: string): string =>
  join(homedir(), ".agentany", "workspaces", runId.replace(/[/\\:]/g, "_"));

export class AgentClient {
  private readonly client: DeviceClient;
  private readonly dispatcher: ToolDispatcher;
  private token: string;

  constructor(o: AgentClientOpts) {
    this.token = o.token;
    const handlers = o.handlers ?? defaultExecutors();
    const httpBase = o.httpBase ?? onHttp(o.wsUrl);
    const workDir = o.workDir ?? defaultWorkDir;
    const consent = new ConsentGate({ onConsent: o.onConsent, dir: o.grantsDir, currentHost: o.browserCurrentHost });
    this.dispatcher = new ToolDispatcher({
      handlers,
      workDir,
      httpBase,
      getToken: () => this.token,
      upload: uploadFile,
      send: (msg) => this.client.send(msg),
      consent, // ADR-0038 D1：所有 tool_call 过统一拦截点
    });
    const env = new DeviceEnvHandler({ send: (msg) => this.client.send(msg), consent, runCommand: o.runEnvCommand });
    const wrappedGetToken: DeviceClientOpts["getToken"] = async () => {
      const t = o.getToken ? await o.getToken() : o.token; // 重连前重验：可换新 token
      if (typeof t === "string" && t.length > 0) this.token = t;
      return this.token;
    };
    this.client = new DeviceClient({
      wsUrl: o.wsUrl,
      token: o.token,
      deviceId: o.deviceId,
      pingIntervalMs: o.pingIntervalMs,
      getToken: wrappedGetToken,
      reconnectBaseMs: o.reconnectBaseMs,
      reconnectMaxMs: o.reconnectMaxMs,
      onStatus: o.onStatus,
      onStop: o.onStop,
      onServerMessage: (m) => {
        if (m.type === "tool_call") void this.dispatcher.handle(m as ToolCallFrame); // fire-and-forget：异常兜在 handle 内
        else if (m.type === "check_environment") void env.onCheckEnvironment(m); // env 链路（P5b）：探测 → env_report
        else if (m.type === "env_pending") void env.onEnvPending(m); // 挂起补全：onConsent → autoInstall → env_remediated
      },
    });
  }

  connect(): void {
    this.client.connect();
  }

  stop(): void {
    this.client.stop();
  }

  getStatus(): DeviceClientStatus {
    return this.client.getStatus();
  }
}

/** ws(s)://host[:port][/path] → http(s)://host[:port]（origin 才可拼 /files/… 等 HTTP 路由）。 */
const onHttp = (wsUrl: string): string => {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  return u.origin;
};

/** 真实产物上传：POST /files/device-upload（Bearer token + runId）→ 服务器相对路径。 */
async function uploadFile(o: { httpBase: string; token: string; runId: string; file: { name: string; path: string } }): Promise<{ path: string; name: string; size: number }> {
  const bytes = readFileSync(o.file.path);
  const fd = new FormData();
  fd.append("runId", o.runId);
  fd.append("file", new Blob([bytes]), basename(o.file.name));
  const r = await fetch(`${o.httpBase}/files/device-upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${o.token}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`upload failed: ${r.status}`);
  return (await r.json()) as { path: string; name: string; size: number };
}