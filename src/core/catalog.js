import { readFile } from "node:fs/promises";

/**
 * 时态映射引擎：给定目录版本、国家项目、省份、就诊日期与业务事实，
 * 给出适配器应当输出的省级代码集合（权威期望结果）。
 *
 * 边界规则：valid_from <= 就诊日期 < valid_to（valid_to 为空表示长期有效）。
 * 撤销项目在撤销日及以后不可结算，但撤销日前的历史就诊仍按原规则映射。
 */

export async function loadCatalog(fileUrl) {
  const raw = await readFile(new URL(fileUrl, import.meta.url), "utf8");
  const doc = JSON.parse(raw);
  return doc.catalog;
}

export function listVersions(catalog) {
  return Object.keys(catalog.versions).sort();
}

export function getVersion(catalog, version) {
  const v = catalog.versions[version];
  if (!v) throw new Error(`未知目录版本: ${version}`);
  return v;
}

function activeOn(mapping, date) {
  if (mapping.valid_from && date < mapping.valid_from) return false;
  if (mapping.valid_to && date >= mapping.valid_to) return false;
  return true;
}

function pickConditionalCodes(mapping, facts) {
  for (const branch of mapping.branches ?? []) {
    if (branch.default) return [...branch.province_codes];
    const { fact, equals } = branch.when ?? {};
    if (fact && facts && String(facts[fact]) === String(equals)) {
      return [...branch.province_codes];
    }
  }
  return null;
}

/**
 * @returns {{ resolvable: boolean, mapping_id?: string, mapping_type?: string,
 *            province_codes?: string[], reason?: string }}
 */
export function resolveMapping(catalog, version, nationalCode, province, date, facts = {}) {
  const ver = getVersion(catalog, version);
  const hit = ver.mappings.find(
    (m) =>
      m.national_code === nationalCode &&
      m.province === province &&
      activeOn(m, date)
  );
  if (!hit) {
    const any = ver.mappings.find(
      (m) => m.national_code === nationalCode && m.province === province
    );
    if (!any) return { resolvable: false, reason: "no_mapping" };
    if (any.status === "withdrawn" && date >= (any.valid_to ?? any.withdrawn_on ?? "9999")) {
      return { resolvable: false, reason: "withdrawn" };
    }
    return { resolvable: false, reason: "outside_validity" };
  }

  if (hit.mapping_type === "conditional") {
    const codes = pickConditionalCodes(hit, facts);
    if (!codes) return { resolvable: false, mapping_id: hit.id, reason: "no_branch_matched" };
    return { resolvable: true, mapping_id: hit.id, mapping_type: hit.mapping_type, province_codes: codes };
  }

  return {
    resolvable: true,
    mapping_id: hit.id,
    mapping_type: hit.mapping_type,
    province_codes: [...(hit.province_codes ?? [])],
  };
}

/** 返回该国家项目所属互斥组；不在任何组中返回 null。 */
export function mutexGroupOf(catalog, version, nationalCode) {
  const ver = getVersion(catalog, version);
  for (const group of ver.mutex_groups ?? []) {
    if (group.members.includes(nationalCode)) return group;
  }
  return null;
}

/**
 * 校验同次就诊中国家项目组合是否违反互斥规则。
 * @param {string[]} nationalCodes 同一次就诊出现的国家项目代码
 * @returns {{ violated: boolean, group?: object, conflict?: string[] }}
 */
export function checkMutex(catalog, version, nationalCodes) {
  const ver = getVersion(catalog, version);
  const seen = new Set(nationalCodes);
  for (const group of ver.mutex_groups ?? []) {
    const conflict = group.members.filter((code) => seen.has(code));
    if (conflict.length > 1) return { violated: true, group, conflict };
  }
  return { violated: false };
}

/**
 * 目录修订影响分析：对比两个版本，返回发生变化的映射坐标。
 * 坐标 = national_code + province（适配器按此实现转换规则）。
 * 用于"仅受影响适配器进入复测"。
 */
export function diffVersions(catalog, fromVersion, toVersion) {
  const from = getVersion(catalog, fromVersion).mappings;
  const to = getVersion(catalog, toVersion).mappings;
  const key = (m) => `${m.national_code}|${m.province}`;
  const fromMap = new Map(from.map((m) => [m.id, m]));
  const toMap = new Map(to.map((m) => [m.id, m]));
  const affected = [];

  for (const [id, next] of toMap) {
    const prev = fromMap.get(id);
    if (!prev) {
      affected.push({ mapping_id: id, coordinate: key(next), change: "added" });
      continue;
    }
    const codeSet = (m) =>
      m.mapping_type === "conditional"
        ? (m.branches ?? []).map((b) => (b.province_codes ?? []).slice().sort().join(",")).join("|")
        : (m.province_codes ?? []).slice().sort().join(",");
    const changed =
      prev.mapping_type !== next.mapping_type ||
      codeSet(prev) !== codeSet(next) ||
      prev.valid_from !== next.valid_from ||
      prev.valid_to !== next.valid_to ||
      prev.status !== next.status;
    if (changed) {
      affected.push({
        mapping_id: id,
        coordinate: key(next),
        change:
          prev.status !== "withdrawn" && next.status === "withdrawn"
            ? "withdrawn"
            : "modified",
      });
    }
  }
  for (const [id, prev] of fromMap) {
    if (!toMap.has(id)) {
      affected.push({ mapping_id: id, coordinate: key(prev), change: "removed" });
    }
  }
  return { from: fromVersion, to: toVersion, affected };
}
