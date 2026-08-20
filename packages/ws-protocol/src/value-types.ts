// 设备协议随帧下发的值类型（ADR-0034 D2 单一真相）：env 检测 / 工具结果两类负载的字段形状。
// 服务端内部派生（如 EnvReportResult.deviceId = 服务端从连接补充）不进协议，留在服务端。

/** 设备环境要求（ADR-0033/R-1）：设备侧 shell 探测 + 可自动补全。 */
export interface EnvRequirement {
  id: string;
  name: string;
  check: string; // 设备上 shell 探测命令（exit 0=通过 / stdout 匹配约定）
  autoInstall: string | null; // 有值=软件因素可自动补全；null=硬失败
  hint?: string;
}

/** env_report.result.table 逐项（设备探测结果；status 由服务端从逐项派生，不采信设备声称）。 */
export interface EnvCheckItem {
  id: string;
  name: string;
  ok: boolean;
  reason?: string;
  autoInstallable: boolean;
}

export type EnvCheckStatus = "pass" | "fail_hard" | "fail_installable";

/** 工具产物条目（上传后 run 工作区内相对路径，可预览/下载）。 */
export interface ToolArtifact {
  name: string;
  size?: number;
  path?: string; // 上传后 run 工作区内相对路径
}

/** tool_result 负载（桥 → pi stub 的结构化结果即此形状）。 */
export interface ToolCallResult {
  ok: boolean;
  code?: string | number;
  stdout?: string;
  stderr?: string;
  artifacts?: ToolArtifact[];
  error?: string;
}