// CDP 连接（R-6 P4 / ADR-0035）：ws + 数字自增 id 关联请求；事件订阅/一次性等待。
// 反检测契约（issue #5）：本层**绝不发送 Runtime.enable**——2026 仍活的两个 CDP 绊线 bypass
// （继承式 Error.stack getter / 原型链 Proxy ownKeys）都依赖 Runtime domain 处于 enabled；
// evaluate 所需执行上下文由 Page.createIsolatedWorld 取得，无需 enable。
// 另：cookie 读取/清除方法黑名单（ADR-0035 D3 登录态不出设备——授权面在 P5 弹窗，此处零成本兜底）。
const DENIED_METHODS = new Set([
  "Network.getCookies",
  "Network.getAllCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Storage.getCookies",
]);

type CdpResult = Record<string, any>;
type Pending = { resolve: (v: CdpResult) => void; reject: (e: Error) => void };

export class CdpConnection {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(p: CdpResult) => void>>();

  constructor(readonly wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("message", (ev) => this.onMessage(String((ev as MessageEvent).data)));
  }

  /** 等 ws 打开（CDP 页面端点即连即用）。 */
  open(timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`CDP 连接超时: ${this.wsUrl}`)), timeoutMs);
      this.ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => { clearTimeout(t); reject(new Error(`CDP 连接失败: ${this.wsUrl}`)); }, { once: true });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpResult> {
    if (DENIED_METHODS.has(method)) {
      return Promise.reject(new Error(`CDP 方法 ${method} 被禁止（登录态不出设备）`));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** 订阅事件（返回退订函数）。 */
  on(method: string, cb: (p: CdpResult) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(cb);
    this.listeners.set(method, set);
    return () => set.delete(cb);
  }

  /** 等一次性事件（带超时）。 */
  waitEvent(method: string, timeoutMs = 15_000): Promise<CdpResult> {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (p) => { clearTimeout(t); off(); resolve(p); });
      const t = setTimeout(() => { off(); reject(new Error(`等待 CDP 事件 ${method} 超时`)); }, timeoutMs);
    });
  }

  close(): void {
    try { this.ws.close(); } catch { /* 已关 */ }
  }

  private onMessage(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (typeof m?.id === "number") {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${m.error.message} (code ${m.error.code})`));
        else p.resolve((m.result ?? {}) as CdpResult);
      }
      return;
    }
    if (typeof m?.method === "string") {
      for (const cb of this.listeners.get(m.method) ?? []) cb(m.params ?? {});
    }
  }
}
