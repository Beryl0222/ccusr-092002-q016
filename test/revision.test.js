import assert from "node:assert/strict";
import test from "node:test";

import { setupCertifiedHospital } from "./helpers.js";
import { newService } from "./helpers.js";

test("目录修订后仅受影响适配器进入复测，旧证书保留并说明当时范围", async () => {
  const ctx = await newService();
  const fujian = await setupCertifiedHospital(ctx.service, ctx.authorityToken, {
    provinces: ["闽"], version: "2026.1",
  });
  const zhejiang = await setupCertifiedHospital(ctx.service, ctx.authorityToken, {
    provinces: ["浙"], version: "2026.1",
  });

  const record = ctx.service.applyRevision(ctx.authorityToken, {
    from_version: "2026.1",
    to_version: "2026.2",
  });

  // 闽：PM-003 变化 + 新增 N-TRAD-006 闽映射 → 需复测
  assert.ok(record.affected.some((a) => a.certificate_id === fujian.submitted.certificate.certificate_id));
  // 浙：本目录修订无浙省映射变化、浙省无新增映射 → 不需复测
  assert.ok(!record.affected.some((a) => a.certificate_id === zhejiang.submitted.certificate.certificate_id));

  // 旧证书不失效，仍记载当时覆盖的目录版本（复测要求另行标注）
  assert.equal(fujian.submitted.certificate.status, "valid");
  assert.equal(fujian.submitted.certificate.catalog_version, "2026.1");
  assert.equal(fujian.submitted.certificate.retest.required, true);
  assert.equal(fujian.submitted.certificate.retest.to_version, "2026.2");
  assert.ok(fujian.submitted.certificate.retest.affected_codes.includes("N-LAB-003"));
  assert.match(fujian.submitted.certificate.coverage.statement, /2026\.1/);
  assert.equal(zhejiang.submitted.certificate.retest, null);
});

test("修订重复应用不产生重复复测标记", async () => {
  const ctx = await newService();
  await setupCertifiedHospital(ctx.service, ctx.authorityToken, {
    provinces: ["闽"], version: "2026.1",
  });
  const first = ctx.service.applyRevision(ctx.authorityToken, {
    from_version: "2026.1", to_version: "2026.2",
  });
  const second = ctx.service.applyRevision(ctx.authorityToken, {
    from_version: "2026.1", to_version: "2026.2",
  });
  assert.equal(first.affected.length, 1);
  assert.equal(second.affected.length, 0);
});
