// ws-protocol 冒烟：可序列化 schema 校验 + 帧判别（客户端与服务端共享的语法保底）。
// 线协议行为契约锚在 hyper-workflow 的 r2–r5 seam 测试（此处不重复测服务端行为）。
import { describe, expect, test } from "bun:test";
import { schema, validate, isServerMessage, isClientMessage } from "../src/index";

describe("schema 校验（跨进程序列化语义）", () => {
  test("object 必填/可选/嵌套", () => {
    const s = schema.object({
      command: schema.string(),
      cwd: schema.optional(schema.string()),
    });
    expect(validate(s, { command: "pwd" }).ok).toBe(true);
    expect(validate(s, { command: "pwd", cwd: "/tmp" }).ok).toBe(true);
    expect(validate(s, {}).ok).toBe(false);
    expect(validate(s, { command: 42 })).toEqual({ ok: false, error: "root.command: expected string" });
  });
  test("enum 与 array", () => {
    const s = schema.array(schema.enum("a", "b"));
    expect(validate(s, ["a", "b"]).ok).toBe(true);
    expect(validate(s, ["x"]).ok).toBe(false);
  });
});

describe("线帧判别", () => {
  test("server→device 与 device→server 各三/四型", () => {
    expect(isServerMessage({ type: "pong" })).toBe(true);
    expect(isServerMessage({ type: "tool_call", id: "t1", tool: "bash", args: {}, schema: schema.any(), runId: "r1" })).toBe(true);
    expect(isServerMessage({ type: "check_environment", id: "e1", requirements: [] })).toBe(true);
    expect(isServerMessage({ type: "tool_result", id: "t1", ok: true })).toBe(false); // 反方向

    expect(isClientMessage({ type: "ping" })).toBe(true);
    expect(isClientMessage({ type: "tool_result", id: "t1", ok: true, stdout: "x" })).toBe(true);
    expect(isClientMessage({ type: "env_report", id: "e1", result: { status: "pass", table: [] } })).toBe(true);
    expect(isClientMessage({ type: "env_remediated", pendingStartId: "p1", approved: true })).toBe(true);
    expect(isClientMessage({ type: "tool_call", id: "t1", tool: "x", args: {}, schema: schema.any(), runId: "r1" })).toBe(false);
  });
  test("非协议帧/垃圾 → false", () => {
    expect(isClientMessage(null)).toBe(false);
    expect(isServerMessage({ type: "garbage" })).toBe(false);
    expect(isClientMessage("nope")).toBe(false);
  });
});