import { randomToken } from "./crypto.js";

/**
 * 令牌注册表：令牌不承载业务，仅映射到调用身份。
 * - agency：经办机构（可发布、豁免、审查、修订、灰度评估）
 * - hospital：医院（仅能操作本机构登记/提交/证书/灰度上报）
 * 令牌哈希后落盘，明文仅在签发当次返回。
 */
export class TokenRegistry {
  constructor(store) {
    // 复用主存储 data.tokens: { tokenHash -> actor 元信息 }
    this.store = store;
  }

  async #ensure() {
    const d = this.store.read();
    if (!d.tokens) d.tokens = {};
  }

  async issue(actor) {
    await this.#ensure();
    const plain = await randomToken(24);
    const { sha256Hex } = await import("./crypto.js");
    const hash = await sha256Hex(plain);
    await this.store.mutate((d) => {
      d.tokens[hash] = { ...actor, issued_at: new Date().toISOString() };
    });
    return plain;
  }

  async resolve(plain) {
    if (!plain) return null;
    const { sha256Hex } = await import("./crypto.js");
    const hash = await sha256Hex(plain);
    const record = this.store.read().tokens?.[hash];
    if (!record) return null;
    const { role, subject, institution_id } = record;
    return { role, subject, institution_id };
  }

  hasAgencyToken() {
    return Object.values(this.store.read().tokens ?? {}).some(
      (t) => t.role === "agency"
    );
  }
}
