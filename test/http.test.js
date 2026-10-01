import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";

import { createApp } from "../src/app.js";
import { JsonStore } from "../src/domain/store.js";
import { generateKeyPairSync } from "node:crypto";
import { perfectResults, signedSubmission } from "./helpers.js";

async function startServer() {
  const catalog = JSON.parse(await readFile(
    new URL("../contracts/catalog_mapping.json", import.meta.url),
    "utf8",
  ));
  const authorityKey = generateKeyPairSync("ed25519");
  const app = createApp({
    catalog,
    authorityKey,
    store: new JsonStore(null),
    clock: () => new Date("2026-09-15T08:00:00Z"),
    serviceId: "medical-service-catalog",
  });
  const authorityToken = app.service.createAuthorityToken();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { base, authorityToken, close: () => app.server.close() };
}

const hospitalKeys = () => {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicPem: pair.publicKey.export({ type: "spki", format: "pem" }),
    privatePem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
};

async function jsonHttp(base, path, token, body, method = "POST") {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

test("端到端：登记→发布→分发→提交→发证→取证书", async () => {
  const server = await startServer();
  try {
    const keys = hospitalKeys();

    const health = await fetch(`${server.base}/health`).then((r) => r.json());
    assert.equal(health.status, "ok");

    const reg = await jsonHttp(server.base, "/v1/hospitals", server.authorityToken, {
      name: "端到端医院", provinces: ["闽"], public_key: keys.publicPem,
    });
    assert.equal(reg.status, 200);
    const hospitalToken = reg.payload.token;
    const orgId = reg.payload.org.org_id;

    const build = await jsonHttp(server.base, "/v1/builds", hospitalToken, {
      software_name: "HIS",
      software_version: "4.0.0",
      rule_set_version: "R-9",
      env_fingerprint: "env-e2e-001",
      provinces: ["闽"],
    });
    const registration = build.payload.registration;

    const published = await jsonHttp(server.base, "/v1/packages", server.authorityToken, {
      catalog_version: "2026.1", province: "闽",
    });
    const envelope = published.payload.package;
    assert.ok(envelope.authority_signature);

    const dist = await jsonHttp(
      server.base,
      `/v1/packages/${envelope.package_id}/distribute`,
      hospitalToken, {},
    );
    assert.ok(dist.payload.watermark);

    const results = perfectResults(envelope);
    const { claim, signature } = signedSubmission({
      hospitalPrivatePem: keys.privatePem,
      orgId, registration, envelope, results,
    });
    const verdict = await jsonHttp(server.base, "/v1/submissions", hospitalToken, {
      registration_id: registration.registration_id,
      package_id: envelope.package_id,
      results,
      log_fingerprint: "sha256:logs",
      env_fingerprint: registration.env_fingerprint,
      claim,
      signature,
    });
    assert.equal(verdict.payload.verdict.compatible, true);
    const certificateId = verdict.payload.certificate.certificate_id;

    const mine = await jsonHttp(
      server.base, `/v1/certificates/${certificateId}`, hospitalToken, undefined, "GET",
    );
    assert.equal(mine.payload.certificate.catalog_version, "2026.1");

    // 重复上传返回同一结论
    const again = await jsonHttp(server.base, "/v1/submissions", hospitalToken, {
      registration_id: registration.registration_id,
      package_id: envelope.package_id,
      results,
      log_fingerprint: "sha256:logs",
      env_fingerprint: registration.env_fingerprint,
      claim,
      signature,
    });
    assert.equal(again.payload.idempotent, true);
    assert.equal(again.payload.verdict.verdict_id, verdict.payload.verdict.verdict_id);
  } finally {
    server.close();
  }
});

test("鉴权：无令牌 401，角色越权 403，租户隔离 404", async () => {
  const server = await startServer();
  try {
    const noToken = await jsonHttp(server.base, "/v1/grayscale/decision", null, undefined, "GET");
    assert.equal(noToken.status, 401);

    const keys = hospitalKeys();
    const reg = await jsonHttp(server.base, "/v1/hospitals", server.authorityToken, {
      name: "甲医院", provinces: ["闽"], public_key: keys.publicPem,
    });
    const otherKeys = hospitalKeys();
    const reg2 = await jsonHttp(server.base, "/v1/hospitals", server.authorityToken, {
      name: "乙医院", provinces: ["闽"], public_key: otherKeys.publicPem,
    });

    // 医院不能发布测试包
    const forbidden = await jsonHttp(server.base, "/v1/packages", reg.payload.token, {
      province: "闽",
    });
    assert.equal(forbidden.status, 403);

    // 医院不能访问审查接口
    const reviewer = await jsonHttp(server.base, "/v1/reviewers", server.authorityToken, {
      name: "审查员",
    });
    const crossReview = await jsonHttp(
      server.base, "/v1/review/certificates/CERT-nope", reg.payload.token, undefined, "GET",
    );
    assert.equal(crossReview.status, 403);
    void reviewer;

    // 给乙发证，甲看不到
    const build = await jsonHttp(server.base, "/v1/builds", reg2.payload.token, {
      software_name: "HIS", software_version: "1.0",
      rule_set_version: "R-1", env_fingerprint: "env-b", provinces: ["闽"],
    });
    const published = await jsonHttp(server.base, "/v1/packages", server.authorityToken, {
      catalog_version: "2026.1", province: "闽",
    });
    const envelope = published.payload.package;
    await jsonHttp(
      server.base, `/v1/packages/${envelope.package_id}/distribute`, reg2.payload.token, {},
    );
    const results = perfectResults(envelope);
    const { claim, signature } = signedSubmission({
      hospitalPrivatePem: otherKeys.privatePem,
      orgId: reg2.payload.org.org_id,
      registration: build.payload.registration,
      envelope, results,
    });
    const verdict = await jsonHttp(server.base, "/v1/submissions", reg2.payload.token, {
      registration_id: build.payload.registration.registration_id,
      package_id: envelope.package_id,
      results,
      log_fingerprint: "sha256:logs",
      env_fingerprint: build.payload.registration.env_fingerprint,
      claim,
      signature,
    });
    const peek = await jsonHttp(
      server.base,
      `/v1/certificates/${verdict.payload.certificate.certificate_id}`,
      reg.payload.token, undefined, "GET",
    );
    assert.equal(peek.status, 404);

    // 审查者可以复原
    const reconstructed = await jsonHttp(
      server.base,
      `/v1/review/certificates/${verdict.payload.certificate.certificate_id}`,
      reviewer.payload.token, undefined, "GET",
    );
    assert.equal(reconstructed.status, 200);
    assert.equal(reconstructed.payload.signatures.authority_cert, true);
    assert.equal(reconstructed.payload.hospital_build.org.name, "乙医院");
  } finally {
    server.close();
  }
});
