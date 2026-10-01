import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENCY,
  hospitalActor,
  makeApp,
  freshKeyPair,
  answersFor,
  signedSubmit,
  registerAdapter,
} from "./helpers.js";

const COORDS_ALL = [
  "N-REHAB-001|闽",
  "N-NURS-002|闽",
  "N-ACU-010|闽",
  "N-OLD-008|闽",
  "N-CONSULT-006|闽",
  "N-CONSULT-007|闽",
];

async function setup() {
  const { app, cleanup } = await makeApp();
  const { service } = app;
  const keys = await freshKeyPair();
  const actor = hospitalActor("H-ALPHA");
  const { package: pkg } = await service.publishPackage(AGENCY, "2026.1");
  const reg = await registerAdapter(service, actor, {
    publicJwk: keys.publicJwk,
    coordinates: COORDS_ALL,
  });
  return { service, keys, actor, pkg, reg, cleanup };
}

test("全部用例通过即发证，证书可复原包/目录/构建/签署者", async () => {
  const { service, keys, actor, pkg, reg, cleanup } = await setup();
  try {
    const answers = answersFor(pkg);
    const { result } = await signedSubmit(service, actor, reg, pkg, {
      answers,
      privateJwk: keys.privateJwk,
    });
    assert.equal(result.decision, "passed");
    assert.ok(result.certificate_id);

    const cert = service.getCertificate(actor, result.certificate_id);
    assert.equal(cert.status, "certified");
    assert.equal(cert.package.package_id, pkg.package_id);
    assert.equal(cert.catalog.catalog_version, "2026.1");
    assert.equal(cert.software.build_hash, "build-aaa");
    assert.equal(cert.signers.hospital_key_id, reg.signer_key_id);

    const recon = service.reconstructCertificate(AGENCY, cert.cert_id);
    assert.equal(recon.test_package.package_hash, pkg.package_hash);
    assert.equal(recon.registration.build_hash, reg.build_hash);
    assert.equal(recon.result.result_id, result.result_id);
  } finally {
    await cleanup();
  }
});

test("关键用例失败阻止发证", async () => {
  const { service, keys, actor, pkg, reg, cleanup } = await setup();
  try {
    const critical = pkg.cases.find((c) => c.critical);
    const bad = { resolvable: true, province_codes: ["WRONG-1"] };
    const answers = answersFor(pkg, { [critical.case_id]: bad });
    const { result } = await signedSubmit(service, actor, reg, pkg, {
      answers,
      privateJwk: keys.privateJwk,
    });
    assert.equal(result.decision, "rejected");
    assert.ok(result.block_reasons.includes("critical_cases_failed"));
    assert.equal(result.certificate_id, undefined);
  } finally {
    await cleanup();
  }
});

test("非关键用例失败进入待豁免，可凭整改计划带例外发证", async () => {
  const { service, keys, actor, pkg, reg, cleanup } = await setup();
  try {
    const nonCritical = pkg.cases.find((c) => !c.critical);
    const bad = { resolvable: true, province_codes: ["WRONG-2"] };
    const answers = answersFor(pkg, { [nonCritical.case_id]: bad });
    const { result } = await signedSubmit(service, actor, reg, pkg, {
      answers,
      privateJwk: keys.privateJwk,
    });
    assert.equal(result.decision, "blocked_pending_waiver");

    const out = await service.grantWaiver(AGENCY, {
      registration_id: reg.registration_id,
      case_ids: [nonCritical.case_id],
      valid_from: "2026-09-02",
      valid_to: "2026-11-30",
      remediation_plan: "11月底前修复普通项目映射并回归",
    });
    const cert = service.getCertificate(AGENCY, out.certificate_id);
    assert.equal(cert.status, "certified_with_exception");
    assert.equal(cert.exceptions[0].case_ids[0], nonCritical.case_id);
    assert.equal(cert.exceptions[0].signer, AGENCY.subject);
  } finally {
    await cleanup();
  }
});

test("豁免必须附整改计划、限定期限，且不能豁免关键用例", async () => {
  const { service, keys, actor, pkg, reg, cleanup } = await setup();
  try {
    const critical = pkg.cases.find((c) => c.critical);
    await assert.rejects(
      service.grantWaiver(AGENCY, {
        registration_id: reg.registration_id,
        case_ids: [critical.case_id],
        valid_from: "2026-09-02",
        valid_to: "2026-11-30",
        remediation_plan: "计划",
      }),
      /尚无提交结果|非关键/
    );

    // 先制造关键失败。
    const answers = answersFor(pkg, {
      [critical.case_id]: { resolvable: true, province_codes: ["X"] },
    });
    await signedSubmit(service, actor, reg, pkg, {
      answers,
      privateJwk: keys.privateJwk,
    });
    await assert.rejects(
      service.grantWaiver(AGENCY, {
        registration_id: reg.registration_id,
        case_ids: [critical.case_id],
        valid_from: "2026-09-02",
        valid_to: "2027-09-02", // 超过 180 天上限
        remediation_plan: "整改",
      }),
      /豁免期限|非关键/
    );
  } finally {
    await cleanup();
  }
});

test("重复上传（字节相同）返回原认证结果", async () => {
  const { service, keys, actor, pkg, reg, cleanup } = await setup();
  try {
    const answers = answersFor(pkg);
    const first = await signedSubmit(service, actor, reg, pkg, {
      answers,
      privateJwk: keys.privateJwk,
    });
    const second = await signedSubmit(service, actor, reg, pkg, {
      answers,
      privateJwk: keys.privateJwk,
    });
    assert.equal(second.idempotent_replay, true);
    assert.equal(second.result.result_id, first.result.result_id);
  } finally {
    await cleanup();
  }
});

test("执行环境变化阻止发证", async () => {
  const { service, keys, actor, pkg, reg, cleanup } = await setup();
  try {
    const { result } = await signedSubmit(service, actor, reg, pkg, {
      answers: answersFor(pkg),
      privateJwk: keys.privateJwk,
      environment_fingerprint: "env-fp-CHANGED",
    });
    assert.ok(result.block_reasons.includes("environment_changed"));
    assert.equal(result.decision, "rejected");
  } finally {
    await cleanup();
  }
});

test("签名声明无效阻止发证", async () => {
  const { service, keys, actor, pkg, reg, cleanup } = await setup();
  try {
    const signedBody = {
      registration_id: reg.registration_id,
      package_id: pkg.package_id,
      answers: answersFor(pkg),
      log_fingerprint: "logfp",
      environment_fingerprint: reg.environment_fingerprint,
    };
    // 用另一把私钥签名。
    const other = await freshKeyPair();
    const { signDetached, canonicalJson } = await import("../src/core/crypto.js");
    const signature = await signDetached(other.privateJwk, canonicalJson(signedBody));
    const { result } = await service.submit(actor, { ...signedBody, signature });
    assert.ok(result.block_reasons.includes("invalid_signature"));
    assert.equal(result.signature_valid, false);
  } finally {
    await cleanup();
  }
});

test("测试包泄露后提交被阻断，且豁免也被拒绝", async () => {
  const { service, keys, actor, pkg, reg, cleanup } = await setup();
  try {
    await service.markPackageLeaked(AGENCY, pkg.package_id, "外部发现用例外传");
    const { result } = await signedSubmit(service, actor, reg, pkg, {
      answers: answersFor(pkg),
      privateJwk: keys.privateJwk,
    });
    assert.ok(result.block_reasons.includes("package_leaked"));
    assert.equal(result.decision, "rejected");
  } finally {
    await cleanup();
  }
});
