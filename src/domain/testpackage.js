import { sha256, stableStringify, shortId } from "./crypto.js";
import { shiftDays } from "./time.js";

/**
 * 测试包（不可变）：
 * 由经办机构依据某一目录版本为指定省份生成，五类关键用例覆盖
 * 一对多组合、互斥项目、生效边界、撤销与历史就诊日期。
 *
 * 测试包只含合成测试数据，绝不含真实患者账单。
 */

/**
 * 逐映射生成关键用例。idFactory 在每次生成时重置，
 * 使同一目录版本+省份产出字节一致的用例集。
 */
function expected(codes, { accepted = true, reason = null } = {}) {
  return { accepted, expected_province_codes: [...codes].sort(), reason };
}

export function generateCases(catalogVersion, province) {
  const cases = [];
  const mappings = (catalogVersion.province_mappings ?? []).filter(
    (m) => m.province === province,
  );
  let sequence = 0;
  const caseId = () => {
    sequence += 1;
    return `TC-${String(sequence).padStart(4, "0")}`;
  };

  for (const m of mappings) {
    const base = {
      national_code: m.national_code,
      province,
      mapping_id: m.id,
      critical: true,
    };

    if (m.mapping_type === "one_to_many") {
      // 一对多组合：适配器必须展开为全部组成代码，缺一、多一都会在比对中失败。
      cases.push({
        ...base,
        case_id: caseId(),
        category: "one_to_many",
        description: `${m.national_code} 一对多组合应展开为全部省级代码`,
        input: { national_code: m.national_code, encounter_date: m.valid_from },
        expected: expected(m.province_codes),
      });
    } else if (m.mapping_type === "conditional") {
      for (const branch of m.branches ?? []) {
        cases.push({
          ...base,
          case_id: caseId(),
          category: "conditional",
          description: `${m.national_code} 条件分支 ${JSON.stringify(branch.when)}`,
          input: {
            national_code: m.national_code,
            encounter_date: m.valid_from,
            attributes: branch.when,
          },
          expected: expected(branch.codes),
        });
      }
    } else if (m.mapping_type === "direct") {
      cases.push({
        ...base,
        case_id: caseId(),
        category: "direct",
        description: `${m.national_code} 直接映射`,
        input: { national_code: m.national_code, encounter_date: m.valid_from },
        expected: expected(m.province_codes),
      });
    }

    // 生效边界：生效首日、失效末日（区间内）必须接受；失效次日必须拒绝。
    if (m.valid_from) {
      cases.push({
        ...base,
        case_id: caseId(),
        category: "effective_boundary",
        description: `${m.id} 生效首日边界`,
        input: { national_code: m.national_code, encounter_date: m.valid_from },
        expected: expected(m.province_codes),
      });
      const before = shiftDays(m.valid_from, -1);
      cases.push({
        ...base,
        case_id: caseId(),
        category: "effective_boundary",
        description: `${m.id} 生效前一日不得使用`,
        input: { national_code: m.national_code, encounter_date: before },
        expected: { accepted: false, expected_province_codes: [], reason: "out_of_effective_range" },
      });
    }
    if (m.valid_until) {
      cases.push({
        ...base,
        case_id: caseId(),
        category: "effective_boundary",
        description: `${m.id} 失效末日边界（当日仍有效）`,
        input: { national_code: m.national_code, encounter_date: m.valid_until },
        expected: expected(m.province_codes),
      });
      // 已撤销映射：失效次日的拒绝语义统一归入 revocation 类别（reason=revoked），
      // 避免同一输入出现两种互斥的期望原因。
      if (m.status !== "revoked") {
        cases.push({
          ...base,
          case_id: caseId(),
          category: "effective_boundary",
          description: `${m.id} 失效次日必须拒绝`,
          input: { national_code: m.national_code, encounter_date: shiftDays(m.valid_until, 1) },
          expected: { accepted: false, expected_province_codes: [], reason: "out_of_effective_range" },
        });
      }
    }

    // 撤销与历史就诊日期：撤销日后的就诊拒绝；撤销前区间内的历史就诊仍按当时映射。
    if (m.status === "revoked") {
      const after = shiftDays(m.valid_until ?? m.valid_from, 1);
      cases.push({
        ...base,
        case_id: caseId(),
        category: "revocation",
        description: `${m.id} 已撤销，撤销日后的就诊不得映射`,
        input: { national_code: m.national_code, encounter_date: after },
        expected: { accepted: false, expected_province_codes: [], reason: "revoked" },
      });
      const historicalDate = m.valid_until
        ? shiftDays(m.valid_until, -30)
        : m.valid_from;
      cases.push({
        ...base,
        case_id: caseId(),
        category: "historical_encounter",
        description: `${m.id} 历史就诊（撤销前）按当时有效映射处理`,
        input: { national_code: m.national_code, encounter_date: historicalDate },
        expected: expected(m.province_codes, { reason: "historical" }),
      });
    }
  }

  // 互斥项目：同一互斥组在同一就诊中不得同时出现。
  const groups = new Map();
  for (const m of mappings.filter((x) => x.mutex_group)) {
    if (!groups.has(m.mutex_group)) groups.set(m.mutex_group, []);
    groups.get(m.mutex_group).push(m);
  }
  for (const [group, members] of groups) {
    if (members.length < 2) continue;
    cases.push({
      case_id: caseId(),
      category: "mutex",
      critical: true,
      description: `互斥组 ${group} 不得同时计费 ${members.map((x) => x.national_code).join("、")}`,
      input: {
        encounter_date: members[0].valid_from,
        items: members.map((x) => x.national_code),
      },
      expected: { accepted: false, reason: "mutex_violation", mutex_group: group },
    });
    cases.push({
      case_id: caseId(),
      category: "mutex",
      critical: true,
      description: `互斥组 ${group} 单独使用任一项应正常`,
      input: {
        encounter_date: members[0].valid_from,
        items: [members[0].national_code],
      },
      expected: { accepted: true, reason: null },
    });
  }

  return cases;
}

