// browser 六工具单测（headless，fake CDP 端点）：Bun HTTP(/json/*) + WS(CDP) 假服务器承载
// ChromeBackend 的 attach 面（AGENTANY_BROWSER_ENDPOINT）。断言反检测契约：
// 不发 Runtime.enable（evaluate 走 isolated world）、cookie CDP 方法黑名单、
// 点击前必有插值 move 轨迹、启动 flag 契约（无 --enable-automation、headless 仅显式）、artifact 本地落盘。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChromeArgs, ChromeBackend } from "../src/browser/backend";
import { CdpConnection } from "../src/browser/cdp";
import { genMovePath } from "../src/browser/core";
import { browserHandlers, resetBrowserForTests } from "../src/browser/executors";
import type { ExecContext } from "../src/executor-types";

// 4 字节 JPEG 头（ffd8ffe0）——screenshot 落盘 magic 断言用
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");

interface FakePage { id: string; title: string; url: string }

/** 假 CDP 服务器：/json/* HTTP 面 + /devtools/page/<id> WS 面；记录每页收到的 CDP 方法序列。 */
function startFake() {
  const pages: FakePage[] = [{ id: "p1", title: "Fake Title", url: "about:blank" }];
  const sent = new Map<string, string[]>(); // pageId → 方法序列（按到达顺序）
  const record = (pageId: string, method: string): void => {
    const list = sent.get(pageId) ?? [];
    list.push(method);
    sent.set(pageId, list);
  };
  let seq = 0;

  const server = Bun.serve({
    port: 0,
    fetch(req, s) {
      const u = new URL(req.url);
      const origin = u.origin;
      const pub = (p: FakePage) => ({
        id: p.id, type: "page", title: p.title, url: p.url,
        webSocketDebuggerUrl: `${origin}/devtools/page/${p.id}`,
      });
      if (u.pathname === "/json/version") {
        return Response.json({ Browser: "fake-chrome/150", webSocketDebuggerUrl: `${origin}/devtools/browser/b1` });
      }
      if (u.pathname === "/json/list") return Response.json(pages.map(pub));
      if (u.pathname === "/json/new" || u.pathname.startsWith("/json/new?")) {
        const p: FakePage = { id: `n${++seq}`, title: "New Tab", url: new URL(req.url).searchParams.get("url") ?? "about:blank" };
        pages.push(p);
        return Response.json(pub(p));
      }
      const close = u.pathname.match(/^\/json\/close\/(.+)$/);
      if (close) {
        const i = pages.findIndex((p) => p.id === close[1]);
        if (i >= 0) pages.splice(i, 1);
        return new Response("Target is closing");
      }
      const act = u.pathname.match(/^\/json\/activate\/(.+)$/);
      if (act) return new Response("Target activated");
      const page = u.pathname.match(/^\/devtools\/page\/(.+)$/);
      if (page && s.upgrade(req, { data: { pageId: page[1] } })) return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const req = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> };
        const pageId = (ws.data as { pageId: string }).pageId;
        record(pageId, req.method);
        const reply = (result: unknown): void => ws.send(JSON.stringify({ id: req.id, result }));
        const emit = (method: string, params: unknown): void => ws.send(JSON.stringify({ method, params }));
        switch (req.method) {
          case "Page.enable":
          case "Input.dispatchMouseEvent":
          case "Input.dispatchKeyEvent":
            reply({});
            break;
          case "Page.navigate":
            reply({ frameId: "f1", loaderId: "l1" });
            setTimeout(() => emit("Page.loadEventFired", { frameId: "f1" }), 10);
            break;
          case "Page.getFrameTree":
            reply({ frameTree: { frame: { id: "f1", url: "about:blank" } } });
            break;
          case "Page.createIsolatedWorld":
            reply({ executionContextId: 42 });
            break;
          case "Runtime.evaluate":
            reply({ result: { type: "string", value: `eval:${String(req.params?.expression ?? "")}` } });
            break;
          case "Page.captureScreenshot":
            reply({ data: TINY_JPEG });
            break;
          case "Runtime.enable":
            reply({}); // 若被发送会被记录，测试断言其缺席（反检测契约）
            break;
          default:
            ws.send(JSON.stringify({ id: req.id, error: { code: -32601, message: `no ${req.method}` } }));
        }
      },
    },
  });
  const origin = server.url.href.replace(/\/$/, ""); // Bun.serve().url 是 URL 实例
  return { server, pages, sent, origin };
}

let fake: ReturnType<typeof startFake>;
let workDir: string;
let uploads: { name: string; path: string }[];
let handlers: ReturnType<typeof browserHandlers>;

const mkCtx = (): ExecContext => ({
  workDir,
  upload: async (f) => {
    uploads.push(f);
    return { path: `runs/r_b/${f.name}`, name: f.name, size: 1 };
  },
});

beforeEach(() => {
  fake = startFake();
  process.env.AGENTANY_BROWSER_ENDPOINT = fake.origin;
  resetBrowserForTests(); // core 单例 + 后端一起重置（core 会绑死首个 httpBase，跨测试必须换绑）
  workDir = mkdtempSync(join(tmpdir(), "br-ws-"));
  uploads = [];
  handlers = browserHandlers();
});
afterEach(() => {
  resetBrowserForTests();
  delete process.env.AGENTANY_BROWSER_ENDPOINT;
  fake.server.stop(true);
});

