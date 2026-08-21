// AgentClient 会话 seam（issue #9 迁移后 client 仓主链路）：AgentClient + @agentany/mock-server
// 全栈 round-trip——device-login 换 token → WS 建连 → tool_call 编排 → 执行器分派 →
// 产物上传 /files/device-upload。真服务器版本 = server 仓 r6-e2e-client（集成层）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockServer, type MockServer } from "@agentany/mock-server";
import { AgentClient } from "../src/session";

describe("AgentClient × mock-server（全栈 round-trip）", () => {
  let m: MockServer;
  let agent: AgentClient;
  afterEach(() => {
    agent?.stop();
    m?.close();
  });

  const setup = async (handlers: ConstructorParameters<typeof AgentClient>[0]["handlers"]) => {
    m = createMockServer({ users: [{ username: "u1", password: "pw" }], runs: [{ runId: "run-1", ownerUsername: "u1" }] });
    const r = await fetch(`${m.origin}/auth/device-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u1", password: "pw", deviceId: "dev-1" }),
    });
    const { token } = (await r.json()) as { token: string };
    const base = mkdtempSync(join(tmpdir(), "agentany-session-"));
    agent = new AgentClient({
      wsUrl: m.wsUrl("/ws/device"),
      token,
      deviceId: "dev-1",
      handlers,
      workDir: (runId) => join(base, runId.replace(/[/\\:]/g, "_")),
      grantsDir: mkdtempSync(join(tmpdir(), "agentany-grants-")), // 授权档隔离（P5b：不读真 HOME）
    });
    agent.connect();
    await m.waitForDevice("u1");
    return base;
  };

  test("tool_call → 执行器 → tool_result + 产物上传（runs/<runId>/<name>）", async () => {
    let seenWorkDir = "";
    const base = await setup({
      bash: async (args, ctx) => {
        seenWorkDir = ctx.workDir;
        const out = join(ctx.workDir, "out.txt");
        writeFileSync(out, `hello ${String((args as { command: string }).command)}`);
        return { ok: true, code: 0, stdout: `ran: ${String((args as { command: string }).command)}`, artifacts: [{ name: "out.txt", path: out }] };
      },
    });
    const res = await m.sendToolCall({ username: "u1", tool: "bash", args: { command: "echo hi" }, runId: "run-1" });
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("ran: echo hi");
    expect(seenWorkDir).toBe(join(base, "run-1")); // 每 run 工作区解析
    // 产物回传：真 multipart 到 /files/device-upload，服务器侧相对路径 + 字节落盘
    expect(res.artifacts).toHaveLength(1);
    expect(res.artifacts![0]).toMatchObject({ name: "out.txt", size: 13, path: "runs/run-1/out.txt" });
    expect(m.uploads).toHaveLength(1);
    expect(Buffer.from(m.uploads[0].bytes).toString()).toBe("hello echo hi");
    expect(m.uploads[0].byUsername).toBe("u1");
  });

  test("未知工具 → ok:false code unknown_tool（失败不断连）", async () => {
    await setup({});
    const res = await m.sendToolCall({ username: "u1", tool: "nope", args: {}, runId: "run-1" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("unknown_tool");
    expect(res.error).toContain("unknown tool: nope");
    // 连接仍在：再编排一次不 reject（掉线会 device offline reject）+ registry 仍在线
    const again = await m.sendToolCall({ username: "u1", tool: "nope", args: {}, runId: "run-1" });
    expect(again.ok).toBe(false);
    expect(m.currentDevice("u1")).toBe("dev-1");
  });
});
