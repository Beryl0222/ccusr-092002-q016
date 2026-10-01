import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createHttpServer } from "../src/http.js";
import { serviceId, serviceName } from "../src/service.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateSigningKeyPair,
  exportJwk,
  signDetached,
  canonicalJson,
} from "../src/core/crypto.js";

async function start() {
  const dir = await mkdtemp(join(tmpdir(), "cert-http-"));
  const app = await createApp({ dataPath: join(dir, "state.json") });
  const server = createHttpServer(app, { serviceId, serviceName });
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const port = server.address().port;
  const agencyToken = await app.tokens.issue({ role: "agency", subject: "agency:t" });
  const hospToken = await app.tokens.issue({
    role: "hospital",
    subject: "hospital:H1",
    institution_id: "H1",
  });
  return {
    base: `http://127.0.0.1:${port}`,
    agencyToken,
    hospToken,
    app,
    close: async () => {
      await new Promise((r) => server.close(r));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function call(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test("无令牌访问受保护资源返回 401，健康检查免鉴权", async () => {
  const env = await start();
  try {
    const health = await call(env.base, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.service, serviceId);
    const denied = await call(env.base, "GET", "/certificates");
    assert.equal(denied.status, 401);
  } finally {
    await env.close();
  }
});

test("端到端 HTTP：发布包→医院视图无期望→登记→签名提交→出证→跨机构 404", async () => {
  const env = await start();
  try {
    const pub = await call(env.base, "POST", "/packages/publish", {
      token: env.agencyToken,
      body: { catalog_version: "2026.1" },
    });
    assert.equal(pub.status, 200);
    const pkg = pub.json;

    const view = await call(env.base, "GET", `/packages/${pkg.package_id}`, {
      token: env.hospToken,
    });
    assert.equal(view.status, 200);
    assert.equal(view.json.cases[0].expected, undefined);

    const pair = await generateSigningKeyPair();
    const publicJwk = await exportJwk(pair.publicKey);
    const privateJwk = await exportJwk(pair.privateKey);
    const reg = await call(env.base, "POST", "/adapters/register", {
      token: env.hospToken,
      body: {
        software_name: "HIS",
        software_version: "2.0",
        build_hash: "b20",
        rule_set: { x: 1 },
        covered_coordinates: pkg.cases.map((c) => `${c.input.national_code}|${c.input.province}`),
        environment_fingerprint: "env1",
        isolated_environment: true,
        signing_public_jwk: publicJwk,
      },
    });
    assert.equal(reg.status, 200);

    // 用封存期望（仅测试可从 agency 视图取得）逐例作答。
    const answers = pkg.cases.map((c) => ({ case_id: c.case_id, output: c.expected }));
    const signedBody = {
      registration_id: reg.json.registration_id,
      package_id: pkg.package_id,
      answers,
      log_fingerprint: "lp",
      environment_fingerprint: "env1",
    };
    const signature = await signDetached(privateJwk, canonicalJson(signedBody));
    const sub = await call(env.base, "POST", "/submissions", {
      token: env.hospToken,
      body: { ...signedBody, signature },
    });
    assert.equal(sub.status, 200);
    assert.equal(sub.json.result.decision, "passed");

    const certId = sub.json.result.certificate_id;
    const mine = await call(env.base, "GET", `/certificates/${certId}`, {
      token: env.hospToken,
    });
    assert.equal(mine.status, 200);

    // 审查人员复原。
    const recon = await call(env.base, "GET", `/certificates/${certId}/reconstruct`, {
      token: env.agencyToken,
    });
    assert.equal(recon.status, 200);
    assert.equal(recon.json.test_package.package_id, pkg.package_id);

    // 医院不能调用审查复原接口。
    const reconDenied = await call(
      env.base,
      "GET",
      `/certificates/${certId}/reconstruct`,
      { token: env.hospToken }
    );
    assert.equal(reconDenied.status, 403);
  } finally {
    await env.close();
  }
});
