import assert from "node:assert/strict";
import test from "node:test";

import {
  newService,
  pemPair,
  perfectResults,
  signedSubmission,
  setupCertifiedHospital,
} from "./helpers.js";

async function setupParts(ctx, { provinces = ["闽"], version = "2026.1" } = {}) {
  const keys = pemPair();
  const registered = ctx.service.registerHospital({
    name: "示例医院", provinces, public_key: keys.publicPem,
  });
  const build = ctx.service.registerBuild(registered.token, {
    software_name: "HIS",
    software_version: "3.1.0",
    rule_set_version: "R-7",
    env_fingerprint: "env-isolated-001",
    provinces,
  }).registration;
  const published = ctx.service.publishPackage(ctx.authorityToken, version, provinces[0]);
  ctx.service.distributePackage(registered.token, published.package.package_id);
  return {
    keys,
    registered,
    build,
    envelope: published.package,
    results: perfectResults(published.package),
  };
}

function registerBuild(ctx, registered, { softwareVersion, ruleVersion, envFingerprint, provinces }) {
  return ctx.service.registerBuild(registered.token, {
    software_name: "HIS",
    software_version: softwareVersion,
    rule_set_version: ruleVersion,
    env_fingerprint: envFingerprint,
    provinces,
  }).registration;
}

function waiverBody({ registered, build, caseIds, overrides = {} }) {
  return {
    org_id: registered.org.org_id,
    software_version: build.software_version,
    rule_set_version: build.rule_set_version,
    valid_from: "2026-09-01",
    valid_until: "2026-12-31",
    case_ids: caseIds,
    reason: "省平台接口联调滞后",
    remediation_plan: "10月31日前完成组合拆分改造并复测",
    ...overrides,
  };
}

function failingGroupCase(envelope) {
  return envelope.body.cases.find(
    (c) => c.national_code === "N-SURG-002" && c.category === "one_to_many",
  );
}

function submit(ctx, { keys, registered, build, envelope, results, envFingerprint, logFingerprint, headerLogFingerprint }) {
  const finalResults = results ?? perfectResults(envelope);
  const env = envFingerprint ?? build.env_fingerprint;
  const claimedLog = logFingerprint ?? "sha256:logs";
  const headerLog = headerLogFingerprint ?? claimedLog;
  const { claim, signature } = signedSubmission({
    hospitalPrivatePem: keys.privatePem,
    orgId: registered.org.org_id,
    registration: build,
    envelope,
    results: finalResults,
    envFingerprint: env,
    logFingerprint: claimedLog,
  });
  return ctx.service.submitResults(registered.token, {
    registration_id: build.registration_id,
    package_id: envelope.package_id,
    results: finalResults,
    log_fingerprint: headerLog,
    env_fingerprint: env,
    claim,
    signature,
  });
}

test("全绿提交发放有效证书", async () => {
  const ctx = await newService();
  const { submitted, envelope, build } = await setupCertifiedHospital(
    ctx.service, ctx.authorityToken,
  );
  assert.equal(submitted.verdict.compatible, true);
  assert.equal(submitted.verdict.status, "pass");
  assert.equal(submitted.verdict.passed_cases, envelope.case_count);
  assert.equal(submitted.certificate.status, "valid");
  assert.equal(submitted.certificate.catalog_version, "2026.1");
  assert.equal(submitted.certificate.build.software_version, build.software_version);
  assert.ok(submitted.certificate.authority_signature);
  assert.match(submitted.certificate.coverage.statement, /仅证明/);
});

test("关键用例失败阻止发证", async () => {
  const ctx = await newService();
  const parts = await setupParts(ctx);
  const target = failingGroupCase(parts.envelope);
  const results = perfectResults(parts.envelope, {
    [target.case_id]: { accepted: true, province_codes: ["FJ-5101A", "FJ-5101B"] },
  });
  const out = submit(ctx, { ...parts, results });
  assert.equal(out.verdict.compatible, false);
  assert.equal(out.certificate, null);
  assert.ok(out.verdict.blockers.includes("critical_case_failure"));
  assert.ok(out.verdict.failures.some((f) => f.reason === "code_mismatch"));
});

