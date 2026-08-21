// ChromeBackend（参考实现，三平台统一；ADR-0035 2026-08-21 修订——放弃 ego）：定位浏览器二进制 →
// 自启（专用非默认 user-data-dir + --remote-debugging-port）或 attach（AGENTANY_BROWSER_ENDPOINT
// 指向已在跑的 Chrome——测试与高级用户用）。平台差异仅"找二进制"这一处，其余姿态全在 core。
//
// 反检测启动契约（issue #5）：
// - Chrome 136 起默认用户目录禁 remote-debugging（官方安全收紧）→ 必须专用目录，顺带承载持久登录态；
// - 无 --enable-automation（navigator.webdriver 保持 false）；生产有头，--headless=new 仅显式（CI/测试）。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ],
};

/** 找浏览器二进制：env AGENTANY_BROWSER_BIN → 平台候选。 */
export function findBrowserBinary(): string | undefined {
  const env = process.env.AGENTANY_BROWSER_BIN;
  if (env) return env;
  for (const p of CANDIDATES[process.platform] ?? []) if (existsSync(p)) return p;
  return undefined;
}

/** 启动参数契约（纯函数，单测直断言）。 */
export function buildChromeArgs(profileDir: string, port: number, o: { headless?: boolean } = {}): string[] {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`, // 非默认目录（Chrome 136+ 要求）+ 持久登录态载体
    "--no-first-run",
    "--no-default-browser-check",
    // 刻意不加 --enable-automation（反检测：navigator.webdriver 保持 false）；生产有头，headless 仅显式
  ];
  if (o.headless) args.push("--headless=new");
  return args;
}

export interface BrowserEndpoint { httpBase: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 浏览器后端单例：attach（env）优先，否则自启；生命周期随进程。 */
export class ChromeBackend {
  private static inst: BrowserEndpoint | null = null;
  private static child: ReturnType<typeof spawn> | null = null;

  static async acquire(): Promise<BrowserEndpoint> {
    if (this.inst) return this.inst;
    const attach = process.env.AGENTANY_BROWSER_ENDPOINT;
    if (attach) {
      this.inst = { httpBase: attach.replace(/\/+$/, "") };
      return this.inst;
    }
    const bin = findBrowserBinary();
    if (!bin) throw new Error("未找到 Chrome/Chromium/Edge 二进制（设 AGENTANY_BROWSER_BIN 指定）");
    const profileDir = process.env.AGENTANY_BROWSER_PROFILE ?? join(homedir(), ".agentany", "browser", "profile");
    mkdirSync(profileDir, { recursive: true });
    const headless = process.env.AGENTANY_BROWSER_HEADLESS === "1";
    let lastTry = "";
    for (let i = 0; i < 5; i++) {
      const port = 20_000 + Math.floor(Math.random() * 20_000);
      const child = spawn(bin, buildChromeArgs(profileDir, port, { headless }), { stdio: "ignore" });
      let dead = false;
      child.once("exit", () => { dead = true; });
      child.once("error", () => { dead = true; });
      const httpBase = `http://127.0.0.1:${port}`;
      lastTry = httpBase;
      if (await waitHealthy(httpBase, () => dead, 8_000)) {
        this.child = child;
        this.inst = { httpBase };
        return this.inst;
      }
      child.kill();
    }
    throw new Error(`Chrome 启动失败（5 次尝试，最后 ${lastTry}）`);
  }

  /** 测试隔离：杀自启进程、清端点。 */
  static resetForTests(): void {
    this.child?.kill();
    this.child = null;
    this.inst = null;
  }
}

async function waitHealthy(httpBase: string, dead: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (dead()) return false;
    try {
      const r = await fetch(`${httpBase}/json/version`);
      if (r.ok) return true;
    } catch { /* 未就绪，继续轮询 */ }
    await sleep(120);
  }
  return false;
}
