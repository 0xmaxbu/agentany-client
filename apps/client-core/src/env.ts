// 设备环境链路（R-6 P5b / ADR-0038 / PRD US 4-6）：check_environment 本机探测 → env_report；
// env_pending（挂起补全请求）→ onConsent 同意/拒绝 → 同意则本地跑 autoInstall → env_remediated。
// 可信性：服务端不采信设备声称的 status（从 table 逐项重派）；env_remediated 后服务端复检定真相
// ——本层只如实报原始结果/执行补全，不做汇总决策。探测/安装是机器级命令，与 run 工作区无关。
import type { CheckEnvironmentFrame, DeviceClientMessage, EnvCheckItem, EnvCheckStatus, EnvPendingFrame } from "@agentany/ws-protocol";
import type { ConsentGate } from "./consent";

/** 命令执行结果（与 bash 执行器同形）。 */
export interface EnvCommandResult {
  ok: boolean;
  code?: number;
  stdout?: string;
  stderr?: string;
}

/** bash -lc 本机执行（缺省；测试注入假实现）。cwd 继承进程——探测/安装命令不依赖 run 工作区。 */
export async function runEnvCommand(command: string): Promise<EnvCommandResult> {
  const p = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = (await p.exited) ?? -1;
  return { ok: code === 0, code, stdout, stderr };
}

export interface EnvHandlerOpts {
  send(msg: DeviceClientMessage): void;
  consent: ConsentGate;
  /** 命令执行（缺省 bash -lc 本机；测试注入）。 */
  runCommand?(command: string): Promise<EnvCommandResult>;
}

export class DeviceEnvHandler {
  constructor(private readonly o: EnvHandlerOpts) {}

  private get run(): NonNullable<EnvHandlerOpts["runCommand"]> {
    return this.o.runCommand ?? runEnvCommand;
  }

  /** check_environment → 逐项本机探测 → env_report（status 仅提示值，服务端重派真值）。 */
  async onCheckEnvironment(frame: CheckEnvironmentFrame): Promise<void> {
    const table: EnvCheckItem[] = [];
    for (const rq of frame.requirements) {
      const r = await this.run(rq.check);
      const reasonText = (r.stderr?.trim() || r.stdout?.trim() || `exit ${r.code ?? -1}`).slice(0, 200);
      table.push({ id: rq.id, name: rq.name, ok: r.ok, reason: r.ok ? undefined : reasonText || undefined, autoInstallable: rq.autoInstall !== null });
    }
    this.o.send({ type: "env_report", id: frame.id, result: { status: hintOf(table), table } });
  }

  /** env_pending → onConsent（60s 超时=拒绝）→ 同意：逐项本地跑 autoInstall → env_remediated。
   * 安装结果不回传（协议无此负载）——服务端复检 check_environment 定真相。 */
  async onEnvPending(frame: EnvPendingFrame): Promise<void> {
    const approved = await this.o.consent.checkEnv({ pendingStartId: frame.pendingStartId, workflowId: frame.workflowId, items: frame.items });
    if (approved) {
      for (const it of frame.items) {
        if (it.autoInstall) await this.run(it.autoInstall); // 防御 null（服务端只推缺失可补全项）
      }
    }
    this.o.send({ type: "env_remediated", pendingStartId: frame.pendingStartId, approved });
  }
}

/** 提示值（与服务端 reportStatusOf 同式；服务端不采信，仅展示参考）。 */
const hintOf = (table: EnvCheckItem[]): EnvCheckStatus =>
  table.some((t) => !t.ok && !t.autoInstallable) ? "fail_hard" : table.some((t) => !t.ok) ? "fail_installable" : "pass";
