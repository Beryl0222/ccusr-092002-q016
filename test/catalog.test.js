import assert from "node:assert/strict";
import test from "node:test";

import { loadCatalog } from "./helpers.js";
import {
  getVersion,
  versionHash,
  revisionDiff,
  scopeIsAffected,
  validateCatalog,
} from "../src/domain/catalog.js";

const catalog = await loadCatalog();

test("目录结构合法", () => {
  assert.equal(validateCatalog(catalog), true);
});

test("版本哈希确定且两版本不同", () => {
  const h1 = versionHash(getVersion(catalog, "2026.1"));
  const h1Again = versionHash(getVersion(catalog, "2026.1"));
  const h2 = versionHash(getVersion(catalog, "2026.2"));
  assert.equal(h1, h1Again);
  assert.notEqual(h1, h2);
});

test("修订差异识别新增项目与变化的省级映射", () => {
  const diff = revisionDiff(catalog, "2026.1", "2026.2");
  assert.deepEqual(diff.added_items, ["N-TRAD-006"]);
  assert.ok(diff.changed_mappings.some((m) => m.id === "PM-003"));
  assert.ok(diff.affected_national_codes.includes("N-LAB-003"));
  assert.ok(diff.affected_national_codes.includes("N-TRAD-006"));
  // 未变化的直接映射不受影响
  assert.ok(!diff.affected_national_codes.includes("N-REHAB-001"));
});

test("仅闽省适配器受 PM-003 变化影响，浙省适配器不受影响", () => {
  const diff = revisionDiff(catalog, "2026.1", "2026.2");
  const fujian = scopeIsAffected(diff, ["闽"], [
    getVersion(catalog, "2026.1"),
    getVersion(catalog, "2026.2"),
  ]);
  const zhejiang = scopeIsAffected(diff, ["浙"], [
    getVersion(catalog, "2026.1"),
    getVersion(catalog, "2026.2"),
  ]);
  assert.equal(fujian.affected, true);
  assert.deepEqual(fujian.affected_codes.sort(), ["N-LAB-003", "N-TRAD-006"]);
  assert.equal(zhejiang.affected, false);
});
