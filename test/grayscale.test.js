import assert from "node:assert/strict";
import test from "node:test";

import { newService, pemPair } from "./helpers.js";

function hospitalToken(ctx, provinces = ["闽"]) {
  const keys = pemPair();
  const { token, org } = ctx.service.registerHospital({
    name: "灰度医院", provinces, public_key: keys.publicPem,
  });
  return { token, org };
}

test("灰度统计完全匿名：只保留聚合，不含机构标识", async () => {
  const ctx = await newService();
  const a = hospitalToken(ctx);
  const b = hospitalToken(ctx);

  ctx.service.recordGrayscaleEvents(a.token, [
    { national_code: "N-REHAB-001", matched: true },
    { national_code: "N-LAB-003", matched: false },
  ]);
  ctx.service.recordGrayscaleEvents(b.token, [
    { national_code: "N-LAB-003", matched: true },
  ]);

  const stats = ctx.service.state.grayscale;
  assert.equal(stats.exposures, 3);
  assert.equal(stats.differences, 1);
  assert.equal(JSON.stringify(stats).includes(a.org.org_id), false);
  assert.equal(JSON.stringify(stats).includes(b.org.org_id), false);
  assert.ok(stats.by_code["N-LAB-003"]);
});

test("样本量不足不得扩大使用", async () => {
  const ctx = await newService();
  const { token } = hospitalToken(ctx);
  ctx.service.recordGrayscaleEvents(token, Array.from({ length: 50 }, () => ({
    national_code: "N-REHAB-001", matched: true,
  })));
  const decision = ctx.service.grayscaleDecision(ctx.authorityToken);
  assert.equal(decision.can_expand, false);
  assert.ok(decision.reasons.some((r) => r.includes("样本量不足")));
});

test("样本达标且差异率在门槛内才允许扩大", async () => {
  const ctx = await newService();
  const { token } = hospitalToken(ctx);
  ctx.service.recordGrayscaleEvents(token, Array.from({ length: 100 }, (_, i) => ({
    national_code: "N-REHAB-001", matched: i !== 0, // 1/100 = 1% 恰好达门槛
  })));
  const atThreshold = ctx.service.grayscaleDecision(ctx.authorityToken);
  assert.equal(atThreshold.can_expand, true);
  assert.equal(atThreshold.difference_rate, 0.01);

  const ctx2 = await newService();
  const t2 = hospitalToken(ctx2).token;
  ctx2.service.recordGrayscaleEvents(t2, Array.from({ length: 100 }, (_, i) => ({
    national_code: "N-REHAB-001", matched: i > 1, // 2/100 = 2% 超门槛
  })));
  const over = ctx2.service.grayscaleDecision(ctx2.authorityToken);
  assert.equal(over.can_expand, false);
  assert.ok(over.reasons.some((r) => r.includes("超过门槛")));
});
