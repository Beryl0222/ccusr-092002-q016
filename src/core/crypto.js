import { webcrypto as crypto } from "node:crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function sha256Hex(input) {
  const data = typeof input === "string" ? enc.encode(input) : input;
  return crypto.subtle.digest("SHA-256", data).then((buf) =>
    Buffer.from(buf).toString("hex")
  );
}

export async function sha8(input) {
  return (await sha256Hex(input)).slice(0, 8);
}

/** 以确定方式规范化 JSON：对象键递归排序，保证同内容同字节。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export async function hashJson(value) {
  return sha256Hex(canonicalJson(value));
}

export function randomBytes(length = 16) {
  const buf = Buffer.alloc(length);
  crypto.getRandomValues(buf);
  return buf;
}

export async function randomId(prefix, length = 16) {
  return `${prefix}-${randomBytes(length).toString("hex")}`;
}

export async function randomToken(length = 24) {
  return randomBytes(length).toString("base64url");
}

export async function generateSigningKeyPair() {
  return crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
}

export async function exportJwk(key) {
  return crypto.subtle.exportKey("jwk", key);
}

export async function importPublicJwk(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "Ed25519" },
    false,
    ["verify"]
  );
}

export async function importPrivateJwk(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "Ed25519" },
    false,
    ["sign"]
  );
}

export async function signDetached(privateJwk, message) {
  const key = await importPrivateJwk(privateJwk);
  const sig = await crypto.subtle.sign(
    "Ed25519",
    key,
    typeof message === "string" ? enc.encode(message) : message
  );
  return Buffer.from(sig).toString("base64url");
}

export async function verifyDetached(publicJwk, signatureB64, message) {
  const key = await importPublicJwk(publicJwk);
  let sig;
  try {
    sig = Buffer.from(signatureB64, "base64url");
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      sig,
      typeof message === "string" ? enc.encode(message) : message
    );
  } catch {
    return false;
  }
}

export function toBase64Url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export { enc, dec };
