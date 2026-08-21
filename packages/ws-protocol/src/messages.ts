// 设备 WS 协议线帧（ADR-0033 / 0034 D2 单一真相源）。帧=JSON 信封，type 判别。
//   server → device : check_environment / tool_call / pong
//   device → server : env_report / env_remediated / tool_result / ping
// 同连接多 run 并发复用：tool_call.id / check_environment.id 为 correlationId（env-<n> / tool-<n>），
// 响应帧原样带回；过期响应服务端幂等丢弃。schema 随 tool_call 下发（设备侧同名 handler 校验用）。
import type { Schema } from "./schema";
import type { EnvCheckItem, EnvCheckStatus, EnvRequirement, ToolArtifact } from "./value-types";

// —— server → device ——

/** 心跳应答（应用层；服务端空闲回收沿用 server 级 idleTimeout）。 */
export type PongFrame = {
  type: "pong";
};

/** 环境检测请求：设备在本机跑 requirements 逐项探测并回 env_report。 */
export type CheckEnvironmentFrame = {
  type: "check_environment";
  id: string;
  requirements: EnvRequirement[];
};

/** 远端工具调用：设备按 tool+args+schema 本地执行并回 tool_result（产物走 POST /files/device-upload）。
 * workflowId = 授权粒度的稳定标识（ADR-0038 D2：runId 每次执行新开，不可当授权粒度；服务端按 run 查补）。 */
export type ToolCallFrame = {
  type: "tool_call";
  id: string;
  tool: string;
  args: unknown;
  schema: Schema;
  runId: string;
  workflowId: string;
};

/** 挂起补全请求（ADR-0033/R-4 + ADR-0038 env 链路）：run 因缺可自动补全环境挂起时，服务端推给设备——
 * 设备用户经 onConsent 同意/拒绝；同意 → 设备本地跑 items[].autoInstall → 回 env_remediated(approved)，
 * 服务端复检（重发 check_environment）后自动续跑。items = 缺失且可补全的完整要求（含探测/安装命令）。 */
export type EnvPendingFrame = {
  type: "env_pending";
  pendingStartId: string;
  workflowId: string;
  items: EnvRequirement[];
};

export type DeviceServerMessage = PongFrame | CheckEnvironmentFrame | ToolCallFrame | EnvPendingFrame;

// —— device → server ——

/** 心跳（应用层；间隔远小于服务端空闲回收）。 */
export type PingFrame = {
  type: "ping";
};

/** 工具执行结果回传（ok=false 带 error/code 语义；失败不断连）。 */
export type ToolResultFrame = {
  type: "tool_result";
  id: string;
  ok: boolean;
  code?: string | number;
  stdout?: string;
  stderr?: string;
  artifacts?: ToolArtifact[];
  error?: string;
};

/** 环境探测回执。status 仅作提示——服务端从 table 逐项重派真值，不采信。 */
export type EnvReportFrame = {
  type: "env_report";
  id: string;
  result: {
    status: EnvCheckStatus;
    table: EnvCheckItem[];
  };
};

/** 挂起补全的同意/拒绝（pendingStartId = 服务端 409 返回的确定性 id）。 */
export type EnvRemediatedFrame = {
  type: "env_remediated";
  pendingStartId: string;
  approved: boolean;
};

export type DeviceClientMessage = PingFrame | ToolResultFrame | EnvReportFrame | EnvRemediatedFrame;

// —— 判别守卫（设备加载帧后定 target） ——

export function isServerMessage(m: unknown): m is DeviceServerMessage {
  const t = (m as { type?: unknown })?.type;
  return t === "pong" || t === "check_environment" || t === "tool_call" || t === "env_pending";
}

export function isClientMessage(m: unknown): m is DeviceClientMessage {
  const t = (m as { type?: unknown })?.type;
  return t === "ping" || t === "tool_result" || t === "env_report" || t === "env_remediated";
}