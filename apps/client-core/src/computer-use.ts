// computer-use 三工具执行器（ADR-0036 / R-6 P3）：computer_use.screens / observe / act。
// 承载 = macOS 原生桥（packages/computer-use-macos，子进程 JSON-lines RPC）——坐标/截图/输入全在桥内，
// device-core 只做：spawn 桥、组请求、软 stateId（观察过期提示不硬拒）、截图写工作区上传 artifact。
// 桥路径：env AGENTANY_CU_BIN → ~/.agentany/bin/computeruse → 清晰报错。
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultExecutors } from "./executors";
import type { ExecContext, ExecOutcome, ToolHandler } from "./executor-types";

export interface ComputerUseHandlers {
  "computer_use.screens": ToolHandler;
  "computer_use.observe": ToolHandler;
  "computer_use.act": ToolHandler;
}

type BridgeResp = { id: string | number; ok: boolean; error?: string; code?: string; [k: string]: unknown };

// —— 桥子进程（懒单例；JSON-lines 请求/响应按 id 关联；请求互斥串行——桥一次处理一条） ——
export class BridgeClient {
  private static singleton: BridgeClient | null = null;
  private child: ReturnType<typeof spawn> | null = null;
  private buffer = "";
  // 请求 id 用数字：真桥 main.swift `(obj["id"] as? Int) ?? 0`，字符串 id 会降到 0 导致永不匹配（挂死）。
  private pending = new Map<number, (r: BridgeResp) => void>();
  private seq = 0;
  private tail: Promise<void> = Promise.resolve();

  static get(): BridgeClient {
    if (!this.singleton) this.singleton = new BridgeClient();
    return this.singleton;
  }

  /** 重置单例（测试隔离：换 AGENTANY_CU_BIN 后重建桥）。 */
  static resetForTests(): void {
    this.singleton?.child?.kill();
    this.singleton = null;
  }

  request(cmd: string, params: Record<string, unknown> = {}): Promise<BridgeResp> {
    const run = (): Promise<BridgeResp> => {
      const id = ++this.seq;
      return new Promise<BridgeResp>((resolve) => {
        const child = this.ensure();
        if (!child) {
          resolve({ id, ok: false, error: "bridge 不可用（AGENTANY_CU_BIN 缺失？）", code: "bridge_exited" });
          return;
        }
        this.pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ id, cmd, ...params }) + "\n");
      });
    };
    const p = this.tail.then(run);
    this.tail = p.then(() => undefined, () => undefined);
    return p;
  }

  private ensure() {
    if (this.child) return this.child;
    let child: ReturnType<typeof spawn> | null = null;
    try {
      child = spawn(bridgeBin(), [], { stdio: ["pipe", "pipe", "inherit"] });
    } catch {
      return null; // 桥不存在/不可执行
    }
    const die = (): void => {
      this.child = null; // 下次 request 重建
      const flush = this.pending;
      this.pending = new Map();
      for (const resolve of flush.values()) resolve({ id: "", ok: false, error: "bridge exited", code: "bridge_exited" });
    };
    child.on("exit", die);
    child.on("error", () => die()); // bun 以 async error 事件报 spawn 失败（ENOENT 等）
    child.stdout.on("data", (d: Buffer) => {
      this.buffer += d.toString("utf8");
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line) as BridgeResp;
          const resolve = this.pending.get(resp.id);
          if (resolve) {
            this.pending.delete(resp.id);
            resolve(resp);
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });
    this.child = child;
    return child;
  }
}

