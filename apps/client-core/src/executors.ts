// 五执行器（ADR-0036 / R-6 P2）：bash/write/read/grep/edit——设备本地真实执行，无服务端逻辑。
// 约定：相对 path/cwd 以 run 工作区 workDir 为基准（绝对值原样用）。产物经 ctx.upload 回传。
// 执行承载 = Bun（Bun.spawn/文件 API；device-core 运行在 bun 运行时）。
import { isAbsolute, basename, dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ExecContext, ExecOutcome, ToolHandler } from "./executor-types";

/** 相对路径 → run 工作区基准；绝对路径原样。 */
const resolveIn = (workDir: string, p: string): string => (isAbsolute(p) ? p : join(workDir, p));

/** 跑一条 bash -lc 命令；exit 0 → ok。timeout 用 Bun.spawn 原生（到期杀进程）。 */
async function bash(args0: unknown, ctx: ExecContext): Promise<ExecOutcome> {
  const a = args0 as { command?: unknown; cwd?: unknown; timeoutMs?: unknown };
  const command = typeof a.command === "string" ? a.command : "";
  if (!command.trim()) return { ok: false, error: "bash: empty command" };
  const cwd = typeof a.cwd === "string" ? resolveIn(ctx.workDir, a.cwd) : ctx.workDir;
  const timeoutMs = typeof a.timeoutMs === "number" && a.timeoutMs > 0 ? a.timeoutMs : undefined;
  const p = Bun.spawn(["bash", "-lc", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    env: { ...process.env, AGENTANY_RUN_WORKDIR: ctx.workDir },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = (await p.exited) ?? -1; // 被信号杀 → null → -1
  return { ok: code === 0, code, stdout, stderr };
}

/** write {path, content}：建父目录写文件，并把该文件作产物上传（远端可预览/取用）。 */
async function write(args0: unknown, ctx: ExecContext): Promise<ExecOutcome> {
  const a = args0 as { path?: unknown; content?: unknown };
  const p = typeof a.path === "string" ? a.path : "";
  if (!p) return { ok: false, error: "write: empty path" };
  const content = typeof a.content === "string" ? a.content : String(a.content ?? "");
  const abs = resolveIn(ctx.workDir, p);
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  } catch (e) {
    return { ok: false, error: `write failed: ${(e as Error).message}` };
  }
  return {
    ok: true,
    stdout: `wrote ${p} (${Buffer.byteLength(content)} bytes)`,
    artifacts: [{ name: basename(abs), path: abs }],
  };
}

/** read {path, offset?, limit?}：读文件回内容；offset/limit 按**行**切片（offset 从 0 起）。 */
async function read(args0: unknown, ctx: ExecContext): Promise<ExecOutcome> {
  const a = args0 as { path?: unknown; offset?: unknown; limit?: unknown };
  const p = typeof a.path === "string" ? a.path : "";
  if (!p) return { ok: false, error: "read: empty path" };
  try {
    const text = readFileSync(resolveIn(ctx.workDir, p), "utf8");
    const offset = typeof a.offset === "number" ? Math.max(0, Math.floor(a.offset)) : 0;
    const limit = typeof a.limit === "number" ? Math.max(0, Math.floor(a.limit)) : undefined;
    const out = offset === 0 && !limit ? text : text.split("\n").slice(offset, limit === undefined ? undefined : offset + limit).join("\n");
    return { ok: true, stdout: out };
  } catch (e) {
    return { ok: false, error: `read failed: ${(e as Error).message}` };
  }
}

/** grep {pattern, path?}：递归固定串查找（-rnF）。exit 1=无匹配（ok 保持 true，stdout 空）；exit ≥2=真错误。 */
async function grep(args0: unknown, ctx: ExecContext): Promise<ExecOutcome> {
  const a = args0 as { pattern?: unknown; path?: unknown };
  const pattern = typeof a.pattern === "string" ? a.pattern : "";
  if (!pattern) return { ok: false, error: "grep: empty pattern" };
  const target = typeof a.path === "string" ? resolveIn(ctx.workDir, a.path) : ctx.workDir;
  const p = Bun.spawn(["grep", "-rnF", "--", pattern, target], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = (await p.exited) ?? -1;
  if (code === 1) return { ok: true, code, stdout: "" }; // 无匹配：正常探询结果（agent 读空输出=没找到）
  if (code !== 0) return { ok: false, code, error: `grep failed: ${stderr.trim() || `exit ${code}`}` };
  return { ok: true, code, stdout };
}

/** edit {path, old, new}：字符串全文替换（old 必现；未找到 → ok:false）。改后文件作产物上传。 */
async function edit(args0: unknown, ctx: ExecContext): Promise<ExecOutcome> {
  const a = args0 as { path?: unknown; old?: unknown; new?: unknown };
  const p = typeof a.path === "string" ? a.path : "";
  const oldStr = typeof a.old === "string" ? a.old : "";
  const newStr = typeof a.new === "string" ? a.new : "";
  if (!p) return { ok: false, error: "edit: empty path" };
  if (!oldStr) return { ok: false, error: "edit: empty old" };
  const abs = resolveIn(ctx.workDir, p);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    return { ok: false, error: `edit failed: ${(e as Error).message}` };
  }
  if (!text.includes(oldStr)) return { ok: false, error: `edit: old not found in ${p}` };
  const replaced = text.split(oldStr).length - 1;
  writeFileSync(abs, text.split(oldStr).join(newStr));
  return {
    ok: true,
    stdout: `replaced ${replaced} occurrence(s) in ${p}`,
    artifacts: [{ name: basename(abs), path: abs }],
  };
}

/** 工具名 → 执行器（P2 五件套；后续 computer_use/browser_* 在此追加）。 */
export function defaultExecutors(): Record<string, ToolHandler> {
  return { bash, write, read, grep, edit };
}