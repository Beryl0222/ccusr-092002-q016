import assert from "node:assert/strict";
import test from "node:test";

import { loadCatalog } from "./helpers.js";
import { getVersion, versionHash } from "../src/domain/catalog.js";
import {
  sealTestPackage,
  verifyPackageIntegrity,
  generateCases,
  watermarkedCopy,
} from "../src/domain/testpackage.js";

const catalog = await loadCatalog();
const v1 = getVersion(catalog, "2026.1");

function seal(province = "闽") {
  return sealTestPackage({
    packageId: "PKG-FIXED-FUJIAN",
    catalogVersion: v1,
    catalogHash: versionHash(v1),
    province,
    issuedAt: "2026-09-15",
  });
}

test("测试包覆盖五类关键用例", () => {
  const cases = generateCases(v1, "闽");
  const categories = new Set(cases.map((c) => c.category));
  for (const category of [
    "one_to_many",
    "conditional",
    "mutex",
    "effective_boundary",
    "revocation",
    "historical_encounter",
  ]) {
    assert.ok(categories.has(category), `缺少类别 ${category}`);
  }
  // 一对多组合
  const group = cases.find((c) => c.national_code === "N-SURG-002" && c.category === "one_to_many");
  assert.deepEqual(group.expected.expected_province_codes, ["FJ-5101A", "FJ-5101B", "FJ-5101C"]);
  // 互斥
  const mutex = cases.find((c) => c.category === "mutex" && !c.expected.accepted);
  assert.equal(mutex.expected.reason, "mutex_violation");
  // 撤销后拒绝 / 撤销前历史就诊
  assert.ok(cases.some((c) => c.category === "revocation" && c.expected.reason === "revoked"));
  const historical = cases.find((c) => c.category === "historical_encounter");
  assert.deepEqual(historical.expected.expected_province_codes, ["FJ-9001"]);
  assert.equal(historical.expected.accepted, true);
});

test("同一目录版本+省份生成字节一致的测试包", () => {
  const a = seal();
  const b = seal();
  assert.equal(a.package_hash, b.package_hash);
  assert.equal(a.cases_hash, b.cases_hash);
});

test("篡改用例导致完整性校验失败", () => {
  const envelope = seal();
  envelope.body.cases[0].description = "被篡改";
  const result = verifyPackageIntegrity(envelope);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cases_hash_mismatch");

  const clean = seal();
  clean.case_count = 999;
  assert.equal(verifyPackageIntegrity(clean).ok, false);
});

test("机构水印互不相同且不改变包哈希", () => {
  const envelope = seal();
  const a = watermarkedCopy(envelope, "ORG-A");
  const b = watermarkedCopy(envelope, "ORG-B");
  assert.notEqual(a.watermark, b.watermark);
  assert.equal(a.package_hash, envelope.package_hash);
});
