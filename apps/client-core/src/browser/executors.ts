// browser_* 六工具执行器（R-6 P4 / ADR-0035 修订：统一 ChromeBackend）：
// tabs / navigate / click / type / evaluate / screenshot。工具语义与反检测姿态全在 core；
// 本层只做参数整形 + 活动页软状态 + artifact 落盘（本地绝对路径交 dispatcher，约定同 P2/P3）。
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ChromeBackend } from "./backend";
import { BrowserCore } from "./core";
import type { ExecContext, ExecOutcome, ToolHandler } from "../executor-types";

export interface BrowserHandlers {
  "browser.tabs": ToolHandler;
  "browser.navigate": ToolHandler;
  "browser.click": ToolHandler;
  "browser.type": ToolHandler;
  "browser.evaluate": ToolHandler;
  "browser.screenshot": ToolHandler;
}

let core: BrowserCore | null = null;
async function theCore(): Promise<BrowserCore> {
  if (!core) core = new BrowserCore((await ChromeBackend.acquire()).httpBase);
  return core;
}

/** 测试隔离：断开 core 并杀/清后端单例。 */
export function resetBrowserForTests(): void {
  core = null;
  ChromeBackend.resetForTests();
}

function fail(e: unknown): ExecOutcome {
  return { ok: false, error: e instanceof Error ? e.message : String(e), code: (e as { code?: string })?.code ?? "browser_error" };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function browserHandlers(): BrowserHandlers {
  // 设备侧「活动页」软状态：tab_id 显式寻址优先；缺省 = 最近操作/最新页（同 computer-use 的视野缓存思路）。
  let activeTab: string | undefined;
  let shotSeq = 0;

  /** tab_id 显式（须存在）→ 活动页 → 最新页；ensurePage 时无页则开新页。 */
  const resolveTab = async (a: Record<string, unknown>, ensurePage = false): Promise<string> => {
    const c = await theCore();
    if (typeof a.tab_id === "string" && a.tab_id) {
      const found = (await c.pages()).find((p) => p.id === a.tab_id);
      if (!found) throw Object.assign(new Error(`tab_id '${a.tab_id}' 不存在（先 browser.tabs 列出）`), { code: "invalid_args" });
      return a.tab_id;
    }
    if (activeTab) return activeTab;
    const ps = await c.pages();
    if (ps.length > 0) return (activeTab = ps[ps.length - 1].id);
    if (ensurePage) return (activeTab = (await c.newPage()).id);
    throw Object.assign(new Error("无浏览器页（先 browser.navigate 或 browser.tabs new）"), { code: "need_tab" });
  };

  async function tabs(args0: unknown, _ctx: ExecContext): Promise<ExecOutcome> {
    const a = (args0 ?? {}) as Record<string, unknown>;
    const action = a.action === "new" || a.action === "close" || a.action === "activate" ? a.action : "list";
    const c = await theCore();
    if (action === "new") {
      const p = await c.newPage(typeof a.url === "string" ? a.url : undefined);
      activeTab = p.id;
      return { ok: true, stdout: `new tab [${p.id}] ${p.url}` };
    }
    if (action === "close" || action === "activate") {
      const id = typeof a.tab_id === "string" ? a.tab_id : activeTab;
      if (!id) return { ok: false, error: `${action} 需要 tab_id（或先有活动页）`, code: "invalid_args" };
      if (action === "close") {
        await c.close(id);
        if (activeTab === id) activeTab = undefined;
        return { ok: true, stdout: `closed [${id}]` };
      }
      await c.activate(id);
      activeTab = id;
      return { ok: true, stdout: `activated [${id}]` };
    }
    const ps = await c.pages();
    const lines = [`tabs: ${ps.length}`];
    for (const p of ps) lines.push(`  [${p.id}]${p.id === activeTab ? " *" : ""} ${p.title} — ${p.url}`);
    return { ok: true, stdout: lines.join("\n") };
  }

  async function navigate(args0: unknown, _ctx: ExecContext): Promise<ExecOutcome> {
    const a = (args0 ?? {}) as Record<string, unknown>;
    if (typeof a.url !== "string" || !a.url) return { ok: false, error: "browser.navigate requires url", code: "invalid_args" };
    try {
      const c = await theCore();
      const id = await resolveTab(a, true);
      const r = await c.navigate(id, a.url);
      activeTab = id;
      return { ok: true, stdout: `navigate ok [${id}]: ${r.url}` };
    } catch (e) {
      return fail(e);
    }
  }

  async function click(args0: unknown, _ctx: ExecContext): Promise<ExecOutcome> {
    const a = (args0 ?? {}) as Record<string, unknown>;
    const x = num(a.x);
    const y = num(a.y);
    if (x === undefined || y === undefined) return { ok: false, error: "browser.click requires x,y（视口像素坐标）", code: "invalid_args" };
    const button = a.button === "right" || a.button === "middle" ? a.button : "left";
    try {
      const c = await theCore();
      const id = await resolveTab(a);
      await c.click(id, Math.round(x), Math.round(y), button);
      return { ok: true, stdout: `click ${button} @ (${Math.round(x)}, ${Math.round(y)}) on [${id}]` };
    } catch (e) {
      return fail(e);
    }
  }

  async function type(args0: unknown, _ctx: ExecContext): Promise<ExecOutcome> {
    const a = (args0 ?? {}) as Record<string, unknown>;
    if (typeof a.text !== "string") return { ok: false, error: "browser.type requires text", code: "invalid_args" };
    try {
      const c = await theCore();
      const id = await resolveTab(a);
      await c.type(id, a.text);
      return { ok: true, stdout: `type ${a.text.length} chars on [${id}]` };
    } catch (e) {
      return fail(e);
    }
  }

  async function evaluate(args0: unknown, _ctx: ExecContext): Promise<ExecOutcome> {
    const a = (args0 ?? {}) as Record<string, unknown>;
    if (typeof a.expression !== "string" || !a.expression) return { ok: false, error: "browser.evaluate requires expression", code: "invalid_args" };
    try {
      const c = await theCore();
      const id = await resolveTab(a);
      const v = await c.evaluate(id, a.expression);
      return { ok: true, stdout: JSON.stringify(v) };
    } catch (e) {
      return fail(e);
    }
  }

  async function screenshot(args0: unknown, ctx: ExecContext): Promise<ExecOutcome> {
    const a = (args0 ?? {}) as Record<string, unknown>;
    const quality = num(a.quality);
    try {
      const c = await theCore();
      const id = await resolveTab(a);
      const buf = await c.screenshot(id, quality !== undefined ? Math.max(10, Math.min(100, quality)) : 80);
      const name = `s${++shotSeq}-shot.jpg`;
      const file = `browser/${name}`;
      const abs = join(ctx.workDir, file);
      await fs.mkdir(join(ctx.workDir, "browser"), { recursive: true });
      await fs.writeFile(abs, buf);
      // 约定同 P2/P3 执行器：返回本地绝对路径，产物统一由 dispatcher ctx.upload 回传。
      return { ok: true, stdout: `screenshot [${id}]: ${buf.length} bytes, jpeg → ${name}`, artifacts: [{ name, path: abs }] };
    } catch (e) {
      return fail(e);
    }
  }

  return {
    "browser.tabs": tabs,
    "browser.navigate": navigate,
    "browser.click": click,
    "browser.type": type,
    "browser.evaluate": evaluate,
    "browser.screenshot": screenshot,
  };
}
