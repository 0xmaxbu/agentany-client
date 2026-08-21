// 会话借用授权（R-6 P5b / ADR-0038 / issue #6）：分派层统一拦截 + 规则引擎。
// 管「能不能用**我的**会话」——设备用户对「某工作流借用本机登录会话/桌面控制」的本地授权
// （≠ 工作流授权 workflow_grants：远端用户、服务器侧，管「这个工作流能不能用 remote」）。
//
// 三层判定（细粒度优先）：例外规则（用户显式编辑）→ remembered（弹窗产生，工作流作用域）→ 全局默认。
// 四档策略：ask_every（每次问）/ ask_first（首次问，同意后记住）/ allow / deny（直接拒，不弹窗）。
// 出厂默认：借用类（browser.* / computer_use.*）= ask_first，其余（五件套）= allow——接入配置信任提示已覆盖。
// 参数敏感锚点（「总是允许」= 同样操作不再问）：
//   browser.*      = 工作流 × 工具面 × host（六件套共享站点授权；host 后缀匹配，忽略 scheme/port/path）
//   computer_use.* = 工作流 × 工具面（坐标每次变，无有意义参数锚点）
//   其余           = 工作流 × tool × args 精确等值（canonical JSON；bash 命令串天然适用）
// 弹窗四选：本次允许（仅当前 callId）/ 总是允许（参数敏感，写 remembered）/ 总是允许该工具（参数不敏感，
// **本工作流内**；全局放行只能经授权管理显式编辑规则）/ 拒绝。60s 无响应视为拒绝。
// 决策经 onConsent 回调注入（无头可测；Tauri 壳实现真弹窗；无回调 = fail closed 拒绝）。
// 拒绝的服务端语义 = 纯透传 tool_result {code:"denied"}（ADR-0038 D6）。
// 存储：~/.agentany/grants.json（0600，version 预留迁移）。
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnvRequirement } from "@agentany/ws-protocol";
import type { ConfigOpts } from "./config";

export type ConsentPolicy = "ask_every" | "ask_first" | "allow" | "deny";

/** 例外规则：缺维度 = 通配；细粒度（维度多）优先，同粒度先出现者优先。 */
export interface ConsentRule {
  workflowId?: string;
  /** 工具名或命名空间段（"browser" 匹配 browser.*；"bash" 精确）。 */
  tool?: string;
  /** 仅对带 host 的请求（browser.*）有意义；后缀匹配。 */
  host?: string;
  policy: ConsentPolicy;
}

/** remembered（弹窗产生，工作流作用域）——四种锚点对应参数敏感三分支 + 「总是允许该工具」。 */
export type RememberedGrant =
  | { workflowId: string; face: "browser"; host: string } // browser「总是允许」：六件套共享站点授权
  | { workflowId: string; face: "computer_use" } // computer-use「总是允许」：工具面
  | { workflowId: string; tool: string; args: string } // 五件套「总是允许」：args canonical JSON 等值
  | { workflowId: string; tool: string; anyArgs: true }; // 「总是允许该工具」：参数不敏感（本工作流内）

export interface GrantsFile {
  version: 1;
  /** 全局默认档（授权管理 UI 可改；缺省 borrow=ask_first / rest=allow）。 */
  defaults?: { borrow?: ConsentPolicy; rest?: ConsentPolicy };
  rules?: ConsentRule[];
  remembered?: RememberedGrant[];
}

const grantsPath = (o?: ConfigOpts): string => join(o?.dir ?? join(homedir(), ".agentany"), "grants.json");

/** 读授权档：缺文件/损坏 → 空档（fail closed：无 remembered/规则，借用类回到默认询问）。 */
export function readGrants(o?: ConfigOpts): GrantsFile {
  let raw: string;
  try {
    raw = readFileSync(grantsPath(o), "utf8");
  } catch {
    return { version: 1 };
  }
  try {
    const g = JSON.parse(raw) as GrantsFile;
    return g && typeof g === "object" ? g : { version: 1 };
  } catch {
    return { version: 1 };
  }
}

/** 落盘（0600 / 目录 0700；与 client.json 同口径）。 */
export function writeGrants(g: GrantsFile, o?: ConfigOpts): void {
  const dir = o?.dir ?? join(homedir(), ".agentany");
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* 已存在目录权限不强制回改 */
  }
  const p = join(dir, "grants.json");
  writeFileSync(p, JSON.stringify(g, undefined, 2));
  chmodSync(p, 0o600);
}

