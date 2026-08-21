// P5b 端到端（ADR-0038 / issue #6）：AgentClient × @agentany/mock-server。
// 覆盖：deny 规则纯透传（tool_result code:denied，连接不断）/ 借用类默认询问 + allow_always 写站点锚 /
// env 链路（check_environment 逐项探测 → env_report 原始表；env_pending → onConsent → autoInstall →
// env_remediated 同意/拒绝两路）。规则引擎单元行为见 consent.test.ts；真服务器版本 = server 仓 r6 seam。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockServer, type MockServer } from "@agentany/mock-server";
import { AgentClient } from "../src/session";
import { readGrants, writeGrants, type ConsentCallback, type ConsentRequest, type GrantsFile } from "../src/consent";
import type { ToolHandler } from "../src/executor-types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) {
    if (pred()) return;
    await delay(10);
  }
  throw new Error("delayUntil timeout");
};

describe("P5b · 会话借用授权 + env 链路（AgentClient × mock-server）", () => {
  let m: MockServer;
  let agent: AgentClient;
  afterEach(() => {
    agent?.stop();
    m?.close();
  });

  const setup = async (o: { grants?: GrantsFile; onConsent?: ConsentCallback; handlers?: Record<string, ToolHandler>; runEnvCommand?: (cmd: string) => Promise<{ ok: boolean; code?: number; stdout?: string; stderr?: string }> }) => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }], runs: [{ runId: "run-1", ownerUsername: "u1" }] });
    const r = await fetch(`${m.origin}/auth/device-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u1", password: "pw", deviceId: "dev-1" }),
    });
    const { token } = (await r.json()) as { token: string };
    const grantsDir = mkdtempSync(join(tmpdir(), "agentany-flow-"));
    if (o.grants) writeGrants(o.grants, { dir: grantsDir });
    agent = new AgentClient({
      wsUrl: m.wsUrl("/ws/device"),
      token,
      deviceId: "dev-1",
      handlers: o.handlers ?? { bash: async (args) => ({ ok: true, code: 0, stdout: `ran:${String((args as { command?: string }).command)}` }) },
      workDir: () => mkdtempSync(join(tmpdir(), "agentany-wd-")),
      grantsDir,
      onConsent: o.onConsent,
      runEnvCommand: o.runEnvCommand,
    });
    agent.connect();
    await m.waitForDevice("u1");
    return { grantsDir };
  };

  test("deny 规则 → tool_result {ok:false, code:'denied'} 纯透传；连接不断，未命中工作流照常执行", async () => {
    await setup({ grants: { version: 1, rules: [{ workflowId: "wf-9", tool: "bash", policy: "deny" }] } });
    const res = await m.sendToolCall({ username: "u1", tool: "bash", args: { command: "ls" }, runId: "run-1", workflowId: "wf-9" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("denied");
    expect(res.error).toContain("denied by device user");
    expect(res.error).toContain("改用其他路径");
    expect(m.currentDevice("u1")).toBe("dev-1"); // deny ≠ 断连（ADR-0038 D6：工具级失败透传）
    const ok2 = await m.sendToolCall({ username: "u1", tool: "bash", args: { command: "ls" }, runId: "run-1", workflowId: "wf-other" });
    expect(ok2.ok).toBe(true); // 规则未命中的工作流不受影响
  });

  test("借用类默认询问：allow_always → 首问（带 host/workflowId）+ 站点锚落盘；同站二次免问", async () => {
    const asked: ConsentRequest[] = [];
    const { grantsDir } = await setup({
      handlers: { "browser.navigate": async () => ({ ok: true, code: 0, stdout: "nav" }) },
      onConsent: async (r) => {
        asked.push(r);
        return { action: "allow_always" };
      },
    });
    const r1 = await m.sendToolCall({ username: "u1", tool: "browser.navigate", args: { url: "https://github.com/a/b" }, runId: "run-1", workflowId: "wf-9" });
    expect(r1.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "tool", tool: "browser.navigate", host: "github.com", workflowId: "wf-9", callId: expect.stringMatching(/^tool-/) });
    const r2 = await m.sendToolCall({ username: "u1", tool: "browser.navigate", args: { url: "https://api.github.com/x" }, runId: "run-1", workflowId: "wf-9" });
    expect(r2.ok).toBe(true);
    expect(asked).toHaveLength(1); // 站点锚（host 后缀覆盖子域）免问
    expect(readGrants({ dir: grantsDir }).remembered).toEqual([{ workflowId: "wf-9", face: "browser", host: "github.com" }]);
  });

  test("env 链路：check_environment 逐项探测 → env_report 原始表；同意 → 跑 autoInstall → env_remediated(approved)", async () => {
    const ranInstall: string[] = [];
    await setup({
      runEnvCommand: async (cmd) => {
        if (cmd === "brew install ffmpeg") {
          ranInstall.push(cmd);
          return { ok: true, code: 0 };
        }
        return cmd === "check-ok" ? { ok: true, code: 0 } : { ok: false, code: 1, stderr: "not found" };
      },
      onConsent: async (r) => (r.kind === "env" ? { action: "allow_once" } : { action: "deny" }),
    });
    const report = await m.sendCheckEnvironment({
      username: "u1",
      requirements: [
        { id: "gpu", name: "GPU", check: "check-ok", autoInstall: null },
        { id: "ffmpeg", name: "ffmpeg", check: "check-missing", autoInstall: "brew install ffmpeg" },
      ],
    });
    expect(report.result.table).toEqual([
      { id: "gpu", name: "GPU", ok: true, autoInstallable: false },
      { id: "ffmpeg", name: "ffmpeg", ok: false, reason: "not found", autoInstallable: true },
    ]);
    expect(report.result.status).toBe("fail_installable"); // 提示值（服务端重派真值）

    m.sendEnvPending({ username: "u1", pendingStartId: "p-1", workflowId: "wf-9", items: [{ id: "ffmpeg", name: "ffmpeg", check: "check-missing", autoInstall: "brew install ffmpeg" }] });
    await delayUntil(() => m.remediations().length === 1);
    expect(m.remediations()[0]).toMatchObject({ type: "env_remediated", pendingStartId: "p-1", approved: true });
    expect(ranInstall).toEqual(["brew install ffmpeg"]); // 同意后本地执行了安装命令
  });

  test("env_pending 拒绝 → env_remediated(approved:false)，不跑安装", async () => {
    const ran: string[] = [];
    await setup({
      runEnvCommand: async (cmd) => {
        ran.push(cmd);
        return { ok: true, code: 0 };
      },
      onConsent: async () => ({ action: "deny" }),
    });
    m.sendEnvPending({ username: "u1", pendingStartId: "p-2", workflowId: "wf-9", items: [{ id: "x", name: "x", check: "c", autoInstall: "install-x" }] });
    await delayUntil(() => m.remediations().length === 1);
    expect(m.remediations()[0]).toMatchObject({ type: "env_remediated", pendingStartId: "p-2", approved: false });
    expect(ran).toEqual([]);
  });
});
