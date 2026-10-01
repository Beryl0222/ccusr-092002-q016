import assert from "node:assert/strict";
import test from "node:test";

import {
  newService,
  pemPair,
  perfectResults,
  signedSubmission,
} from "./helpers.js";

async function certifiedWithWaiver(ctx) {
  const reviewer = ctx.service.createReviewer({ name: "张审查" });
  const keys = pemPair();
  const registered = ctx.service.registerHospital({
    name: "复查医院", provinces: ["闽"], public_key: keys.publicPem,
  });
  const build = ctx.service.registerBuild(registered.token, {
    software_name: "HIS",
    software_version: "3.1.0",
    rule_set_version: "R-7",
    env_fingerprint: "env-isolated-001",
    provinces: ["闽"],
  }).registration;
  const envelope = ctx.service.publishPackage(ctx.authorityToken, "2026.1", "闽").package;
  ctx.service.distributePackage(registered.token, envelope.package_id);
  const target = envelope.body.cases.find(
    (c) => c.national_code === "N-SURG-002" && c.category === "one_to_many",
  );
  ctx.service.approveWaiver(reviewer.token, {
    org_id: registered.org.org_id,
    software_version: build.software_version,
    rule_set_version: build.rule_set_version,
    valid_from: "2026-09-01",
    valid_until: "2026-12-31",
    case_ids: [target.case_id],
    reason: "联调滞后",
    remediation_plan: "10月底前完成组合拆分改造",
  });
  const results = perfectResults(envelope, {
    [target.case_id]: { accepted: true, province_codes: ["FJ-5101A"] },
  });
  const env = build.env_fingerprint;
  const { claim, signature } = signedSubmission({
    hospitalPrivatePem: keys.privatePem,
    orgId: registered.org.org_id,
    registration: build, envelope, results, envFingerprint: env,
  });
  const { certificate } = ctx.service.submitResults(registered.token, {
    registration_id: build.registration_id,
    package_id: envelope.package_id,
    results,
    log_fingerprint: "sha256:logs",
    env_fingerprint: env,
    claim,
    signature,
  });
  return { reviewer, registered, envelope, certificate };
}

test("审查者可从一张证书复原全部要素并验签", async () => {
  const ctx = await newService();
  const { reviewer, envelope, certificate } = await certifiedWithWaiver(ctx);
  const record = ctx.service.reconstructCertificate(reviewer.token, certificate.certificate_id);

  assert.equal(record.certificate.certificate_id, certificate.certificate_id);
  // 测试包与逐用例
  assert.equal(record.test_package.package_id, envelope.package_id);
  assert.equal(record.test_package.body.cases.length, envelope.body.cases.length);
  // 目录版本快照
  assert.equal(record.catalog_version.version, "2026.1");
  // 医院构建
  assert.equal(record.hospital_build.registration.software_version, "3.1.0");
  assert.equal(record.hospital_build.org.public_key, undefined); // 审查复原不外泄医院公钥以外？公钥本身公开；这里确认不返回敏感字段
  // 例外意见与整改计划
  assert.equal(record.exceptions.length, 1);
  assert.match(record.exceptions[0].remediation_plan, /组合拆分/);
  assert.ok(record.exceptions[0].reviewer_signature);
  // 签署者
  assert.ok(record.signers.authority);
  assert.equal(record.signers.hospital_org_id, certificate.org_id);
  assert.ok(record.signers.waiver_approvers.length >= 1);
  // 全部签名/哈希校验通过
  assert.deepEqual(record.signatures, {
    authority_cert: true,
    authority_package: true,
    package_integrity: true,
    catalog_hash_matches: true,
    hospital_declaration: true,
  });
});

test("医院角色无法访问审查复原接口", async () => {
  const ctx = await newService();
  const { certificate, registered } = await certifiedWithWaiver(ctx);
  assert.throws(
    () => ctx.service.reconstructCertificate(registered.token, certificate.certificate_id),
    /角色无权访问/,
  );
});

test("医院只能看到自己的证书，看不到其他机构结果", async () => {
  const ctx = await newService();
  const a = await certifiedWithWaiver(ctx);
  const b = await certifiedWithWaiver(ctx);
  assert.throws(
    () => ctx.service.getOwnCertificate(a.registered.token, b.certificate.certificate_id),
    /证书不存在/,
  );
  const own = ctx.service.getOwnCertificate(a.registered.token, a.certificate.certificate_id);
  assert.equal(own.certificate.certificate_id, a.certificate.certificate_id);
});
