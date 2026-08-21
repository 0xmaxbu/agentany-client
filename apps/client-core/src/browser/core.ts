// BrowserCore（R-6 P4）：CDP 命令层 + 工具语义（tabs/navigate/click/type/evaluate/screenshot）。
// 全部反检测姿态在此层（三平台一致）：贝塞尔 move 轨迹、拟人节奏、Runtime 卫生（见 cdp.ts）。
// 平台 adapter（backend.ts）只解决"怎么连上一个 Chromium"——底层一致，行为一致（ADR-0035 修订）。
import { CdpConnection } from "./cdp";

export interface PageInfo { id: string; title: string; url: string; type: string }
interface Point { x: number; y: number }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** [min,max) 均匀抖动——节奏拟人（刻进 core，不做开关）。 */
const jitter = (min: number, max: number): number => min + Math.random() * (max - min);

/** 二次贝塞尔 move 轨迹：控制点 = 中点 + 垂直向随机偏移（±15% 距离），步数随距离 6..24（凸包性质保证不出界）。 */
export function genMovePath(from: Point, to: Point): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const steps = Math.max(6, Math.min(24, Math.round(dist / 80)));
  const off = (Math.random() * 2 - 1) * dist * 0.15;
  const cx = (from.x + to.x) / 2 + (-dy / dist) * off;
  const cy = (from.y + to.y) / 2 + (dx / dist) * off;
  const path: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    path.push({ x: u * u * from.x + 2 * u * t * cx + t * t * to.x, y: u * u * from.y + 2 * u * t * cy + t * t * to.y });
  }
  return path;
}

/** 单浏览器实例的页面操作面（页面级 WS 直连，无 Target/session 层——v1 够用且最少 CDP 面）。 */
export class BrowserCore {
  private conns = new Map<string, CdpConnection>();
  private worlds = new Map<string, number>(); // pageId → isolated world contextId
  private lastMouse = new Map<string, Point>(); // pageId → 上次鼠标位置（轨迹起点，连续拟人）

  constructor(private readonly httpBase: string) {}

  private async conn(id: string): Promise<CdpConnection> {
    let c = this.conns.get(id);
    if (!c) {
      c = new CdpConnection(`${this.httpBase}/devtools/page/${encodeURIComponent(id)}`);
      await c.open();
      this.conns.set(id, c);
    }
    return c;
  }

  async pages(): Promise<PageInfo[]> {
    const r = await fetch(`${this.httpBase}/json/list`);
    if (!r.ok) throw new Error(`/json/list ${r.status}`);
    return ((await r.json()) as Array<Record<string, unknown>>)
      .filter((t) => t.type === "page")
      .map((t) => ({ id: String(t.id), title: String(t.title ?? ""), url: String(t.url ?? ""), type: "page" }));
  }

  async newPage(url?: string): Promise<PageInfo> {
    const q = url ? `?url=${encodeURIComponent(url)}` : "";
    const r = await fetch(`${this.httpBase}/json/new${q}`, { method: "PUT" });
    if (!r.ok) throw new Error(`/json/new ${r.status}`);
    const t = (await r.json()) as Record<string, unknown>;
    return { id: String(t.id), title: String(t.title ?? ""), url: String(t.url ?? ""), type: "page" };
  }

  async activate(id: string): Promise<void> {
    const r = await fetch(`${this.httpBase}/json/activate/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`/json/activate ${r.status}`);
  }

  async close(id: string): Promise<void> {
    const r = await fetch(`${this.httpBase}/json/close/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`/json/close ${r.status}`);
    this.conns.get(id)?.close();
    this.conns.delete(id);
    this.worlds.delete(id);
    this.lastMouse.delete(id);
  }

  async navigate(id: string, url: string): Promise<{ url: string }> {
    const c = await this.conn(id);
    await c.send("Page.enable");
    const loaded = c.waitEvent("Page.loadEventFired");
    const r = await c.send("Page.navigate", { url });
    if (typeof r.errorText === "string" && r.errorText) throw new Error(`navigate 失败: ${r.errorText}`);
    await loaded;
    await sleep(jitter(350, 900)); // settle：拟人节奏（SPA 渲染余量）
    return { url };
  }

  /** 点击 = 先插值 move 轨迹再 press/release（轨迹是反检测一等需求，非可选）。 */
  async click(id: string, x: number, y: number, button = "left"): Promise<void> {
    const c = await this.conn(id);
    const to: Point = { x, y };
    const from = this.lastMouse.get(id) ?? { x: Math.max(0, x - jitter(30, 70)), y: Math.max(0, y - jitter(20, 50)) };
    for (const p of genMovePath(from, to)) {
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(p.x), y: Math.round(p.y), button: "none" });
      await sleep(jitter(8, 25));
    }
    this.lastMouse.set(id, to);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
    await sleep(jitter(40, 90));
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
  }

  /** 逐字符键入：keyDown(text)+keyUp + 抖动间隔；\n → Enter(vk13)。 */
  async type(id: string, text: string): Promise<void> {
    const c = await this.conn(id);
    for (const ch of text) {
      if (ch === "\n") {
        await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      } else {
        // 真 Chrome 需 vk/code 才可靠入字（空格尤甚）；其它字符靠 text 注入
        const vk = ch === " " ? 32 : /^[a-zA-Z0-9]$/.test(ch) ? ch.toUpperCase().charCodeAt(0) : undefined;
        const down: Record<string, unknown> = { type: "keyDown", text: ch, key: ch };
        const up: Record<string, unknown> = { type: "keyUp", key: ch };
        if (vk !== undefined) {
          down.windowsVirtualKeyCode = vk;
          down.code = ch === " " ? "Space" : `Key${ch.toUpperCase()}`;
          up.windowsVirtualKeyCode = vk;
          up.code = down.code;
        }
        await c.send("Input.dispatchKeyEvent", down);
        await c.send("Input.dispatchKeyEvent", up);
      }
      await sleep(jitter(25, 90));
    }
  }

  /** evaluate：隔离世界（页面无法篡改内置对象骗结果）；绝不 Runtime.enable（契约见 cdp.ts）。 */
  async evaluate(id: string, expression: string): Promise<unknown> {
    const c = await this.conn(id);
    let ctxId = this.worlds.get(id);
    if (ctxId === undefined) {
      const tree = await c.send("Page.getFrameTree");
      const frameId = String((tree.frameTree as any)?.frame?.id ?? "");
      const w = await c.send("Page.createIsolatedWorld", { frameId, worldName: "agentany" });
      ctxId = Number((w as any).executionContextId);
      this.worlds.set(id, ctxId);
    }
    const r = await c.send("Runtime.evaluate", { expression, contextId: ctxId, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new Error(`evaluate 异常: ${d}`);
    }
    const res = r.result ?? {};
    return res.value !== undefined ? res.value : (res.description ?? String(res.type));
  }

  /** 页面视口截图（JPEG 压缩，约定同 P3：内容清晰即够）。 */
  async screenshot(id: string, quality = 80): Promise<Buffer> {
    const c = await this.conn(id);
    const r = await c.send("Page.captureScreenshot", { format: "jpeg", quality });
    return Buffer.from(String(r.data), "base64");
  }
}
