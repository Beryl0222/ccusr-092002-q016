import { readFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";

import { JsonStore } from "../src/domain/store.js";
import { CertificationService } from "../src/domain/certification.js";
import { sha256, stableStringify, signSubmission } from "../src/domain/crypto.js";

export async function loadCatalog() {
  const raw = await readFile(
    new URL("../contracts/catalog_mapping.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(raw);
}

export function makeClock(initial = "2026-09-15") {
  let current = initial;
  const clock = () => new Date(`${current}T08:00:00.000Z`);
  clock.set = (date) => {
    current = date;
  };
  return clock;
}

export function makeKeyPair() {
  return generateKeyPairSync("ed25519");
}

export function pemPair() {
  const pair = makeKeyPair();
  return {
    publicPem: pair.publicKey.export({ type: "spki", format: "pem" }),
    privatePem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

export async function newService(clock = makeClock()) {
  const catalog = await loadCatalog();
  const authorityKey = makeKeyPair();
  const store = new JsonStore(null);
  const service = new CertificationService({ catalog, authorityKey, store, clock });
  const authorityToken = service.createAuthorityToken();
  return { service, catalog, authorityKey, store, clock, authorityToken };
}

/** 由测试包期望构造一个“完全合规适配器”的逐例输出。 */
export function perfectResults(envelope, overrides = {}) {
  return envelope.body.cases.map((c) => {
    if (overrides[c.case_id]) return { case_id: c.case_id, output: overrides[c.case_id] };
    const want = c.expected;
    if (want.accepted) {
      return {
        case_id: c.case_id,
        output: { accepted: true, province_codes: [...(want.expected_province_codes ?? [])] },
      };
    }
    return { case_id: c.case_id, output: { accepted: false, reason: want.reason } };
  });
}

/** 为提交构造并签署声明。 */
export function signedSubmission({
  hospitalPrivatePem,
  orgId,
  registration,
  envelope,
  results,
  logFingerprint = "sha256:logs",
  envFingerprint,
  submittedAt = "2026-09-15T08:00:00Z",
}) {
  const claim = {
    org_id: orgId,
    registration_id: registration.registration_id,
    package_id: envelope.package_id,
    package_hash: envelope.package_hash,
    software_version: registration.software_version,
    rule_set_version: registration.rule_set_version,
    env_fingerprint: envFingerprint ?? registration.env_fingerprint,
    log_fingerprint: logFingerprint,
    results_hash: sha256(stableStringify(results)),
    submitted_at: submittedAt,
  };
  const signature = signSubmission(hospitalPrivatePem, claim);
  return { claim, signature };
}

export async function setupCertifiedHospital(service, authorityToken, {
  provinces = ["闽"],
  version = "2026.1",
  overrides = {},
} = {}) {
  const keys = pemPair();
  const registered = service.registerHospital({
    name: "示例医院",
    provinces,
    public_key: keys.publicPem,
  });
  const build = service.registerBuild(registered.token, {
    software_name: "HIS",
    software_version: "3.1.0",
    rule_set_version: "R-7",
    env_fingerprint: "env-isolated-001",
    provinces,
  }).registration;
  const published = service.publishPackage(authorityToken, version, provinces[0]);
  const envelope = published.package;
  service.distributePackage(registered.token, envelope.package_id);
  const results = perfectResults(envelope, overrides);
  const { claim, signature } = signedSubmission({
    hospitalPrivatePem: keys.privatePem,
    orgId: registered.org.org_id,
    registration: build,
    envelope,
    results,
  });
  const submitted = service.submitResults(registered.token, {
    registration_id: build.registration_id,
    package_id: envelope.package_id,
    results,
    log_fingerprint: "sha256:logs",
    env_fingerprint: build.env_fingerprint,
    claim,
    signature,
  });
  return { keys, registered, build, envelope, results, submitted };
}
