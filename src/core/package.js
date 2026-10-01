import { hashJson, sha8, canonicalJson } from "./crypto.js";
import { resolveMapping, getVersion } from "./catalog.js";

/**
 * 不可变测试包：
 * - 用例完全由目录内容确定性派生（无时间戳、无随机数），
 *   同一目录版本重复发布得到相同 package_id 与封存哈希。
 * - 覆盖：一对多组合、条件分支、互斥项目、生效边界、撤销、历史就诊日期。
 * - 期望结果由时态映射引擎计算并封存，医院侧只下发输入，不下发期望。
 * - 一旦登记泄露，该包永久封存，不能再用于发证。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function mappingCase(catalog, version, mapping, date, facts, category, critical, extra = {}) {
  const result = resolveMapping(
    catalog,
    version,
    mapping.national_code,
    mapping.province,
    date,
    facts
  );
  const expected = {
    resolvable: result.resolvable,
    province_codes: result.resolvable ? [...result.province_codes].sort() : [],
  };
  if (!result.resolvable) expected.reason = result.reason;
  return {
    case_id: `${category}:${mapping.id}:${date}${facts && facts.method ? `:${facts.method}` : ""}`,
    category,
    critical,
    input: {
      national_code: mapping.national_code,
      province: mapping.province,
      visit_date: date,
      ...(Object.keys(facts).length ? { facts } : {}),
      ...extra,
    },
    expected,
  };
}

/**
 * 依据目录版本确定性生成用例集。
 */
export function generateCases(catalog, version) {
  const ver = getVersion(catalog, version);
  const cases = [];
  const seen = new Set();
  const push = (c) => {
    if (seen.has(c.case_id)) throw new Error(`用例标识冲突: ${c.case_id}`);
    seen.add(c.case_id);
    cases.push(c);
  };

  for (const m of ver.mappings) {
    // 生效期内的普通日期，用来表达一对多组合、条件分支与一般直通。
    const inRange = m.valid_from
      ? (m.status === "withdrawn" && m.valid_to ? addDays(m.valid_to, -1) : addDays(m.valid_from, 30))
      : "2026-03-01";

    if (m.mapping_type === "one_to_many") {
      push(mappingCase(catalog, version, m, inRange, {}, "one_to_many", true));
    } else if (m.mapping_type === "conditional") {
      push(mappingCase(catalog, version, m, inRange, { method: "electro" }, "conditional", true));
      push(mappingCase(catalog, version, m, inRange, { method: "manual" }, "conditional", true));
    } else if (m.status !== "withdrawn") {
      push(mappingCase(catalog, version, m, inRange, {}, "general", false));
    }

    // 生效边界：生效日前一天 / 生效日当天；失效日前一天 / 失效日当天。
    if (m.valid_from) {
      push(mappingCase(catalog, version, m, addDays(m.valid_from, -1), {}, "boundary", true));
      push(mappingCase(catalog, version, m, m.valid_from, {}, "boundary", true));
    }
    if (m.valid_to) {
      push(mappingCase(catalog, version, m, addDays(m.valid_to, -1), {}, "boundary", true));
      push(mappingCase(catalog, version, m, m.valid_to, {}, "boundary", true));
    }

    // 撤销：撤销日前一天的历史就诊仍可映射，撤销日起不可结算。
    if (m.status === "withdrawn") {
      push(mappingCase(catalog, version, m, addDays(m.valid_to ?? m.withdrawn_on, -1), {}, "withdrawal", true));
      push(mappingCase(catalog, version, m, m.withdrawn_on ?? m.valid_to, {}, "withdrawal", true));
    }
  }

  // 历史就诊日期：明确取一段已过去但仍在旧规则有效期内的日期。
  const historical = ver.mappings.find((m) => m.id === "M03");
  if (historical) {
    push(mappingCase(catalog, version, historical, "2026-03-15", {}, "historical", true));
  }

  // 互斥项目：冲突组合必须被识别；单一项目不得误报。
  for (const group of ver.mutex_groups ?? []) {
    const visitDate = "2026-03-15";
    const province = "闽";
    push({
      case_id: `mutex:${group.id}:conflict`,
      category: "mutex",
      critical: true,
      input: { province, visit_date: visitDate, national_codes: [...group.members] },
      expected: { mutex_violated: true, group_id: group.id, conflict: [...group.members].sort() },
    });
    push({
      case_id: `mutex:${group.id}:single`,
      category: "mutex",
      critical: false,
      input: { province, visit_date: visitDate, national_codes: [group.members[0]] },
      expected: { mutex_violated: false },
    });
  }

  return cases;
}

/**
 * 发布（或取回）某目录版本的不可变测试包。
 * @param catalogHash 目录文件内容哈希，记入封存，绑定目录版本字节。
 */
export async function buildPackage(catalog, version, catalogHash) {
  const cases = generateCases(catalog, version);
  const body = {
    catalog_version: version,
    catalog_hash: catalogHash,
    coverage: ["one_to_many", "conditional", "mutex", "boundary", "withdrawal", "historical"],
    cases,
  };
  const packageHash = await hashJson(body);
  return {
    package_id: `pkg-${await sha8(canonicalJson(body))}`,
    package_hash: packageHash,
    immutable: true,
    ...body,
  };
}

/** 医院侧视图：只包含输入，不包含权威期望与封存哈希以外的答案。 */
export function hospitalView(pkg) {
  return {
    package_id: pkg.package_id,
    catalog_version: pkg.catalog_version,
    immutable: pkg.immutable,
    cases: pkg.cases.map(({ case_id, category, critical, input }) => ({
      case_id,
      category,
      critical,
      input,
    })),
  };
}
