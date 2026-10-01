import { sha256, stableStringify } from "./crypto.js";
import { isWithin, isValidDate } from "./time.js";

export const MAPPING_TYPES = ["direct", "one_to_many", "conditional"];

/**
 * 校验目录文件结构。目录是测试包与证书的唯一事实来源，加载时必须完整合法。
 */
export function validateCatalog(data) {
  if (!data || data.service !== "medical-service-catalog") {
    throw new Error("目录服务标识不匹配");
  }
  if (!Array.isArray(data.catalog_versions) || data.catalog_versions.length === 0) {
    throw new Error("目录缺少 catalog_versions");
  }
  const seen = new Set();
  for (const version of data.catalog_versions) {
    if (!version.version || seen.has(version.version)) {
      throw new Error(`目录版本缺失或重复: ${version.version}`);
    }
    seen.add(version.version);
    if (!isValidDate(version.published_at)) {
      throw new Error(`目录版本 ${version.version} 发布日期非法`);
    }
    for (const item of version.national_items ?? []) {
      if (!item.code || !item.name) throw new Error("国家项目代码或名称缺失");
      if (!isValidDate(item.valid_from)) throw new Error(`国家项目 ${item.code} 生效日非法`);
      if (item.valid_until !== null && !isValidDate(item.valid_until)) {
        throw new Error(`国家项目 ${item.code} 失效日非法`);
      }
      if (!["active", "revoked"].includes(item.status)) {
        throw new Error(`国家项目 ${item.code} 状态非法`);
      }
    }
    const mappingIds = new Set();
    for (const mapping of version.province_mappings ?? []) {
      if (!mapping.id || mappingIds.has(mapping.id)) {
        throw new Error(`省级映射缺失或重复: ${mapping.id}`);
      }
      mappingIds.add(mapping.id);
      if (!mapping.national_code || !mapping.province) {
        throw new Error(`映射 ${mapping.id} 缺少国家代码或省份`);
      }
      if (!MAPPING_TYPES.includes(mapping.mapping_type)) {
        throw new Error(`映射 ${mapping.id} 类型非法: ${mapping.mapping_type}`);
      }
      if (!Array.isArray(mapping.province_codes) || mapping.province_codes.length === 0) {
        throw new Error(`映射 ${mapping.id} 缺少省级代码`);
      }
      if (!isValidDate(mapping.valid_from)) throw new Error(`映射 ${mapping.id} 生效日非法`);
      if (mapping.valid_until !== null && !isValidDate(mapping.valid_until)) {
        throw new Error(`映射 ${mapping.id} 失效日非法`);
      }
      if (!["active", "revoked"].includes(mapping.status)) {
        throw new Error(`映射 ${mapping.id} 状态非法`);
      }
    }
  }
  return true;
}

export function getVersion(catalog, version) {
  const found = catalog.catalog_versions.find((v) => v.version === version);
  if (!found) throw new Error(`未知目录版本: ${version}`);
  return found;
}

export function latestVersion(catalog) {
  return catalog.catalog_versions[catalog.catalog_versions.length - 1].version;
}

/** 目录版本指纹：国家项目与省级映射的规范化哈希，进入测试包与证书。 */
export function versionHash(catalogVersion) {
  const body = {
    version: catalogVersion.version,
    national_items: (catalogVersion.national_items ?? []).map((item) => ({
      code: item.code,
      name: item.name,
      category: item.category,
      valid_from: item.valid_from,
      valid_until: item.valid_until,
      status: item.status,
    })),
    province_mappings: (catalogVersion.province_mappings ?? []).map((mapping) => ({
      id: mapping.id,
      national_code: mapping.national_code,
      province: mapping.province,
      mapping_type: mapping.mapping_type,
      province_codes: mapping.province_codes,
      branches: mapping.branches ?? null,
      mutex_group: mapping.mutex_group ?? null,
      valid_from: mapping.valid_from,
      valid_until: mapping.valid_until,
      status: mapping.status,
    })),
  };
  return sha256(stableStringify(body));
}

export function mappingsForProvince(catalogVersion, province) {
  return (catalogVersion.province_mappings ?? []).filter((m) => m.province === province);
}

