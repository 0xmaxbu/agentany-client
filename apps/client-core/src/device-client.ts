// 设备 WS 客户端（ADR-0034 D3 薄执行器 / R-6）：只维护连接，不感知 run/工作流/nonce。
// - 连接：/ws/device，Bearer token + X-Device-Id（服务端 upgrade 校验；停用/吊销 → 拒升级）。
// - 心跳：应用层 ping/pong（服务端空闲回收 idleTimeout=255s，间隔远小于它）。
// - 断线自动重连：指数退避；重连前经 getToken() 重验 token（真重签 = 再调 device-login）。
// - 顶号/登出/同机重连 → 终态停机（单机顶号语义，ADR-0033 D4）。
// - 执行分派（P2 起）：tool_call/check_environment 经 onServerMessage 交给执行器层。
import type { DeviceClientMessage, DeviceServerMessage } from "@agentany/ws-protocol";

export type DeviceClientStatus = "connecting" | "online" | "reconnecting" | "stopped";

/** 终态停机原因（给壳层展示/落日志）。 */
export type DeviceClientStopReason =
  | "stopped" // 主动 stop()
  | "kicked" // 被顶号（别机同账号登录）
  | "logout" // 服务端登出
  | "replaced" // 同机重连被服务端替换（另一实例/同 deviceId 重登）
  | "auth_failed"; // 服务端拒升级（token 吊销/停用，重验后仍不通）

export interface DeviceClientOpts {
  wsUrl: string; // ws://host:port/ws/device
  token: string;
  deviceId: string;
  /** 心跳间隔（默认 25s——远小于服务端空闲回收 255s）。 */
  pingIntervalMs?: number;
  /** 收不到服务端任何帧即判假活的窗口（默认 = 3×pingInterval）。 */
  staleAfterMs?: number;
  /** 重连指数退避基数（默认 1s）。 */
  reconnectBaseMs?: number;
  /** 重连指数退避上限（默认 30s）。 */
  reconnectMaxMs?: number;
  /** 重连前重验 token（可换新）：返回新 token（设备-login 再签）；缺省沿用旧 token。 */
  getToken?: () => string | Promise<string>;
  onStatus?: (s: DeviceClientStatus) => void;
  /** 服务端主动帧（tool_call/check_environment/pong 已内部消化）。P2 执行器分派挂这里。 */
  onServerMessage?: (m: DeviceServerMessage) => void;
  onStop?: (reason: DeviceClientStopReason) => void;
}

/** 服务端终态关连 reason（code=4000，服务端 registry 常量）。 */
const TERMINAL_REASONS = new Set(["kicked_by_another_device", "logout", "reconnected"]);

export class DeviceClient {
  private readonly cfg: {
    wsUrl: string;
    token: string;
    deviceId: string;
    pingIntervalMs: number;
    staleAfterMs: number;
    reconnectBaseMs: number;
    reconnectMaxMs: number;
  };
  private readonly getToken?: () => string | Promise<string>;
  private readonly onStatus?: (s: DeviceClientStatus) => void;
  private readonly onServerMessage?: (m: DeviceServerMessage) => void;
  private readonly onStop?: (reason: DeviceClientStopReason) => void;

  private status: DeviceClientStatus = "stopped"; // 未启动即终态：首次 connect() 放行
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0; // 已连续失败次数（退避 2^n）
  private lastFrameAt = 0; // 假活检测锚（任何服务端帧都刷新）
  private stopped = false;

  constructor(o: DeviceClientOpts) {
    this.cfg = {
      wsUrl: o.wsUrl,
      token: o.token,
      deviceId: o.deviceId,
      pingIntervalMs: o.pingIntervalMs ?? 25_000,
      staleAfterMs: o.staleAfterMs ?? (o.pingIntervalMs ?? 25_000) * 3,
      reconnectBaseMs: o.reconnectBaseMs ?? 1_000,
      reconnectMaxMs: o.reconnectMaxMs ?? 30_000,
    };
    this.getToken = o.getToken;
    this.onStatus = o.onStatus;
    this.onServerMessage = o.onServerMessage;
    this.onStop = o.onStop;
  }

  getStatus(): DeviceClientStatus {
    return this.status;
  }

  /** 建立连接并启动心跳（幂等：已在途 → no-op）。 */
  connect(): void {
    if (this.status !== "stopped") return;
    this.stopped = false;
    this.setStatus("connecting");
    this.open();
  }

  /** 主动停机关连：清定时器 + 关 socket；终态，不再重连。 */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* 已关 */
    }
    this.setStatus("stopped");
    this.onStop?.("stopped");
  }

  /** 发设备→服务端帧（执行器/应答用；调用方保证已连）。 */
  send(msg: DeviceClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  // —— 内部：连接生命周期 ——

  private open(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.cfg.wsUrl, {
      headers: { Authorization: `Bearer ${this.cfg.token}`, "X-Device-Id": this.cfg.deviceId },
    });
    this.ws = ws;
    ws.onopen = () => {
      if (this.stopped) return;
      this.attempt = 0;
      this.lastFrameAt = Date.now();
      this.setStatus("online");
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      this.lastFrameAt = Date.now();
      let m: unknown = ev.data;
      if (typeof ev.data === "string") {
        try {
          m = JSON.parse(ev.data);
        } catch {
          return; // 非 JSON 帧忽略
        }
      }
      const frame = m as DeviceServerMessage;
      if (frame?.type === "pong") return; // 心跳应答已刷 lastFrameAt，不外发
      this.onServerMessage?.(frame as DeviceServerMessage);
    };
    ws.onerror = () => {
      // 升级被拒（token 吊销/重验失败）或网络错误——都走重连（重连前重验 token）。
      if (this.stopped) return;
      void this.handleGone();
    };
    ws.onclose = (ev) => {
      if (this.stopped) return;
      if (ev.code === 4000 && TERMINAL_REASONS.has(String(ev.reason ?? ""))) {
        const r = String(ev.reason);
        this.stopped = true;
        this.clearTimers();
        this.ws = null;
        this.setStatus("stopped");
        this.onStop?.(r === "kicked_by_another_device" ? "kicked" : r === "logout" ? "logout" : "replaced");
        return;
      }
      void this.handleGone();
    };
  }

  /** 会话死亡统一入口：清定时器 + 指数退避重连（若未到终态）。 */
  private async handleGone(): Promise<void> {
    if (this.stopped) return;
    if (this.reconnectTimer) return; // 已在重连窗口（onerror+onclose 双触发时只调度一次）
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* 已关 */
    }
    // 重连前重验 token（换新 token；服务端升级校验不信任旧 token）。
    if (this.getToken) {
      try {
        const t = await this.getToken();
        if (typeof t === "string" && t.length > 0) this.cfg.token = t;
      } catch {
        /* 重验失败沿用旧 token（服务端仍会拒 → 继续退避） */
      }
    }
    if (this.stopped) return;
    const delay = Math.min(this.cfg.reconnectBaseMs * 2 ** this.attempt++, this.cfg.reconnectMaxMs);
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.setStatus("connecting");
      this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.clearTimers();
    this.lastFrameAt = Date.now();
    this.heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.send({ type: "ping" });
      // 假活：已达 stale 窗口仍无任何服务端帧 → 判死，强制重连。
      if (Date.now() - this.lastFrameAt > this.cfg.staleAfterMs) {
        void this.handleGone();
      }
    }, this.cfg.pingIntervalMs);
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(s: DeviceClientStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s);
  }
}