// —— 纯函数（单测锚）——

/** 稳定序列化：对象键排序（递归），数组保序——args 等值比对基准。 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
};

/** 从参数里的 url 提取 host（browser.navigate 等携带 url 的动作）。非串/不合法 → undefined。 */
export function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length === 0) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** host 后缀匹配：github.com 覆盖 api.github.com；非点后缀不误命中（github.com.evil.io ✗）。 */
export function hostMatches(host: string, anchorHost: string): boolean {
  return host === anchorHost || host.endsWith(`.${anchorHost}`);
}

/** 规则/锚工具匹配：精确名或命名空间段（"browser" → browser.*；"browser.n" 不前缀匹配 browser.navigate）。 */
export function toolNameMatches(pattern: string, tool: string): boolean {
  return pattern === tool || tool.startsWith(`${pattern}.`);
}

/** 借用类工具面（其余 = 标准五件套，不属借用）。 */
export type ToolFace = "browser" | "computer_use";

export const faceOf = (tool: string): ToolFace | undefined =>
  tool.startsWith("browser.") ? "browser" : tool.startsWith("computer_use.") ? "computer_use" : undefined;

// —— onConsent 抽象 ——

export type ConsentRequest =
  | { kind: "tool"; callId: string; workflowId: string; tool: string; args: unknown; host?: string }
  | { kind: "env"; pendingStartId: string; workflowId: string; items: EnvRequirement[] }; // autoInstall 同意/拒绝（PRD US 5-6）

export type ConsentDecision = { action: "allow_once" | "allow_always" | "allow_tool" | "deny" };

export type ConsentCallback = (req: ConsentRequest) => Promise<ConsentDecision>;

export interface ConsentGateOpts {
  /** 弹窗决策回调（Tauri 壳实现真弹窗；测试注入假实现；缺省 = fail closed 拒绝）。 */
  onConsent?: ConsentCallback;
  /** grants.json 目录（缺省 ~/.agentany；测试注入）。 */
  dir?: string;
  /** 询问超时 ms（缺省 60s；超时视为拒绝）。 */
  askTimeoutMs?: number;
  /** browser 无 url 参数动作（click/fill…）取当前页 host——「允许在 github.com 导航，点击/输入自然跟随」。 */
  currentHost?: () => string | undefined;
}

interface ToolReq {
  workflowId: string;
  tool: string;
  args: unknown;
  host?: string;
  face?: ToolFace;
}

const ruleMatches = (r: ConsentRule, q: ToolReq): boolean => {
  if (r.workflowId !== undefined && r.workflowId !== q.workflowId) return false;
  if (r.tool !== undefined && !toolNameMatches(r.tool, q.tool)) return false;
  if (r.host !== undefined && (q.host === undefined || !hostMatches(q.host, r.host))) return false;
  return true;
};

const specificityOf = (r: ConsentRule): number =>
  (r.workflowId !== undefined ? 1 : 0) + (r.tool !== undefined ? 1 : 0) + (r.host !== undefined ? 1 : 0);

const rememberedMatches = (g: RememberedGrant, q: ToolReq): boolean => {
  if (g.workflowId !== q.workflowId) return false;
  if ("anyArgs" in g) return g.tool === q.tool; // 「总是允许该工具」：参数不敏感，仅该工具
  if ("face" in g) {
    if (g.face === "computer_use") return q.face === "computer_use";
    return q.face === "browser" && q.host !== undefined && hostMatches(q.host, g.host); // 站点授权（六件套共享）
  }
  return q.tool === g.tool && canonicalJson(q.args) === g.args; // 五件套：args 精确等值
};

/** 统一拦截点：所有 tool_call 过此 gate（ADR-0038 D1）。返回 execute / denied。 */
export class ConsentGate {
  private readonly onConsent?: ConsentCallback;
  private readonly dirOpt?: ConfigOpts;
  private readonly askTimeoutMs: number;
  private readonly currentHost?: () => string | undefined;