/** 就诊日期下有效（生效区间内且未撤销）的映射；撤销项在区间外不再可用。 */
export function effectiveMappings(catalogVersion, date) {
  return (catalogVersion.province_mappings ?? []).filter(
    (m) => m.status === "active" && isWithin(date, m.valid_from, m.valid_until),
  );
}

function byId(list) {
  return new Map(list.map((x) => [x.id ?? x.code, x]));
}

function itemKey(item) {
  return stableStringify({
    code: item.code,
    name: item.name,
    category: item.category,
    valid_from: item.valid_from,
    valid_until: item.valid_until,
    status: item.status,
  });
}

function mappingKey(item) {
  return stableStringify({
    national_code: item.national_code,
    province: item.province,
    mapping_type: item.mapping_type,
    province_codes: item.province_codes,
    branches: item.branches ?? null,
    mutex_group: item.mutex_group ?? null,
    valid_from: item.valid_from,
    valid_until: item.valid_until,
    status: item.status,
  });
}

/**
 * 目录修订差异。返回受影响的国家代码（项目本身变化或任一省级映射变化），
 * 以及按省份可直接定位到适配器的映射级变化。
 */
export function revisionDiff(catalog, fromVersion, toVersion) {
  const a = getVersion(catalog, fromVersion);
  const b = getVersion(catalog, toVersion);
  const itemsA = byId(a.national_items);
  const itemsB = byId(b.national_items);
  const mapsA = byId(a.province_mappings);
  const mapsB = byId(b.province_mappings);

  const addedItems = [];
  const removedItems = [];
  const changedItems = [];
  for (const [code, itemB] of itemsB) {
    const itemA = itemsA.get(code);
    if (!itemA) addedItems.push(code);
    else if (itemKey(itemA) !== itemKey(itemB)) changedItems.push(code);
  }
  for (const code of itemsA.keys()) if (!itemsB.has(code)) removedItems.push(code);

  const addedMappings = [];
  const removedMappings = [];
  const changedMappings = [];
  for (const [id, mB] of mapsB) {
    const mA = mapsA.get(id);
    if (!mA) addedMappings.push({ id, province: mB.province, national_code: mB.national_code });
    else if (mappingKey(mA) !== mappingKey(mB)) {
      changedMappings.push({ id, province: mB.province, national_code: mB.national_code });
    }
  }
  for (const [id, mA] of mapsA) {
    if (!mapsB.has(id)) {
      removedMappings.push({ id, province: mA.province, national_code: mA.national_code });
    }
  }

  const affectedNationalCodes = new Set([
    ...addedItems,
    ...removedItems,
    ...changedItems,
    ...addedMappings.map((m) => m.national_code),
    ...removedMappings.map((m) => m.national_code),
    ...changedMappings.map((m) => m.national_code),
  ]);

  return {
    from_version: fromVersion,
    to_version: toVersion,
    added_items: addedItems,
    removed_items: removedItems,
    changed_items: changedItems,
    added_mappings: addedMappings,
    removed_mappings: removedMappings,
    changed_mappings: changedMappings,
    affected_national_codes: [...affectedNationalCodes].sort(),
  };
}

/**
 * 适配器登记范围（省份）在修订中是否受影响：
 * 省级映射变化只影响登记了对应省份的适配器；
 * 国家项目变化仅当该项目在范围内省份存在（或曾存在）映射时才影响该适配器。
 */
export function scopeIsAffected(diff, scopeProvinces, versions = null) {
  const provinces = new Set(scopeProvinces);
  const codes = new Set();
  for (const m of [
    ...diff.added_mappings,
    ...diff.removed_mappings,
    ...diff.changed_mappings,
  ]) {
    if (provinces.has(m.province)) codes.add(m.national_code);
  }
  const itemCodes = [
    ...diff.added_items,
    ...diff.removed_items,
    ...diff.changed_items,
  ];
  if (versions) {
    const scopedCodes = new Set();
    for (const v of versions) {
      for (const m of v.province_mappings ?? []) {
        if (provinces.has(m.province)) scopedCodes.add(m.national_code);
      }
    }
    for (const code of itemCodes) if (scopedCodes.has(code)) codes.add(code);
  } else {
    for (const code of itemCodes) codes.add(code);
  }
  const affectedCodes = [...codes].sort();
  return { affected: affectedCodes.length > 0, affected_codes: affectedCodes };
}