test("互斥项目同时计费被判失败", async () => {
  const ctx = await newService();
  const parts = await setupParts(ctx);
  const mutexCase = parts.envelope.body.cases.find(
    (c) => c.category === "mutex" && c.expected.accepted === false,
  );
  const results = perfectResults(parts.envelope, {
    [mutexCase.case_id]: { accepted: true, province_codes: ["FJ-6204", "FJ-6205"] },
  });
  const out = submit(ctx, { ...parts, results });
  assert.ok(out.verdict.blockers.includes("critical_case_failure"));
  assert.ok(out.verdict.failures.some((f) => f.case_id === mutexCase.case_id && f.reason === "unexpected_accept"));
});

test("执行环境变化阻止发证", async () => {
  const ctx = await newService();
  const parts = await setupParts(ctx);
  const out = submit(ctx, { ...parts, envFingerprint: "env-changed-999" });
  assert.equal(out.verdict.compatible, false);
  assert.ok(out.verdict.blockers.includes("environment_changed"));
});

test("签名声明缺失或伪造阻止发证", async () => {
  const ctx = await newService();
  const parts = await setupParts(ctx);
  const forged = submit(ctx, { ...parts, keys: pemPair() });
  assert.ok(forged.verdict.blockers.includes("invalid_signature"));
  assert.equal(forged.verdict.compatible, false);

  const noSig = ctx.service.submitResults(parts.registered.token, {
    registration_id: parts.build.registration_id,
    package_id: parts.envelope.package_id,
    results: parts.results,
    log_fingerprint: "sha256:logs",
    env_fingerprint: parts.build.env_fingerprint,
  });
  assert.ok(noSig.verdict.blockers.includes("invalid_signature"));
});

test("日志指纹与声明不一致阻止发证", async () => {
  const ctx = await newService();
  const parts = await setupParts(ctx);
  const out = submit(ctx, {
    ...parts,
    logFingerprint: "sha256:signed-logs",
    headerLogFingerprint: "sha256:different-logs",
  });
  // 声明按 signed-logs 签署，但提交头是 different-logs
  assert.ok(out.verdict.blockers.includes("invalid_declaration_claim"));
});

test("重复上传原样返回原认证结果（幂等，即使内容被改）", async () => {
  const ctx = await newService();
  const setup = await setupCertifiedHospital(ctx.service, ctx.authorityToken);
  const again = submit(ctx, setup);
  assert.equal(again.idempotent, true);
  assert.equal(again.verdict.verdict_id, setup.submitted.verdict.verdict_id);
  assert.equal(again.certificate.certificate_id, setup.submitted.certificate.certificate_id);

  const tampered = perfectResults(setup.envelope, {
    [setup.envelope.body.cases[0].case_id]: { accepted: true, province_codes: ["WRONG"] },
  });
  const still = submit(ctx, { ...setup, results: tampered });
  assert.equal(still.idempotent, true);
  assert.equal(still.verdict.status, "pass");
});

test("水印泄露：泄露机构证书撤销且再测被阻断，其他机构不受影响", async () => {
  const ctx = await newService();
  const leaked = await setupCertifiedHospital(ctx.service, ctx.authorityToken);
  const other = await setupCertifiedHospital(ctx.service, ctx.authorityToken, {
    provinces: ["浙"],
  });

  const dist = ctx.service.state.distributions[
    `${leaked.registered.org.org_id}:${leaked.envelope.package_id}`
  ];
  const report = ctx.service.reportLeak(ctx.authorityToken, {
    package_id: leaked.envelope.package_id,
    watermark: dist.watermark,
  });
  assert.equal(report.scope, "organization");
  assert.equal(leaked.submitted.certificate.status, "revoked");
  assert.equal(other.submitted.certificate.status, "valid");

  const rebuild = registerBuild(ctx, leaked.registered, {
    softwareVersion: "3.2.0", ruleVersion: "R-8", envFingerprint: "env-isolated-002",
  });
  const out = submit(ctx, {
    keys: leaked.keys, registered: leaked.registered, build: rebuild,
    envelope: leaked.envelope, results: perfectResults(leaked.envelope),
  });
  assert.ok(out.verdict.blockers.includes("test_package_leaked"));
});

