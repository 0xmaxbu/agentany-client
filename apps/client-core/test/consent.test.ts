// 会话借用授权（R-6 P5b / ADR-0038 / issue #6）：规则引擎 + gate 单测。
// 覆盖：四档策略 / 三层判定（例外规则 > remembered > 全局默认，细粒度优先）/ 参数敏感锚点三分支
// （browser=工作流×工具面×host 后缀、computer_use=工作流×工具面、五件套=工作流×tool×args canonical 等值）/
// 弹窗四选写 remembered / 60s 超时=拒绝 / 无 onConsent fail-closed / grants.json 0600 带版本。
// 端到端（deny 透传 / env 链路）在 session.test / consent-flow（对 mock-server）。
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  ConsentGate,
  hostMatches,
  hostOf,
  readGrants,
  toolNameMatches,
  writeGrants,
  type ConsentCallback,
  type ConsentDecision,
  type ConsentRequest,
  type GrantsFile,
} from "../src/consent";

const tmpDir = () => mkdtempSync(join(tmpdir(), "agentany-grants-"));
const allowOnce: ConsentDecision = { action: "allow_once" };
const cb = (impl: (req: ConsentRequest) => ConsentDecision | Promise<ConsentDecision>): ConsentCallback => async (req) => impl(req);

describe("规则引擎 · 纯函数", () => {
  test("canonicalJson：对象键序稳定（递归），数组保序", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson([{ x: 1 }, { y: 2 }])).toBe('[{"x":1},{"y":2}]');
  });

  test("hostOf：从 url 提取 hostname；非串/垃圾 → undefined", () => {
    expect(hostOf("https://api.github.com/path?q=1")).toBe("api.github.com");
    expect(hostOf("http://localhost:3000/")).toBe("localhost");
    expect(hostOf("not a url")).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
    expect(hostOf(42)).toBeUndefined();
  });

  test("hostMatches：相等或点后缀（github.com 覆盖子域；非后缀不误命中）", () => {
    expect(hostMatches("github.com", "github.com")).toBe(true);
    expect(hostMatches("api.github.com", "github.com")).toBe(true);
    expect(hostMatches("notgithub.com", "github.com")).toBe(false);
    expect(hostMatches("github.com.evil.io", "github.com")).toBe(false);
  });

  test("toolNameMatches：精确或命名空间段（browser → browser.*；browser.n 不前缀匹配）", () => {
    expect(toolNameMatches("bash", "bash")).toBe(true);
    expect(toolNameMatches("browser", "browser.navigate")).toBe(true);
    expect(toolNameMatches("computer_use", "computer_use.act")).toBe(true);
    expect(toolNameMatches("browser.n", "browser.navigate")).toBe(false);
    expect(toolNameMatches("bash", "bashx")).toBe(false);
  });

  test("grants.json：缺省 {version:1}；读写往返；0600", () => {
    const dir = tmpDir();
    expect(readGrants({ dir })).toEqual({ version: 1 });
    const g: GrantsFile = { version: 1, rules: [{ tool: "bash", policy: "deny" }], remembered: [{ workflowId: "wf", face: "computer_use" }] };
    writeGrants(g, { dir });
    expect(readGrants({ dir })).toEqual(g);
    expect(statSync(join(dir, "grants.json")).mode & 0o777).toBe(0o600);
  });
});