  constructor(o: ConsentGateOpts = {}) {
    this.onConsent = o.onConsent;
    this.dirOpt = o.dir !== undefined ? { dir: o.dir } : undefined;
    this.askTimeoutMs = o.askTimeoutMs ?? 60_000;
    this.currentHost = o.currentHost;
  }

  async checkTool(q0: { callId: string; workflowId: string; tool: string; args: unknown; host?: string }): Promise<"execute" | "denied"> {
    const grants = readGrants(this.dirOpt);
    const q: ToolReq = {
      workflowId: q0.workflowId,
      tool: q0.tool,
      args: q0.args,
      face: faceOf(q0.tool),
      host: q0.host ?? hostOf((q0.args as { url?: unknown } | null | undefined)?.url) ?? this.currentHost?.(),
    };
    // ① 例外规则（细粒度优先；同粒度先出现者优先）——allow/deny 即决；ask 档仍可被 remembered 记住（ask_first 语义）
    let best: ConsentRule | undefined;
    for (const r of grants.rules ?? []) {
      if (!ruleMatches(r, q)) continue;
      if (!best || specificityOf(r) > specificityOf(best)) best = r;
    }
    // ② remembered（弹窗产生，工作流作用域；细于全局默认）：命中即放行——除非命中档是 ask_every（每次问=不认记忆）
    const rememberedHit = (grants.remembered ?? []).some((g) => rememberedMatches(g, q));
    if (best) {
      if (best.policy === "allow") return "execute";
      if (best.policy === "deny") return "denied"; // 命中直接拒，不弹窗
      if (best.policy === "ask_first" && rememberedHit) return "execute";
      return this.ask(grants, q, q0.callId); // ask_every（或 ask_first 无记忆）
    }
    if (rememberedHit) return "execute"; // 记忆细于默认档（改默认 deny 也不翻旧账——撤记忆走授权管理）
    // ③ 全局默认（借用类 ask_first / 其余 allow；授权管理可改档）
    const policy = q.face ? grants.defaults?.borrow ?? "ask_first" : grants.defaults?.rest ?? "allow";
    if (policy === "allow") return "execute";
    if (policy === "deny") return "denied";
    return this.ask(grants, q, q0.callId);
  }

  /** env 挂起补全的同意/拒绝（同一 onConsent 抽象；allow_* → 同意，deny/超时/无回调 → 拒绝）。 */
  async checkEnv(o: { pendingStartId: string; workflowId: string; items: EnvRequirement[] }): Promise<boolean> {
    const d = await this.settle(this.onConsent?.({ kind: "env", ...o }));
    return Boolean(d && d.action !== "deny");
  }

  private async ask(grants: GrantsFile, q: ToolReq, callId: string): Promise<"execute" | "denied"> {
    const decision = await this.settle(this.onConsent?.({ kind: "tool", callId, workflowId: q.workflowId, tool: q.tool, args: q.args, host: q.host }));
    if (!decision || decision.action === "deny") return "denied";
    const remembered = [...(grants.remembered ?? [])];
    if (decision.action === "allow_tool") {
      remembered.push({ workflowId: q.workflowId, tool: q.tool, anyArgs: true }); // 参数不敏感，本工作流内
    } else if (decision.action === "allow_always") {
      if (q.face === "browser" && q.host !== undefined) remembered.push({ workflowId: q.workflowId, face: "browser", host: q.host });
      else if (q.face === "computer_use") remembered.push({ workflowId: q.workflowId, face: "computer_use" });
      else if (q.face === undefined) remembered.push({ workflowId: q.workflowId, tool: q.tool, args: canonicalJson(q.args) });
      else remembered.push({ workflowId: q.workflowId, tool: q.tool, anyArgs: true }); // browser 无 host 可锚 → 退化为该工具（工作流内）
    }
    writeGrants({ ...grants, remembered }, this.dirOpt);
    return "execute";
  }

  /** 回调结算：无回调/超时/异常 → undefined（= 拒绝，fail closed）。 */
  private settle(p: Promise<ConsentDecision> | undefined): Promise<ConsentDecision | undefined> {
    if (!p) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(undefined), this.askTimeoutMs);
      p.then(
        (d) => {
          clearTimeout(t);
          resolve(d);
        },
        () => {
          clearTimeout(t);
          resolve(undefined);
        },
      );
    });
  }
}
