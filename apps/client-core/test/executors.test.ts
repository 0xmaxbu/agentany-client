// P2 五执行器单测：只测外部行为（stdout/stderr/exit code/产物/错误语义），不测内部实现。
// 上下文用临时工作区 + 假 upload（记造产物路径，断言上传调用）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExecutors } from "../src/executors";
import type { ExecContext } from "../src/executor-types";
import { ToolDispatcher } from "../src/dispatcher";
import type { ToolCallFrame } from "@agentany/ws-protocol";

let workDir: string;
let uploadCalls: { name: string; path: string; runId: string }[];
const uploaded = () => [...uploadCalls];

const mkCtx = (): ExecContext => ({
  workDir,
  upload: async (f) => {
    uploadCalls.push({ ...f, runId: "r_test" });
    return { path: `runs/r_test/${f.name}`, name: f.name, size: 1 };
  },
});
const ex = defaultExecutors();

/** 假网络分派：帧 → 回传 tool_result（无真实 WS/HTTP）。断言回传帧。 */
let sentFrames: any[];
const mkDispatcher = (handlers = ex, workDirFn: (runId: string) => string = () => workDir) => {
  sentFrames = [];
  return new ToolDispatcher({
    handlers,
    workDir: workDirFn,
    httpBase: "http://x",
    getToken: () => "t",
    upload: async (o) => ({
      path: `runs/${o.runId}/${o.file.name}`,
      name: o.file.name,
      size: 1,
    }),
    send: (m) => sentFrames.push(m),
  });
};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "x3-"));
  uploadCalls = [];
});
afterEach(() => {});