describe("规则引擎 · 三层判定与弹窗四选", () => {
  const tool = (o: { tool: string; args?: unknown; workflowId?: string; host?: string }) =>
    ({ callId: "c1", workflowId: o.workflowId ?? "wf1", tool: o.tool, args: o.args ?? {}, host: o.host }) as const;

  test("全局默认：五件套 allow（不问不拦）；借用类 ask_first 无 onConsent → 拒绝（fail closed）", async () => {
    const dir = tmpDir();
    const g = new ConsentGate({ dir }); // 无 onConsent
    expect(await g.checkTool(tool({ tool: "bash", args: { command: "ls" } }))).toBe("execute");
    expect(await g.checkTool(tool({ tool: "browser.navigate", args: { url: "https://github.com" } }))).toBe("denied");
    expect(await g.checkTool(tool({ tool: "computer_use.act", args: { action: "click" } }))).toBe("denied");
  });

  test("例外规则：deny 命中直接拒（不弹窗）；allow 放行；缺维度=通配", async () => {
    const dir = tmpDir();
    writeGrants({ version: 1, rules: [{ workflowId: "wf1", tool: "bash", policy: "deny" }, { tool: "grep", policy: "allow" }] }, { dir });
    const asked: ConsentRequest[] = [];
    const g = new ConsentGate({ dir, onConsent: cb((r) => (asked.push(r), allowOnce)) });
    expect(await g.checkTool(tool({ tool: "bash" }))).toBe("denied");
    expect(await g.checkTool(tool({ tool: "grep", args: { pattern: "x" } }))).toBe("execute"); // 借用默认外的工具经规则放行
    expect(await g.checkTool(tool({ tool: "write", args: { path: "a" } }))).toBe("execute"); // 未命中 → 默认 allow
    expect(asked).toHaveLength(0);
  });

  test("细粒度优先：{wf,tool,deny} 压过 {tool,allow}；host 维度参与匹配（无 host 请求不命中带 host 规则）", async () => {
    const dir = tmpDir();
    writeGrants({
      version: 1,
      rules: [
        { tool: "browser", policy: "ask_every" },
        { workflowId: "wf1", tool: "browser", host: "github.com", policy: "allow" },
        { tool: "bash", policy: "allow" },
        { workflowId: "wf1", tool: "bash", policy: "deny" },
      ],
    }, { dir });
    const asked: ConsentRequest[] = [];
    const g = new ConsentGate({ dir, onConsent: cb((r) => (asked.push(r), allowOnce)) });
    // 3 维（wf+tool+host）最细：github.com 站点放行
    expect(await g.checkTool(tool({ tool: "browser.navigate", host: "api.github.com" }))).toBe("execute");
    // 带 host 规则不匹配别的域 → 落到 1 维 ask_every → 问
    expect(await g.checkTool(tool({ tool: "browser.navigate", host: "gitlab.com" }))).toBe("execute");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "tool", tool: "browser.navigate", host: "gitlab.com" });
    // bash：2 维 deny 压过 1 维 allow
    expect(await g.checkTool(tool({ tool: "bash" }))).toBe("denied");
    // 请求无 host：带 host 的 3 维规则不命中（不算匹配）→ ask_every 问
    expect(await g.checkTool(tool({ tool: "browser.click" }))).toBe("execute");
    expect(asked).toHaveLength(2);
  });

  test("「总是允许」五件套：参数敏感——同 args 不再问，异 args 再问；仅本工作流", async () => {
    const dir = tmpDir();
    // 把 bash 调成要问（否则默认 allow 测不到 remembered）
    writeGrants({ version: 1, rules: [{ tool: "bash", policy: "ask_first" }] }, { dir });
    const asked: ConsentRequest[] = [];
    const g = new ConsentGate({ dir, onConsent: cb((r) => (asked.push(r), { action: "allow_always" })) });
    expect(await g.checkTool(tool({ tool: "bash", args: { command: "ls" } }))).toBe("execute");
    expect(await g.checkTool(tool({ tool: "bash", args: { command: "ls" } }))).toBe("execute"); // canonical 等值（键序无关）
    expect(asked).toHaveLength(1);
    expect(await g.checkTool(tool({ tool: "bash", args: { command: "rm -rf /" } }))).toBe("execute"); // 异 args 再问
    expect(asked).toHaveLength(2);
    expect(readGrants({ dir }).remembered).toContainEqual({ workflowId: "wf1", tool: "bash", args: canonicalJson({ command: "ls" }) });
    expect(await g.checkTool(tool({ tool: "bash", args: { command: "ls" }, workflowId: "wf2" }))).toBe("execute"); // 他工作流不共享
    expect(asked).toHaveLength(3);
  });

  test("「总是允许」browser：站点授权跨六件套 + host 后缀；currentHost 供无 url 动作（点击跟随）", async () => {
    const dir = tmpDir();
    const asked: ConsentRequest[] = [];
    let pageHost: string | undefined;
    const g = new ConsentGate({ dir, currentHost: () => pageHost, onConsent: cb((r) => (asked.push(r), { action: "allow_always" })) });
    // navigate 带 url → host 从 args 提取；允许即写 {face:browser, host}
    expect(await g.checkTool(tool({ tool: "browser.navigate", args: { url: "https://github.com/org/repo" } }))).toBe("execute");
    expect(readGrants({ dir }).remembered).toEqual([{ workflowId: "wf1", face: "browser", host: "github.com" }]);
    // 六件套共享站点授权：同站 click（无 url，经 currentHost）不再问；子域后缀覆盖
    pageHost = "api.github.com";
    expect(await g.checkTool(tool({ tool: "browser.click", args: { ref: "r1" } }))).toBe("execute");
    // 别的站点仍要问
    pageHost = "gitlab.com";
    expect(await g.checkTool(tool({ tool: "browser.click", args: { ref: "r1" } }))).toBe("execute");
    expect(asked.map((a) => a.kind === "tool" && a.host)).toEqual(["github.com", "gitlab.com"]);
  });

  test("「总是允许」computer_use：工具面参数不敏感（坐标每次变不再问）；仅本工作流", async () => {
    const dir = tmpDir();
    const asked: ConsentRequest[] = [];
    const g = new ConsentGate({ dir, onConsent: cb((r) => (asked.push(r), { action: "allow_always" })) });
    expect(await g.checkTool(tool({ tool: "computer_use.act", args: { x: 1, y: 2 } }))).toBe("execute");
    expect(await g.checkTool(tool({ tool: "computer_use.observe" }))).toBe("execute"); // 同工具面（observe/act 同 face）
    expect(asked).toHaveLength(1);
    expect(readGrants({ dir }).remembered).toEqual([{ workflowId: "wf1", face: "computer_use" }]);
    expect(await g.checkTool(tool({ tool: "computer_use.act", args: { x: 9, y: 9 } }))).toBe("execute"); // 参数每次变不问
    expect(await g.checkTool({ callId: "c", workflowId: "wf2", tool: "computer_use.act", args: {} })).toBe("execute");
    expect(asked).toHaveLength(2); // wf1 首次 + wf2（不共享）
  });

  test("「总是允许该工具」：参数不敏感且仅该工具（工作流内）；与「总是允许」写不同锚", async () => {
    const dir = tmpDir();
    writeGrants({ version: 1, rules: [{ tool: "bash", policy: "ask_first" }] }, { dir });
    const asked: ConsentRequest[] = [];
    const g = new ConsentGate({ dir, onConsent: cb((r) => (asked.push(r), { action: "allow_tool" })) });
    expect(await g.checkTool(tool({ tool: "bash", args: { command: "a" } }))).toBe("execute");
    expect(await g.checkTool(tool({ tool: "bash", args: { command: "b" } }))).toBe("execute"); // 参数不敏感
    expect(asked).toHaveLength(1);
    expect(readGrants({ dir }).remembered).toEqual([{ workflowId: "wf1", tool: "bash", anyArgs: true }]);
    expect(await g.checkTool(tool({ tool: "write" }))).toBe("execute"); // 别的工具不沾光（默认 allow，未问）
    expect(asked).toHaveLength(1);
  });

  test("ask_every：每次问——remembered 也不豁免（用户显式要求逐次确认）", async () => {
    const dir = tmpDir();
    writeGrants({ version: 1, rules: [{ tool: "bash", policy: "ask_every" }] }, { dir });
    const asked: ConsentRequest[] = [];
    const g = new ConsentGate({ dir, onConsent: cb((r) => (asked.push(r), { action: "allow_tool" })) });
    expect(await g.checkTool(tool({ tool: "bash", args: { command: "a" } }))).toBe("execute");
    expect(await g.checkTool(tool({ tool: "bash", args: { command: "a" } }))).toBe("execute"); // 同 args 仍问
    expect(asked).toHaveLength(2);
  });

  test("超时=拒绝：onConsent 悬挂超过 askTimeoutMs → denied", async () => {
    const dir = tmpDir();
    const g = new ConsentGate({ dir, askTimeoutMs: 60, onConsent: () => new Promise<ConsentDecision>(() => {}) });
    expect(await g.checkTool(tool({ tool: "browser.navigate" }))).toBe("denied");
  });

  test("env 同意走 onConsent：allow→true / deny→false / 无回调 false / 超时 false", async () => {
    const dir = tmpDir();
    expect(await new ConsentGate({ dir }).checkEnv({ pendingStartId: "p", workflowId: "wf", items: [] })).toBe(false);
    const g = new ConsentGate({ dir, onConsent: cb((r) => (r.kind === "env" ? allowOnce : { action: "deny" })) });
    expect(await g.checkEnv({ pendingStartId: "p", workflowId: "wf", items: [] })).toBe(true);
    const g2 = new ConsentGate({ dir, onConsent: cb(() => ({ action: "deny" })) });
    expect(await g2.checkEnv({ pendingStartId: "p", workflowId: "wf", items: [] })).toBe(false);
    const g3 = new ConsentGate({ dir, askTimeoutMs: 60, onConsent: () => new Promise<ConsentDecision>(() => {}) });
    expect(await g3.checkEnv({ pendingStartId: "p", workflowId: "wf", items: [] })).toBe(false);
  });
});
