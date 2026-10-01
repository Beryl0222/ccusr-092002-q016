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

const COORDS = {
  rehab: ["N-REHAB-001|闽"],
  rehabZj: ["N-REHAB-001|浙"],
  consult: ["N-CONSULT-006|闽", "N-CONSULT-007|闽"],
};

test("目录修订后仅受影响坐标的适配器进入复测，旧证书保留", async () => {
  const { app, cleanup } = await makeApp();
  const { service } = app;
  try {
    const keysA = await freshKeyPair();
    const keysB = await freshKeyPair();
    const actorA = hospitalActor("H-A");
    const actorB = hospitalActor("H-B");

    const { package: pkg1 } = await service.publishPackage(AGENCY, "2026.1");
    // A 覆盖被修改的一对多坐标（M01），B 只覆盖未变化的诊查坐标。
    const regA = await registerAdapter(service, actorA, {
      publicJwk: keysA.publicJwk,
      coordinates: COORDS.rehab,
      build: "build-A1",
    });
    const regB = await registerAdapter(service, actorB, {
      publicJwk: keysB.publicJwk,
      coordinates: COORDS.consult,
      build: "build-B1",
    });
    const subA = await signedSubmit(service, actorA, regA, pkg1, {
      answers: answersFor(pkg1),
      privateJwk: keysA.privateJwk,
    });
    await signedSubmit(service, actorB, regB, pkg1, {
      answers: answersFor(pkg1),
      privateJwk: keysB.privateJwk,
    });
    const oldCertId = subA.result.certificate_id;
    assert.ok(oldCertId);

    const revision = await service.publishRevision(AGENCY, "2026.1", "2026.2");
    // 变更坐标应包含 M01（一对多组合变化）与 M06（撤销）。
    const changedIds = revision.diff.affected.map((a) => a.mapping_id);
    assert.ok(changedIds.includes("M01"));

    const retests = revision.retests;
    const institutions = retests.map((t) => t.institution_id);
    assert.deepEqual(institutions, ["H-A"]); // B 未受影响，不复测
    assert.deepEqual(retests[0].affected_coordinates, COORDS.rehab);
    assert.deepEqual(retests[0].old_certificate_ids, [oldCertId]);

    // 旧证书仍可查、仍说明 2026.1 时的覆盖范围。
    const oldCert = service.getCertificate(AGENCY, oldCertId);
    assert.equal(oldCert.catalog.catalog_version, "2026.1");
    assert.equal(oldCert.status, "certified");
  } finally {
    await cleanup();
  }
});

test("灰度匿名差异：样本不足不放行，达门槛才扩大", async () => {
  const { app, cleanup } = await makeApp();
  const { service } = app;
  try {
    const keys = await freshKeyPair();
    const actor = hospitalActor("H-G");
    await service.publishPackage(AGENCY, "2026.1");
    const reg = await registerAdapter(service, actor, {
      publicJwk: keys.publicJwk,
      coordinates: COORDS.rehabZj,
    });

    await service.reportGrayscaleStats(actor, {
      registration_id: reg.registration_id,
      period: "2026-W36",
      sample_count: 500,
      mismatch_count: 0,
    });
    const early = service.evaluateGrayscaleGate(AGENCY, reg.registration_id, {
      min_samples: 1000,
      max_mismatch_rate: 0.005,
    });
    assert.equal(early.expansion_allowed, false);
    assert.match(early.reason, /样本量不足/);

    await service.reportGrayscaleStats(AGENCY, {
      registration_id: reg.registration_id,
      period: "2026-W37",
      sample_count: 600,
      mismatch_count: 1,
    });
    const passed = service.evaluateGrayscaleGate(AGENCY, reg.registration_id);
    assert.equal(passed.expansion_allowed, true);
    assert.equal(passed.mismatch_rate, 0.000909);
  } finally {
    await cleanup();
  }
});

test("灰度统计拒绝记录级数据，防止真实账单混入", async () => {
  const { app, cleanup } = await makeApp();
  const { service } = app;
  try {
    const keys = await freshKeyPair();
    const actor = hospitalActor("H-G2");
    await service.publishPackage(AGENCY, "2026.1");
    const reg = await registerAdapter(service, actor, {
      publicJwk: keys.publicJwk,
      coordinates: COORDS.rehabZj,
    });
    await assert.rejects(
      service.reportGrayscaleStats(actor, {
        registration_id: reg.registration_id,
        period: "2026-W36",
        sample_count: 10,
        mismatch_count: 1,
        records: [{ patient: "真实患者" }],
      }),
      /记录级数据/
    );
  } finally {
    await cleanup();
  }
});

test("机构间可见性隔离：医院看不到其他机构的证书与登记", async () => {
  const { app, cleanup } = await makeApp();
  const { service } = app;
  try {
    const keysA = await freshKeyPair();
    const actorA = hospitalActor("H-A");
    const actorB = hospitalActor("H-B");
    const { package: pkg } = await service.publishPackage(AGENCY, "2026.1");
    const regA = await registerAdapter(service, actorA, {
      publicJwk: keysA.publicJwk,
      coordinates: COORDS.rehab,
    });
    const { result } = await signedSubmit(service, actorA, regA, pkg, {
      answers: answersFor(pkg),
      privateJwk: keysA.privateJwk,
    });

    // B 访问 A 的证书/结果/登记，一律按 404 处理。
    assert.throws(() => service.getCertificate(actorB, result.certificate_id), /不存在/);
    assert.throws(() => service.getResult(actorB, result.result_id), /不存在/);

    // 证书列表对 B 也不可见 A 的证书。
    const listForB = service.listCertificates(actorB);
    assert.equal(listForB.some((c) => c.institution.institution_id === "H-A"), false);

    // 经办机构可以看到全部并做完整复原。
    const listForAgency = service.listCertificates(AGENCY);
    assert.ok(listForAgency.some((c) => c.institution.institution_id === "H-A"));
    const recon = service.reconstructCertificate(AGENCY, result.certificate_id);
    assert.equal(recon.registration.institution_id, "H-A");
  } finally {
    await cleanup();
  }
});

test("医院角色不能发布测试包或授予豁免", async () => {
  const { app, cleanup } = await makeApp();
  const { service } = app;
  try {
    const actor = hospitalActor("H-X");
    await assert.rejects(() => service.publishPackage(actor, "2026.1"), /agency/);
    await assert.rejects(
      () =>
        service.grantWaiver(actor, {
          registration_id: "x",
          case_ids: ["c"],
          valid_from: "2026-09-01",
          valid_to: "2026-10-01",
          remediation_plan: "p",
        }),
      /agency/
    );
  } finally {
    await cleanup();
  }
});
