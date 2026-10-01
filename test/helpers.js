import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import {
  generateSigningKeyPair,
  exportJwk,
  signDetached,
  canonicalJson,
} from "../src/core/crypto.js";

export const AGENCY = { role: "agency", subject: "agency:officer-1" };
export const hospitalActor = (id) => ({
  role: "hospital",
  subject: `hospital:${id}`,
  institution_id: id,
});

let tick = 0;
export function tickClock() {
  tick += 1;
  return new Date(Date.UTC(2026, 8, 1) + tick * 1000).toISOString();
}

export async function makeApp() {
  const dir = await mkdtemp(join(tmpdir(), "cert-"));
  const app = await createApp({
    dataPath: join(dir, "state.json"),
    clock: tickClock,
  });
  return {
    app,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export async function freshKeyPair() {
  const pair = await generateSigningKeyPair();
  return {
    publicJwk: await exportJwk(pair.publicKey),
    privateJwk: await exportJwk(pair.privateKey),
  };
}

/** 依据封存用例构造全对答案；overrides 可按 case_id 替换输出。 */
export function answersFor(pkg, overrides = {}) {
  return pkg.cases.map((c) => ({
    case_id: c.case_id,
    output: overrides[c.case_id] ?? c.expected,
  }));
}

/** 用登记私钥对提交签名并调用 service.submit。 */
export async function signedSubmit(
  service,
  actor,
  reg,
  pkg,
  {
    answers,
    privateJwk,
    environment_fingerprint = reg.environment_fingerprint,
    log_fingerprint = "logfp-deadbeef",
  }
) {
  const signedBody = {
    registration_id: reg.registration_id,
    package_id: pkg.package_id,
    answers,
    log_fingerprint,
    environment_fingerprint,
  };
  const signature = await signDetached(privateJwk, canonicalJson(signedBody));
  return service.submit(actor, { ...signedBody, signature });
}

export async function registerAdapter(service, actor, { publicJwk, coordinates, version = "1.0.0", build = "build-aaa" }) {
  const { registration } = await service.registerAdapter(actor, {
    software_name: "HIS",
    software_version: version,
    build_hash: build,
    rule_set: { note: "demo rules" },
    covered_coordinates: coordinates,
    environment_fingerprint: "env-fp-001",
    isolated_environment: true,
    signing_public_jwk: publicJwk,
  });
  return registration;
}
