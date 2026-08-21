// host 侧车入口（生产）：stdin/stdout JSON lines ⇄ createHost。
// 日志一律走 stderr——stdout 是协议通道（壳逐行解析）。执行器全家（五件套 + computer-use + browser）。
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { allExecutors } from "@agentany/device-core";
import { createHost, type HostOut } from "./ipc";

const root = join(homedir(), ".agentany");
const host = createHost({
  configDir: root,
  grantsDir: root,
  handlers: allExecutors(),
  onCommandLine: (cb) => {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (l) => cb(l));
    return () => rl.close();
  },
  emit: (msg: HostOut) => process.stdout.write(`${JSON.stringify(msg)}\n`),
});

process.on("SIGTERM", () => host.stop());
