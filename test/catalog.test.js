import assert from "node:assert/strict";
import test from "node:test";
import {
  loadCatalog,
  resolveMapping,
  checkMutex,
  diffVersions,
} from "../src/core/catalog.js";

const catalog = await loadCatalog("../../contracts/catalog_mapping.json");

test("一对多映射返回完整组合", () => {
  const r = resolveMapping(catalog, "2026.1", "N-REHAB-001", "闽", "2026-03-01");
  assert.equal(r.resolvable, true);
  assert.equal(r.mapping_type, "one_to_many");
  assert.deepEqual(r.province_codes, ["FJ-4402", "FJ-4403"]);
});

test("条件映射按业务事实分支", () => {
  const electro = resolveMapping(catalog, "2026.1", "N-ACU-010", "闽", "2026-03-01", { method: "electro" });
  assert.deepEqual(electro.province_codes, ["FJ-4611"]);
  const manual = resolveMapping(catalog, "2026.1", "N-ACU-010", "闽", "2026-03-01", { method: "manual" });
  assert.deepEqual(manual.province_codes, ["FJ-4610"]);
});

test("生效边界：valid_to 当天失效、前一天有效", () => {
  const before = resolveMapping(catalog, "2026.1", "N-NURS-002", "闽", "2026-06-30");
  assert.equal(before.resolvable, true);
  assert.deepEqual(before.province_codes, ["FJ-5101"]);
  const on = resolveMapping(catalog, "2026.1", "N-NURS-002", "闽", "2026-07-01");
  assert.equal(on.resolvable, true);
  assert.deepEqual(on.province_codes, ["FJ-5102"]); // 切换到新映射
});

test("生效日前一天不可映射、当天生效", () => {
  const before = resolveMapping(catalog, "2026.1", "N-REHAB-001", "闽", "2025-12-31");
  assert.equal(before.resolvable, false);
  const on = resolveMapping(catalog, "2026.1", "N-REHAB-001", "闽", "2026-01-01");
  assert.equal(on.resolvable, true);
});

test("撤销：撤销日前历史就诊仍可映射，撤销日起不可结算", () => {
  const history = resolveMapping(catalog, "2026.2", "N-OLD-008", "闽", "2026-06-30");
  assert.equal(history.resolvable, true);
  assert.deepEqual(history.province_codes, ["FJ-9001"]);
  const after = resolveMapping(catalog, "2026.2", "N-OLD-008", "闽", "2026-07-01");
  assert.equal(after.resolvable, false);
  assert.equal(after.reason, "withdrawn");
});

test("互斥组合被识别，单项目不误报", () => {
  const conflict = checkMutex(catalog, "2026.1", ["N-CONSULT-006", "N-CONSULT-007"]);
  assert.equal(conflict.violated, true);
  assert.deepEqual(conflict.conflict.sort(), ["N-CONSULT-006", "N-CONSULT-007"]);
  assert.equal(checkMutex(catalog, "2026.1", ["N-CONSULT-006"]).violated, false);
});

test("版本差异：2026.2 修改一对多组合并撤销旧项目", () => {
  const diff = diffVersions(catalog, "2026.1", "2026.2");
  const byId = Object.fromEntries(diff.affected.map((a) => [a.mapping_id, a.change]));
  assert.equal(byId.M01, "modified");
  assert.equal(byId.M06, "withdrawn");
  // 未变化的直通与条件映射不应进入复测范围。
  assert.equal(byId.M02, undefined);
  assert.equal(byId.M05, undefined);
});
