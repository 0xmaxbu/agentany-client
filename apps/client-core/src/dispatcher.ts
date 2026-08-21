// 工具分派层（R-6 P2 + P5b 授权拦截）：tool_call 帧 → 会话借用授权 gate → 执行器 → 上传产物流 → tool_result 回传。
// 职责线：帧解析/未知工具兜底/每 run 工作区解析/异常兜底——执行器保持纯函数（executor-types.ts）。
// 一次 handle() 一个 tool_call；同连接多 run 并发互不阻塞（每帧独立 await）。
// gate（ADR-0038 D1 统一拦截点）opt-in：AgentClient 默认装配；直用 Dispatcher 的测试/嵌入可不装。
import { basename } from "node:path";
import { mkdirSync } from "node:fs";
import type { ToolCallFrame } from "@agentany/ws-protocol";
import type { DeviceClientMessage } from "@agentany/ws-protocol";
import type { ToolArtifact } from "@agentany/ws-protocol";
import type { ConsentGate } from "./consent";
import type { ExecContext, ToolHandler } from "./executor-types";

export interface UploadResult {
  path: string;
  name: string;
  size: number;
}

export interface ToolDispatcherOpts {
  handlers: Record<string, ToolHandler>;
  /** 每 run 工作区解析器（返回绝对路径；handle 时建目录）。 */
  workDir(runId: string): string;
  /** 产物上传（缺省 = 走真实 POST /files/device-upload；测试注入假实现）。 */
  upload(o: { httpBase: string; token: string; runId: string; file: { name: string; path: string } }): Promise<UploadResult>;
  /** tool_result 回传通道（AgentClient 接 DeviceClient.send）。 */
  send(msg: DeviceClientMessage): void;
  httpBase: string;
  getToken(): string;
  /** 会话借用授权 gate（ADR-0038）：所有 tool_call 过此拦截点再进执行器。 */
  consent?: ConsentGate;
}

export class ToolDispatcher {
  constructor(private readonly o: ToolDispatcherOpts) {}

  /** 处理一个 tool_call：执行 → 上传产物 → 回 tool_result。异常兜底为 ok:false（不断连）。 */
  async handle(frame: ToolCallFrame): Promise<void> {
    const handler = this.o.handlers[frame.tool];
    if (!handler) {
      this.o.send({ type: "tool_result", id: frame.id, ok: false, code: "unknown_tool", error: `unknown tool: ${frame.tool}` });
      return;
    }
    if (this.o.consent) {
      const verdict = await this.o.consent.checkTool({ callId: frame.id, workflowId: frame.workflowId, tool: frame.tool, args: frame.args });
      if (verdict === "denied") {
        // deny = 纯透传（ADR-0038 D6）：run 不中止/不重试/不转 HITL——错误文案即处理（LLM 读它改道）。
        this.o.send({
          type: "tool_result",
          id: frame.id,
          ok: false,
          code: "denied",
          error: `denied by device user: ${frame.tool}（workflow ${frame.workflowId}）——设备用户拒绝本次会话借用；请勿重试同一工具，改用其他路径完成目标`,
        });
        return;
      }
    }
    const workDir = this.o.workDir(frame.runId);
    mkdirSync(workDir, { recursive: true });
    const ctx: ExecContext = {
      workDir,
      upload: (file) =>
        this.o.upload({
          httpBase: this.o.httpBase,
          token: this.o.getToken(),
          runId: frame.runId,
          file,
        }),
    };
    try {
      const out = await handler(frame.args, ctx);
      const artifacts: ToolArtifact[] = [];
      for (const f of out.artifacts ?? []) {
        try {
          const up = await ctx.upload({ name: basename(f.path), path: f.path });
          artifacts.push({ name: up.name, size: up.size, path: up.path });
        } catch (e) {
          // 产物上传失败不回滚结果；加进 stderr 让 LLM 可见。
          out.stderr = ((out.stderr ?? "") + `\n[upload failed] ${(e as Error).message}`).trim();
        }
      }
      this.o.send({
        type: "tool_result",
        id: frame.id,
        ok: out.ok,
        code: out.code,
        stdout: out.stdout,
        stderr: out.stderr,
        error: out.error,
        artifacts: artifacts.length > 0 ? artifacts : undefined,
      });
    } catch (e) {
      this.o.send({ type: "tool_result", id: frame.id, ok: false, error: (e as Error).message });
    }
  }
}