function bridgeBin(): string {
  const env = process.env.AGENTANY_CU_BIN;
  if (env) return env;
  return join(homedir(), ".agentany", "bin", "computeruse");
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const DEFAULT_MAX_LONG_EDGE = 2048;
const DEFAULT_IMAGE_FORMAT = "jpeg"; // 传输/存储默认走 JPEG 压缩（ADR-0036：内容清晰即够，服务不需原尺寸）

// —— 工具实现 ——
function makeHandlers(): ComputerUseHandlers {
  // 设备侧「当前视野」软状态：stateId = 观察/动作序数；views = 各目标最近 observe 的坐标契约。
  let epoch = 0;
  const bump = (): number => ++epoch;
  const views = new Map<string, { imageW: number; imageH: number; pt: Record<string, unknown>; displayId?: string }>();
  const viewKey = (target: unknown, targetId: unknown): string => `${String(target)}:${String(targetId)}`;

  const stashView = (r: BridgeResp): void => {
    views.set(viewKey(r.target, r.target_id), {
      imageW: Number(r.image_w ?? 0),
      imageH: Number(r.image_h ?? 0),
      pt: (r.pt as Record<string, unknown>) ?? {},
      displayId: r.target === "display" ? String(r.target_id) : undefined,
    });
  };
  /** act 坐标所需的视野：window_id/display_id 显式 → 该目标上次 observe；缺省 → 最近一次。 */
  const lastView = (a: Record<string, unknown>) => {
    if (typeof a.window_id === "number") return views.get(`window:${a.window_id}`);
    if (typeof a.display_id === "string") return views.get(`display:${a.display_id}`);
    let last: ReturnType<typeof views.get> | undefined;
    for (const v of views.values()) last = v;
    return last;
  };

  const uploadSnap = async (ctx: ExecContext, tag: string, r: BridgeResp): Promise<{ artifacts: { name: string; path: string }[] }> => {
    const bytes = Buffer.from(String(r.png_base64), "base64");
    const ext = typeof r.image_ext === "string" ? r.image_ext : "png";
    const file = `cu/s${epoch}-${tag}.${ext}`;
    const abs = join(ctx.workDir, file);
    await fs.mkdir(join(ctx.workDir, "cu"), { recursive: true });
    await fs.writeFile(abs, bytes);
    // 约定同 P2 执行器：返回本地绝对路径，产物统一由 dispatcher ctx.upload 回传（不自传服务器路径）。
    return { artifacts: [{ name: file.split("/").pop()!, path: abs }] };
  };

  async function screens(_args: unknown, _ctx: ExecContext): Promise<ExecOutcome> {
    const r = await BridgeClient.get().request("screens");
    if (!r.ok) return { ok: false, error: r.error ?? "screens failed", code: r.code };
    const displays = (r.displays as Array<Record<string, unknown>>) ?? [];
    const windows = (r.windows as Array<Record<string, unknown>>) ?? [];
    const lines: string[] = [`displays: ${displays.length}`];
    for (const d of displays) {
      lines.push(`  #${d.id} ${d.width}x${d.height}@(${d.x},${d.y}) scale=${d.scale} phys=${d.phys_w}x${d.phys_h}`);
    }
    lines.push(`windows: ${windows.length}`);
    for (const w of windows.slice(0, 50)) {
      lines.push(`  [${w.id}] ${w.owner}: ${w.title ?? ""} ${w.w}x${w.h}@(${w.x},${w.y})${w.focused ? " *" : ""}`);
    }
    return { ok: true, stdout: lines.join("\n") };
  }

  async function observe(args0: unknown, ctx: ExecContext): Promise<ExecOutcome> {
    const a = args0 as Record<string, unknown>;
    const params: Record<string, unknown> = {
      mode: a.mode === "visual+ax" ? "visual+ax" : "visual",
      max_long_edge: num(a.max_long_edge) ?? DEFAULT_MAX_LONG_EDGE,
      image_format: a.image_format === "png" ? "png" : DEFAULT_IMAGE_FORMAT,
    };
    if (typeof a.quality === "number") params.quality = a.quality;
    if (typeof a.display_id === "string") params.display_id = a.display_id;
    if (typeof a.window_id === "number") params.window_id = a.window_id;
    const r = await BridgeClient.get().request("observe", params);
    if (!r.ok) return { ok: false, error: r.error ?? "observe failed", code: r.code };
    if (typeof r.png_base64 !== "string") return { ok: false, error: "observe: no screenshot returned", code: "bridge_bad_response" };
    const stateId = bump();
    stashView(r);
    const snap = await uploadSnap(ctx, `observe-${r.target_id}`, r);
    const outline = typeof r.outline === "object" && r.outline !== null ? "，AX outline ✓（引用 ref 可精确操作）" : "";
    return {
      ok: true,
      stdout: `observe (stateId ${stateId}): ${r.target} ${r.target_id}, image ${r.image_w}x${r.image_h}, phys ${r.phys_w}x${r.phys_h}, mode ${params.mode as string}${outline}`,
      ...snap,
    };
  }

  async function act(args0: unknown, ctx: ExecContext): Promise<ExecOutcome> {
    const a = args0 as Record<string, unknown>;
    const action = a.action as Record<string, unknown> | undefined;
    if (!action || typeof action.type !== "string") {
      return { ok: false, error: "computer_use.act requires action.type", code: "invalid_args" };
    }
    const hasRef = typeof a.ref === "string" && a.ref.length > 0;
    const view = hasRef ? undefined : lastView(a);
    const params: Record<string, unknown> = { action };
    if (hasRef) {
      params.ref = a.ref;
    } else {
      if (!view) {
        return { ok: false, error: "act 需要先 observe（取得坐标视野）或提供 ref 定位", code: "need_observe" };
      }
      params.image_w = view.imageW;
      params.image_h = view.imageH;
      params.pt = view.pt;
      if (view.displayId) params.display_id = view.displayId;
      if (typeof a.x === "number") params.x = a.x;
      if (typeof a.y === "number") params.y = a.y;
      params.max_long_edge = num(a.max_long_edge) ?? DEFAULT_MAX_LONG_EDGE;
      params.image_format = a.image_format === "png" ? "png" : DEFAULT_IMAGE_FORMAT;
      if (typeof a.quality === "number") params.quality = a.quality;
    }
    const stateId = num(a.state_id); // 软过期：仅提示，不硬拒
    const r = await BridgeClient.get().request("act", params);
    if (!r.ok) return { ok: false, error: r.error ?? "act failed", code: r.code };
    const newEpoch = bump();
    const snap = typeof r.png_base64 === "string"
      ? await uploadSnap(ctx, `after-${String(r.action?.type ?? "act")}`, r)
      : { artifacts: undefined };
    const stale = stateId !== undefined && stateId !== epoch - 1
      ? " — warning: 状态可能过期，建议先 observe 再操作"
      : "";
    return { ok: true, stdout: `act ${JSON.stringify(r.action)}（新 stateId ${newEpoch}）${stale}`, ...snap };
  }

  return { "computer_use.screens": screens, "computer_use.observe": observe, "computer_use.act": act };
}

/** P3 完整执行器表：五执行器 + computer-use 三件套。 */
export function allExecutors(): Record<string, ToolHandler> {
  return { ...defaultExecutors(), ...makeHandlers() };
}