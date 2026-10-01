import assert from "node:assert/strict";
import test from "node:test";
import { generateCases, buildPackage, hospitalView } from "../src/core/package.js";
import { loadCatalog } from "../src/core/catalog.js";

const catalog = await loadCatalog("../../contracts/catalog_mapping.json");

test("用例覆盖六类关键场景", () => {
  const cases = generateCases(catalog, "2026.2");
  const categories = new Set(cases.map((c) => c.category));
  for (const c of ["one_to_many", "conditional", "mutex", "boundary", "withdrawal", "historical"]) {
    assert.ok(categories.has(c), `缺少类别 ${c}`);
  }
});

test("同一目录版本生成的测试包完全一致（不可变）", async () => {
  const a = await buildPackage(catalog, "2026.2", "hashA");
  const b = await buildPackage(catalog, "2026.2", "hashA");
  assert.equal(a.package_id, b.package_id);
  assert.equal(a.package_hash, b.package_hash);
});

test("目录内容哈希变化会改变封存身份", async () => {
  const a = await buildPackage(catalog, "2026.2", "hashA");
  const b = await buildPackage(catalog, "2026.2", "hashB");
  assert.notEqual(a.package_hash, b.package_hash);
});

test("医院视图不含权威期望", () => {
  const pkg = {
    package_id: "pkg-x",
    catalog_version: "2026.2",
    immutable: true,
    cases: [
      {
        case_id: "c1",
        category: "boundary",
        critical: true,
        input: { national_code: "N" },
        expected: { resolvable: true, province_codes: ["X"] },
      },
    ],
  };
  const view = hospitalView(pkg);
  assert.equal(view.cases[0].expected, undefined);
  assert.deepEqual(view.cases[0].input, { national_code: "N" });
});