describe("bash", () => {
  test("echo 正常 → stdout + exit 0", async () => {
    const r = await ex.bash!({ command: "echo hello" }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hello");
  });
  test("非零退出 → ok:false + 真实 exit code", async () => {
    const r = await ex.bash!({ command: "exit 3" }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
  });
  test("cwd 相对路径 → 以工作区为基准", async () => {
    writeFileSync(join(workDir, "marker.txt"), "here");
    const r = await ex.bash!({ command: "cat marker.txt" }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("here");
  });
  test("timeout 到期 → 被杀（ok:false，不再等）", async () => {
    const t0 = Date.now();
    const r = await ex.bash!({ command: "sleep 5", timeoutMs: 150 }, mkCtx());
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.ok).toBe(false);
  });
  test("空 command → 结构化拒绝", async () => {
    const r = await ex.bash!({ command: "   " }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("empty");
  });
});

describe("write", () => {
  test("写文件 + 建父目录 + 产物上传", async () => {
    const r = await ex.write!({ path: "a/b/out.txt", content: "内容1" }, mkCtx());
    expect(r.ok).toBe(true);
    const abs = join(workDir, "a", "b", "out.txt");
    expect(readFileSync(abs, "utf8")).toBe("内容1");
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts![0].name).toBe("out.txt");
    expect(r.artifacts![0].path).toBe(abs);
  });
  test("缺 path → 结构化拒绝", async () => {
    const r = await ex.write!({ content: "x" }, mkCtx());
    expect(r.ok).toBe(false);
  });
});

describe("read", () => {
  test("整读 + offset/limit 行切片", async () => {
    writeFileSync(join(workDir, "f.txt"), "l1\nl2\nl3\nl4");
    const all = await ex.read!({ path: "f.txt" }, mkCtx());
    expect(all.stdout).toBe("l1\nl2\nl3\nl4");
    const slice = await ex.read!({ path: "f.txt", offset: 1, limit: 2 }, mkCtx());
    expect(slice.stdout).toBe("l2\nl3");
  });
  test("文件不存在 → ok:false + 原因", async () => {
    const r = await ex.read!({ path: "nope.txt" }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("read failed");
  });
});

describe("grep", () => {
  test("命中 → 行含文件名与内容", async () => {
    writeFileSync(join(workDir, "a.txt"), "foo bar\nnothing");
    const r = await ex.grep!({ pattern: "foo" }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("a.txt");
    expect(r.stdout).toContain("foo bar");
  });
  test("无匹配 → ok:true 空 stdout（探询非错误）", async () => {
    writeFileSync(join(workDir, "a.txt"), "hello");
    const r = await ex.grep!({ pattern: "zzz" }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("");
  });
  test("指定 path（相对）→ 只搜该文件", async () => {
    writeFileSync(join(workDir, "nested.txt"), "alpha");
    const r = await ex.grep!({ pattern: "alpha", path: "nested.txt" }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("nested.txt");
  });
});

describe("edit", () => {
  test("全文替换 + 改后产物上传", async () => {
    writeFileSync(join(workDir, "c.txt"), "a-b-a-b");
    const r = await ex.edit!({ path: "c.txt", old: "a", new: "X" }, mkCtx());
    expect(r.ok).toBe(true);
    expect(readFileSync(join(workDir, "c.txt"), "utf8")).toBe("X-b-X-b");
    expect(r.stdout).toContain("2 occurrence");
    expect(r.artifacts).toHaveLength(1);
  });
  test("old 未找到 → ok:false 不落盘", async () => {
    writeFileSync(join(workDir, "d.txt"), "keep");
    const r = await ex.edit!({ path: "d.txt", old: "zzz", new: "y" }, mkCtx());
    expect(r.ok).toBe(false);
    expect(readFileSync(join(workDir, "d.txt"), "utf8")).toBe("keep"); // 未被改动
  });
});

describe("ToolDispatcher（分派层）", () => {
  const frame = (over: Partial<ToolCallFrame>): ToolCallFrame => ({ type: "tool_call", id: "t1", tool: "bash", args: { command: "echo hi" }, schema: null as never, runId: "r_x", ...over });

  test("已注册工具 → 执行并回 tool_result（stdout 带回来）", async () => {
    const d = mkDispatcher();
    await d.handle(frame({}));
    expect(sentFrames).toHaveLength(1);
    const m = sentFrames[0];
    expect(m.type).toBe("tool_result");
    expect(m.id).toBe("t1");
    expect(m.ok).toBe(true);
    expect(m.stdout).toContain("hi");
  });
  test("write → 产物经 upload 上传 + artifacts 带服务器相对路径", async () => {
    const d = mkDispatcher();
    await d.handle(frame({ tool: "write", args: { path: "o.txt", content: "body" } }));
    const m = sentFrames[0];
    expect(m.ok).toBe(true);
    expect(m.artifacts).toEqual([{ name: "o.txt", path: "runs/r_x/o.txt", size: 1 }]);
  });
  test("未知工具 → ok:false unknown_tool（不断连）", async () => {
    const d = mkDispatcher();
    await d.handle(frame({ tool: "no_such" }));
    const m = sentFrames[0];
    expect(m.ok).toBe(false);
    expect(m.code).toBe("unknown_tool");
  });
  test("执行器抛异常 → 兜底 ok:false（真实原因入 error）", async () => {
    const d = mkDispatcher({ boom: async () => { throw new Error("kaboom"); } });
    await d.handle(frame({ tool: "boom" }));
    const m = sentFrames[0];
    expect(m.ok).toBe(false);
    expect(m.error).toBe("kaboom");
  });
  test("每 run 独立工作区解析（同连接多 run 并发分仓）", async () => {
    const d = mkDispatcher(ex, (runId) => join(workDir, runId));
    await d.handle(frame({ id: "t-a", runId: "r_a", tool: "write", args: { path: "f.txt", content: "a" } }));
    await d.handle(frame({ id: "t-b", runId: "r_b", tool: "write", args: { path: "f.txt", content: "b" } }));
    expect(readFileSync(join(workDir, "r_a", "f.txt"), "utf8")).toBe("a");
    expect(readFileSync(join(workDir, "r_b", "f.txt"), "utf8")).toBe("b");
    // 两帧各按自己 runId 上传（分派层假 upload 用 runId 拼服务器相对路径）
    expect(sentFrames.map((m) => m.artifacts)).toEqual([
      [{ name: "f.txt", path: "runs/r_a/f.txt", size: 1 }],
      [{ name: "f.txt", path: "runs/r_b/f.txt", size: 1 }],
    ]);
  });
});