describe("启动契约（buildChromeArgs 纯函数）", () => {
  test("专用 user-data-dir + debugging 端口；默认无 --enable-automation、无 headless", () => {
    const args = buildChromeArgs("/tmp/agentany-profile", 9333);
    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--user-data-dir=/tmp/agentany-profile");
    expect(args.some((a) => a.startsWith("--enable-automation"))).toBe(false);
    expect(args.some((a) => a.startsWith("--headless"))).toBe(false);
  });
  test("headless 仅显式开启（--headless=new，CI/测试用）", () => {
    const args = buildChromeArgs("/tmp/p", 1, { headless: true });
    expect(args).toContain("--headless=new");
  });
});

describe("attach 模式（AGENTANY_BROWSER_ENDPOINT，跳过自启）", () => {
  test("acquire 返回假端点 origin", async () => {
    const ep = await ChromeBackend.acquire();
    expect(ep.httpBase).toBe(fake.origin);
  });
});

test("轨迹生成：贝塞尔插值——首尾精确、步数有界、点在包围盒内", () => {
  const path = genMovePath({ x: 0, y: 0 }, { x: 300, y: 200 });
  expect(path.length).toBeGreaterThanOrEqual(6);
  expect(path.length).toBeLessThanOrEqual(24);
  expect(path[0]).toEqual({ x: 0, y: 0 });
  expect(path[path.length - 1]).toEqual({ x: 300, y: 200 });
  for (const p of path) {
    expect(p.x).toBeGreaterThanOrEqual(-60); // 控制点垂直偏移容差
    expect(p.x).toBeLessThanOrEqual(360);
    expect(p.y).toBeGreaterThanOrEqual(-40);
    expect(p.y).toBeLessThanOrEqual(240);
  }
});

test("tabs：list 列出页面 → new 开新页（成为活动页）→ close 关闭", async () => {
  const list = await handlers["browser.tabs"]({}, mkCtx());
  expect(list.ok).toBe(true);
  expect(list.stdout).toContain("tabs: 1");
  expect(list.stdout).toContain("Fake Title");
  const created = await handlers["browser.tabs"]({ action: "new", url: "https://example.com/" }, mkCtx());
  expect(created.ok).toBe(true);
  expect(created.stdout).toContain("n1");
  const listed = await handlers["browser.tabs"]({}, mkCtx());
  expect(listed.stdout).toContain("tabs: 2");
  const closed = await handlers["browser.tabs"]({ action: "close", tab_id: "n1" }, mkCtx());
  expect(closed.ok).toBe(true);
  const fin = await handlers["browser.tabs"]({}, mkCtx());
  expect(fin.stdout).toContain("tabs: 1");
});

test("navigate：默认落到活动页，等待 loadEventFired，stdout 带标题；evaluate 卫生——无 Runtime.enable、走 isolated world", async () => {
  const nav = await handlers["browser.navigate"]({ url: "https://example.com/" }, mkCtx());
  expect(nav.ok).toBe(true);
  expect(nav.stdout).toContain("https://example.com/");
  const ev = await handlers["browser.evaluate"]({ expression: "document.title" }, mkCtx());
  expect(ev.ok).toBe(true);
  expect(ev.stdout).toContain("eval:document.title");
  const methods = fake.sent.get("p1") ?? [];
  expect(methods).not.toContain("Runtime.enable"); // 反检测契约：Runtime domain 永不 enable
  expect(methods).toContain("Page.createIsolatedWorld");
  expect(methods).toContain("Runtime.evaluate");
});

test("click：按下前必有插值 move 轨迹（≥6 个 mouseMoved），press→release 成对", async () => {
  await handlers["browser.navigate"]({ url: "https://example.com/" }, mkCtx());
  const r = await handlers["browser.click"]({ x: 120, y: 80 }, mkCtx());
  expect(r.ok).toBe(true);
  const seq = (fake.sent.get("p1") ?? []).filter((m) => m === "Input.dispatchMouseEvent");
  expect(seq.filter(() => true).length).toBeGreaterThanOrEqual(8); // moved ≥6 + press + release
  expect(r.stdout).toContain("(120, 80)");
});

test("type：逐字符 keyDown(text)+keyUp；换行映射 Enter(vk 13)", async () => {
  await handlers["browser.navigate"]({ url: "https://example.com/" }, mkCtx());
  const r = await handlers["browser.type"]({ text: "hi\n" }, mkCtx());
  expect(r.ok).toBe(true);
  expect(fake.sent.get("p1")).toContain("Input.dispatchKeyEvent");
  expect(r.stdout).toContain("3 chars");
});

test("screenshot：Page.captureScreenshot(jpeg) → 本地 artifact（dispatcher 上传约定）", async () => {
  await handlers["browser.navigate"]({ url: "https://example.com/" }, mkCtx());
  const r = await handlers["browser.screenshot"]({}, mkCtx());
  expect(r.ok).toBe(true);
  expect(r.artifacts).toHaveLength(1);
  const abs = r.artifacts![0].path;
  expect(abs.startsWith(workDir)).toBe(true);
  expect(existsSync(abs)).toBe(true);
  expect(readFileSync(abs).subarray(0, 3).toString("hex")).toBe("ffd8ff"); // 真 JPEG magic
});

test("CDP 黑名单：cookie 读取/清除方法直接拒绝（登录态不出设备）", async () => {
  const wsUrl = `${fake.origin}/devtools/page/p1`;
  const conn = new CdpConnection(wsUrl);
  await conn.open();
  expect(conn.send("Network.getAllCookies")).rejects.toThrow("禁止");
  expect(conn.send("Storage.getCookies")).rejects.toThrow("禁止");
  await conn.send("Page.enable"); // 非 黑名单方法正常
  conn.close();
});

test("tab_id 显式寻址 + 不存在时报 invalid_args", async () => {
  const r = await handlers["browser.evaluate"]({ expression: "1+1", tab_id: "n1" }, mkCtx());
  expect(r.ok).toBe(false);
  expect(r.code).toBe("invalid_args");
});
