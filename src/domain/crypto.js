import {
  createHash,
  randomBytes,
  generateKeyPairSync,
  sign as oneShotSign,
  verify as oneShotVerify,
} from "node:crypto";

/**
 * 确定性 JSON 序列化：键排序，保证哈希与签名跨进程稳定。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function sha256(value) {
  const body = typeof value === "string" ? value : stableStringify(value);
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

export function shortId(prefix) {
  return `${prefix}${randomBytes(8).toString("hex")}`;
}

export function fingerprintLogs(logs) {
  return sha256(Array.isArray(logs) ? logs : []);
}

export function generateAuthorityKeyPair() {
  return generateKeyPairSync("ed25519");
}

export function exportPublicKey(keyObject) {
  return keyObject.export({ type: "spki", format: "pem" });
}

export function exportPrivateKey(keyObject) {
  return keyObject.export({ type: "pkcs8", format: "pem" });
}

/**
 * 医院对提交声明做分离签名；签名对象只含业务字段，不含签名本身。
 * Ed25519 使用纯 EdDSA（algorithm=null，不外接摘要算法）。
 */
export function signSubmission(privateKeyPem, claim) {
  return oneShotSign(null, Buffer.from(stableStringify(claim), "utf8"), privateKeyPem).toString("hex");
}

export function verifySubmissionSignature(publicKeyPem, claim, signatureHex) {
  try {
    return oneShotVerify(
      null,
      Buffer.from(stableStringify(claim), "utf8"),
      publicKeyPem,
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    return false;
  }
}

/** 经办机构对密封对象（测试包、证书）签名。 */
export function signWithAuthority(privateKey, payload) {
  return oneShotSign(null, Buffer.from(stableStringify(payload), "utf8"), privateKey).toString("hex");
}

export function verifyWithAuthority(publicKey, payload, signatureHex) {
  try {
    return oneShotVerify(
      null,
      Buffer.from(stableStringify(payload), "utf8"),
      publicKey,
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    return false;
  }
}
