// 最小手搓 schema（spike-b 验过，17/17）。**可 JSON 序列化**——跨进程/跨设备传递（
// tool_call 的 argsSchema、resumeSchema 均要存/传），故不用 zod（不可序列化）。类型真相源
// 在本包（ADR-0034 D2）：hyper-workflow 服务端经 re-export 继续消费；设备客户端用它校验 tool_call.args。
export interface Schema {
  _t: string;
  [k: string]: unknown;
}

export const schema = {
  any: (): Schema => ({ _t: "any" }),
  string: (): Schema => ({ _t: "string" }),
  number: (): Schema => ({ _t: "number" }),
  boolean: (): Schema => ({ _t: "boolean" }),
  enum: (...vals: unknown[]): Schema => ({ _t: "enum", vals }),
  /** 可接受任意字面值的 schema（显式卡片选项的 resumeSchema：value 即 resumeData；复用 enum 的 includes 判定）。 */
  values: (...vals: unknown[]): Schema => ({ _t: "enum", vals }),
  optional: (inner: Schema): Schema => ({ _t: "optional", inner }),
  array: (inner: Schema): Schema => ({ _t: "array", inner }),
  object: (shape: Record<string, Schema>): Schema => ({ _t: "object", shape }),
};

export type ValidateResult = { ok: true } | { ok: false; error: string };

export function validate(s: Schema | undefined, data: unknown, path = "root"): ValidateResult {
  if (!s) return { ok: true };
  switch (s._t) {
    case "any":
      return { ok: true };
    case "optional":
      return data === undefined ? { ok: true } : validate(s.inner as Schema, data, path);
    case "string":
      return typeof data === "string" ? { ok: true } : { ok: false, error: `${path}: expected string` };
    case "number":
      return typeof data === "number" ? { ok: true } : { ok: false, error: `${path}: expected number` };
    case "boolean":
      return typeof data === "boolean" ? { ok: true } : { ok: false, error: `${path}: expected boolean` };
    case "enum":
      return (s.vals as unknown[]).includes(data) ? { ok: true } : { ok: false, error: `${path}: expected one of ${JSON.stringify(s.vals)}` };
    case "array": {
      if (!Array.isArray(data)) return { ok: false, error: `${path}: expected array` };
      for (let i = 0; i < data.length; i++) {
        const r = validate(s.inner as Schema, data[i], `${path}[${i}]`);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case "object": {
      if (typeof data !== "object" || data === null) return { ok: false, error: `${path}: expected object` };
      const shape = s.shape as Record<string, Schema>;
      for (const [k, child] of Object.entries(shape)) {
        if (!(k in data) && child._t !== "optional") return { ok: false, error: `${path}.${k}: missing` };
        if (k in data) {
          const r = validate(child, (data as Record<string, unknown>)[k], `${path}.${k}`);
          if (!r.ok) return r;
        }
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: `${path}: unknown schema type ${s._t}` };
  }
}