/**
 * 生成并密封测试包。catalog_hash 与 cases_hash 进入封皮，
 * 发布后任何人修改用例都会导致封皮签名校验失败。
 * package_id 由发布方按（目录版本, 省份）确定性派生，保证重复发布字节一致。
 */
export function sealTestPackage({ packageId, catalogVersion, catalogHash, province, issuedAt }) {
  const cases = generateCases(catalogVersion, province);
  const casesHash = sha256(stableStringify(cases));
  const packageIdFinal = packageId ?? shortId("PKG-");
  const body = {
    package_id: packageIdFinal,
    schema: "adapter-conformance-pack/1",
    catalog_version: catalogVersion.version,
    province,
    issued_at: issuedAt,
    synthetic: true,
    notice: "本测试包仅含合成数据，用于适配认证，不得用于真实患者账单。",
    cases,
  };
  const envelope = {
    package_id: packageIdFinal,
    catalog_version: catalogVersion.version,
    catalog_hash: catalogHash,
    province,
    issued_at: issuedAt,
    cases_hash: casesHash,
    case_count: cases.length,
    body,
  };
  envelope.package_hash = sha256(stableStringify(envelope));
  return envelope;
}

/** 校验测试包完整性：重算用例与包哈希，任何篡改都会失败。 */
export function verifyPackageIntegrity(envelope) {
  const casesHash = sha256(stableStringify(envelope.body.cases));
  if (casesHash !== envelope.cases_hash) {
    return { ok: false, reason: "cases_hash_mismatch" };
  }
  const { package_hash, authority_signature, ...rest } = envelope;
  if (sha256(stableStringify(rest)) !== package_hash) {
    return { ok: false, reason: "package_hash_mismatch" };
  }
  return { ok: true };
}

/** 分发副本：每份带机构专属水印（不改变包体与包哈希），用于泄露溯源。 */
export function watermarkedCopy(envelope, orgId) {
  return {
    package_id: envelope.package_id,
    package_hash: envelope.package_hash,
    watermark: sha256(`watermark:${envelope.package_id}:${orgId}`),
    org_id: orgId,
  };
}
