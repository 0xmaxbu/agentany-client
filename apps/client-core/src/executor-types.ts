// 执行器契约（ADR-0036 / R-6 P2 五执行器）：纯函数式 handler——输入 args + 上下文 → 结构化结果。
// 分派层（dispatcher）负责把 tool_call 帧落到 handler、上传本地产物、组 tool_result 回传。
// 执行器**不感知** WS/HTTP/token/run；唯一网络出口 = ctx.upload（产物回传，测试可注入假实现）。
export interface ExecOutcome {
  ok: boolean;
  /** 退出码等（bash 的 exit code；无则省）。 */
  code?: string | number;
  stdout?: string;
  stderr?: string;
  /** ok=false 的结构化原因（直达 LLM，agentic loop 据此重试/止损）。 */
  error?: string;
  /** 产物候选：path = 设备本地绝对路径（分派层随后上传，path 换服务器相对路径）。 */
  artifacts?: { name: string; path: string }[];
}

export interface ExecContext {
  /** 本 run 在设备侧的工作区根（绝对路径，已建）。相对路径以此为基准。 */
  workDir: string;
  /** 上传产物到该 run 服务器工作区；返回服务器相对路径（进 tool_result.artifacts）。 */
  upload(file: { name: string; path: string }): Promise<{ path: string; name: string; size: number }>;
}

/** 执行器：工具名 → handler。 */
export type ToolHandler = (args: unknown, ctx: ExecContext) => Promise<ExecOutcome>;