test("整包泄露：全部分发停止并撤销相关证书", async () => {
  const ctx = await newService();
  const fujian = await setupCertifiedHospital(ctx.service, ctx.authorityToken);
  ctx.service.reportLeak(ctx.authorityToken, { package_id: fujian.envelope.package_id });
  assert.equal(fujian.submitted.certificate.status, "revoked");
  assert.throws(
    () => ctx.service.distributePackage(fujian.registered.token, fujian.envelope.package_id),
    /已整体泄露/,
  );
});

test("豁免必须限定机构、版本、期限并附整改计划", async () => {
  const ctx = await newService();
  const reviewer = ctx.service.createReviewer({ name: "张审查" });
  const parts = await setupParts(ctx);
  const body = waiverBody({
    registered: parts.registered, build: parts.build, caseIds: ["TC-0001"],
  });
  assert.throws(() => ctx.service.approveWaiver(reviewer.token, { ...body, org_id: "ORG-NOPE" }), /机构/);
  assert.throws(() => ctx.service.approveWaiver(reviewer.token, { ...body, software_version: undefined }), /软件版本/);
  assert.throws(() => ctx.service.approveWaiver(reviewer.token, { ...body, valid_until: "2026-08-31" }), /期限/);
  assert.throws(() => ctx.service.approveWaiver(reviewer.token, { ...body, remediation_plan: "  " }), /整改计划/);
  assert.throws(() => ctx.service.approveWaiver(reviewer.token, { ...body, case_ids: [] }), /关键用例/);

  ctx.clock.set("2027-01-01");
  assert.throws(() => ctx.service.approveWaiver(reviewer.token, body), /期限已过/);
});

test("精确匹配的豁免条件发证；机构或版本不匹配不得豁免", async () => {
  const ctx = await newService();
  const reviewer = ctx.service.createReviewer({ name: "张审查" });
  const parts = await setupParts(ctx);
  const target = failingGroupCase(parts.envelope);
  const failingResults = perfectResults(parts.envelope, {
    [target.case_id]: { accepted: true, province_codes: ["FJ-5101A"] },
  });

  // 提交前预批准豁免（机构、版本、期限、整改计划齐全）
  ctx.service.approveWaiver(reviewer.token, waiverBody({
    registered: parts.registered, build: parts.build, caseIds: [target.case_id],
  }));
  const out = submit(ctx, { ...parts, results: failingResults });
  assert.equal(out.verdict.compatible, true);
  assert.equal(out.verdict.status, "conditional_pass");
  assert.equal(out.certificate.status, "conditional");
  assert.deepEqual(out.certificate.waived_cases, [target.case_id]);
  assert.equal(out.certificate.exceptions.length, 1);

  // 另一家机构同样失败：豁免不随机构外溢
  const otherParts = await setupParts(ctx);
  const otherOut = submit(ctx, { ...otherParts, results: failingResultsFor(otherParts.envelope) });
  assert.ok(otherOut.verdict.blockers.includes("critical_case_failure"));
});

test("豁免过期后不再覆盖", async () => {
  const ctx = await newService();
  const reviewer = ctx.service.createReviewer({ name: "张审查" });
  const parts = await setupParts(ctx);
  const target = failingGroupCase(parts.envelope);
  ctx.service.approveWaiver(reviewer.token, waiverBody({
    registered: parts.registered, build: parts.build, caseIds: [target.case_id],
    overrides: { valid_until: "2026-09-30" },
  }));
  ctx.clock.set("2026-10-01");
  const rebuild = registerBuild(ctx, parts.registered, {
    softwareVersion: "3.1.1", ruleVersion: "R-7", envFingerprint: "env-isolated-001",
  });
  const out = submit(ctx, {
    ...parts, build: rebuild,
    results: perfectResults(parts.envelope, {
      [target.case_id]: { accepted: true, province_codes: ["FJ-5101A"] },
    }),
  });
  assert.ok(out.verdict.blockers.includes("critical_case_failure"));
});

function failingResultsFor(envelope) {
  const target = envelope.body.cases.find((c) => c.category === "one_to_many");
  return perfectResults(envelope, {
    [target.case_id]: { accepted: true, province_codes: [target.expected.expected_province_codes[0]] },
  });
}
