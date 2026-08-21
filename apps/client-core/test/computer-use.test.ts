// computer-use 执行器单测（headless，假桥）：screens/observe/act 协议、软 stateId 过期提示、
// 截图 artifact 上传、ref 定位不需视野、缺 observe 报 need_observe、桥缺失结构化失败。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allExecutors } from "../src/computer-use";
import { BridgeClient } from "../src/computer-use";
import type { ExecContext } from "../src/executor-types";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let fakeBin: string;
let workDir: string;
let uploads: { name: string; path: string; runId: string }[];
let ex: ReturnType<typeof allExecutors>;

const mkCtx = (): ExecContext => ({
  workDir,
  upload: async (f) => {
    uploads.push({ ...f, runId: "r_cu" });
    return { path: `runs/r_cu/${f.name}`, name: f.name, size: 1 };
  },
});

beforeEach(async () => {
  fakeBin = join(mkdtempSync(join(tmpdir(), "cu-fake-")), "fake-cu.js");
  writeFileSync(fakeBin, `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const PNG = ${JSON.stringify(TINY_PNG)};
rl.on("line", (line) => {
  const req = JSON.parse(line);
  let resp;
  if (req.cmd === "screens") resp = { ok: true, displays: [{ id: "00000002", x: 0, y: 0, width: 1920, height: 1080, scale: 1, phys_w: 1920, phys_h: 1080 }], windows: [{ id: "1", owner: "TestApp", title: "fake window", w: 100, h: 80, x: 0, y: 0, focused: true }] };
  else if (req.cmd === "observe") resp = { ok: true, mode: req.mode, target: "display", target_id: "00000002", image_w: 1024, image_h: 576, phys_w: 1920, phys_h: 1080, pt: { x: 0, y: 0, w: 1920, h: 1080 }, png_base64: PNG, outline: req.mode === "visual+ax" ? { ref: "e1", role: "AXWindow" } : undefined };
  else if (req.cmd === "act") resp = { ok: true, action: { type: req.action.type, saw_ref: req.ref ?? null }, png_base64: PNG };
  else resp = { ok: false, error: "unknown cmd", code: "unknown_cmd" };
  resp.id = req.id;
  process.stdout.write(JSON.stringify(resp) + "\\n");
});`);
  process.env.AGENTANY_CU_BIN = fakeBin;
  chmodSync(fakeBin, 0o755);
  BridgeClient.resetForTests();
  workDir = mkdtempSync(join(tmpdir(), "cu-ws-"));
  uploads = [];
  ex = allExecutors();
});
afterEach(() => {
  delete process.env.AGENTANY_CU_BIN;
  BridgeClient.resetForTests();
});

test("screens：列出显示器与窗口（LLM 可读文本）", async () => {
  const r = await ex["computer_use.screens"]({}, mkCtx());
  expect(r.ok).toBe(true);
  expect(r.stdout).toContain("displays: 1");
  expect(r.stdout).toContain("fake window");
  expect(r.stdout).toContain("00000002");
});

test("observe visual：截图落工作区 + artifact 返回（本地绝对路径交 dispatcher 上传）+ stateId 报出", async () => {
  const r = await ex["computer_use.observe"]({ mode: "visual" }, mkCtx());
  expect(r.ok).toBe(true);
  expect(r.stdout).toContain("stateId 1");
  expect(r.stdout).toContain("image 1024x576");
  expect(r.artifacts).toHaveLength(1);
  // 截图真实落盘（PNG magic）；路径为本地绝对路径（dispatcher 据此回传）
  const abs = r.artifacts![0].path;
  expect(abs.startsWith(workDir)).toBe(true);
  expect(existsSync(abs)).toBe(true);
  expect(readFileSync(abs).subarray(0, 4).toString("hex")).toBe("89504e47");
});

test("observe visual+ax：outline 标注出现在 stdout", async () => {
  const r = await ex["computer_use.observe"]({ mode: "visual+ax" }, mkCtx());
  expect(r.ok).toBe(true);
  expect(r.stdout).toContain("AX outline");
});

test("act move：先 observe 拿视野 → 坐标动作 + 后置截图 artifact；stateId 递增", async () => {
  const obs = await ex["computer_use.observe"]({}, mkCtx());
  expect(obs.stdout).toContain("stateId 1");
  const r = await ex["computer_use.act"]({ action: { type: "move" }, x: 100, y: 50, state_id: 1 }, mkCtx());
  expect(r.ok).toBe(true);
  expect(r.stdout).toContain("新 stateId 2");
  expect(r.stdout).not.toContain("过期"); // stateId 1 紧跟 observe → 不过期
  expect(r.artifacts).toHaveLength(1); // 后置截图 artifact
});

test("act 软过期中止不了：stateId 过期 → 照常执行 + 仅提示", async () => {
  await ex["computer_use.observe"]({}, mkCtx()); // epoch 1
  await ex["computer_use.act"]({ action: { type: "move" }, x: 1, y: 1 }, mkCtx()); // epoch 2（隐含状态变化）
  const r = await ex["computer_use.act"]({ action: { type: "move" }, x: 2, y: 2, state_id: 1 }, mkCtx()); // 传旧 stateId 1
  expect(r.ok).toBe(true); // 软：不硬拒
  expect(r.stdout).toContain("过期");
});

test("act 未 observe：坐标目标缺视野 → need_observe；ref 目标可直用", async () => {
  const noView = await ex["computer_use.act"]({ action: { type: "click" }, x: 5, y: 5 }, mkCtx());
  expect(noView.ok).toBe(false);
  expect(noView.code).toBe("need_observe");
  const withRef = await ex["computer_use.act"]({ action: { type: "click" }, ref: "e3" }, mkCtx());
  expect(withRef.ok).toBe(true);
  expect(withRef.stdout).toContain("saw_ref\":\"e3"); // ref 原样转发给桥（动作经 AX 语义定位）
});

test("桥缺失：AGENTANY_CU_BIN 指向不存在 → 结构化失败（bridge_exited）", async () => {
  process.env.AGENTANY_CU_BIN = join(tmpdir(), "no-such-bridge-binary");
  BridgeClient.resetForTests();
  const fresh = allExecutors();
  const r = await fresh["computer_use.screens"]({}, mkCtx());
  expect(r.ok).toBe(false);
  expect(String(r.code)).toBe("bridge_exited");
});