import {
  canonicalJson,
  hashJson,
  randomId,
  sha8,
  verifyDetached,
} from "./crypto.js";
import { buildPackage, hospitalView } from "./package.js";
import { diffVersions } from "./catalog.js";

/**
 * 适配认证领域服务。
 * 只判定兼容性：输入来自封存测试包，期望由目录与映射引擎派生；
 * 不接触任何真实患者账单数据。
 */

const WAIVER_MAX_DAYS = 180;

export class CertificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function requireActor(actor, role) {
  if (!actor) throw new CertificationError("unauthorized", "缺少调用身份");
  if (role && actor.role !== role) {
    throw new CertificationError("forbidden", `需要 ${role} 身份`);
  }
}

function normalizeCodes(codes) {
  return [...new Set(codes ?? [])].map(String).sort();
}

function answerMatchesExpected(answer, expected) {
  if (typeof expected.mutex_violated === "boolean") {
    if (Boolean(answer?.mutex_violated) !== expected.mutex_violated) return false;
    if (expected.mutex_violated) {
      if (expected.group_id && answer.group_id !== expected.group_id) return false;
      if (
        expected.conflict &&
        canonicalJson(normalizeCodes(answer.conflict)) !==
          canonicalJson(normalizeCodes(expected.conflict))
      ) {
        return false;
      }
    }
    return true;
  }
  if (Boolean(answer?.resolvable) !== Boolean(expected.resolvable)) return false;
  if (!expected.resolvable) {
    // 不可映射场景：原因码也要一致（撤销 / 超出有效期 / 无映射）。
    return !expected.reason || answer.reason === expected.reason;
  }
  return (
    canonicalJson(normalizeCodes(answer?.province_codes)) ===
    canonicalJson(normalizeCodes(expected.province_codes))
  );
}

export class CertificationService {
  constructor({ store, catalog, catalogHash, clock = () => new Date().toISOString() }) {
    this.store = store;
    this.catalog = catalog;
    this.catalogHash = catalogHash;
    this.clock = clock;
  }

  // ---------- 测试包 ----------

  /** 经办机构发布（或幂等取回）不可变测试包并完整归档。 */
  async publishPackage(actor, version) {
    requireActor(actor, "agency");
    const data = this.store.read();
    const existing = Object.values(data.packages).find(
      (p) => p.catalog_version === version
    );
    if (existing) {
      return { package: existing, created: false };
    }
    const pkg = await buildPackage(this.catalog, version, this.catalogHash);
    await this.store.mutate((d) => {
      d.packages[pkg.package_id] = {
        ...pkg,
        published_at: this.clock(),
        published_by: actor.subject,
        leaked: false,
      };
    });
    return { package: this.store.read().packages[pkg.package_id], created: true };
  }

  getPackage(actor, packageId) {
    requireActor(actor);
    const pkg = this.store.read().packages[packageId];
    if (!pkg) throw new CertificationError("not_found", "测试包不存在");
    // 医院只能看到输入视图，期望结果与封存内容不下发。
    return actor.role === "hospital" ? hospitalView(pkg) : pkg;
  }

  /** 登记泄露：该包永久封存，阻止其后一切发证。 */
  async markPackageLeaked(actor, packageId, reason) {
    requireActor(actor, "agency");
    return this.store.mutate((d) => {
      const pkg = d.packages[packageId];
      if (!pkg) throw new CertificationError("not_found", "测试包不存在");
      pkg.leaked = true;
      pkg.leaked_at = this.clock();
      pkg.leak_reason = reason;
      return pkg;
    });
  }

  // ---------- 医院登记 ----------

  async registerAdapter(actor, input) {
    requireActor(actor, "hospital");
    const {
      software_name,
      software_version,
      build_hash,
      rule_set,
      environment_fingerprint,
      covered_coordinates,
      signing_public_jwk,
      isolated_environment,
    } = input;

    if (!software_name || !software_version || !build_hash) {
      throw new CertificationError("invalid_input", "缺少软件名称、版本或构建哈希");
    }
    if (!environment_fingerprint) {
      throw new CertificationError("invalid_input", "缺少隔离环境指纹");
    }
    if (!signing_public_jwk) {
      throw new CertificationError("invalid_input", "缺少提交签名公钥");
    }
    if (isolated_environment !== true) {
      throw new CertificationError(
        "invalid_input",
        "必须声明在隔离环境中执行测试"
      );
    }
    if (!Array.isArray(covered_coordinates) || covered_coordinates.length === 0) {
      throw new CertificationError("invalid_input", "必须登记转换规则覆盖坐标");
    }

    const data = this.store.read();
    // 同一机构同一软件版本+构建只能登记一次（重复登记返回原记录）。
    const dup = Object.values(data.registrations).find(
      (r) =>
        r.institution_id === actor.institution_id &&
        r.software_name === software_name &&
        r.software_version === software_version &&
        r.build_hash === build_hash
    );
    if (dup) return { registration: dup, created: false };

    const ruleSetHash = await hashJson(rule_set ?? {});
    const registration = {
      registration_id: await randomId("reg"),
      institution_id: actor.institution_id,
      software_name,
      software_version,
      build_hash,
      rule_set,
      rule_set_hash: ruleSetHash,
      covered_coordinates: [...new Set(covered_coordinates)].sort(),
      environment_fingerprint,
      isolated_environment: true,
      signing_public_jwk,
      signer_key_id: await sha8(canonicalJson(signing_public_jwk)),
      created_at: this.clock(),
    };
    await this.store.mutate((d) => {
      d.registrations[registration.registration_id] = registration;
    });
    return { registration, reissued: true };
  }

  #getRegistrationScoped(actor, registrationId, { write } = { write: false }) {
    const reg = this.store.read().registrations[registrationId];
    if (!reg) throw new CertificationError("not_found", "登记不存在");
    if (actor.role === "hospital" && reg.institution_id !== actor.institution_id) {
      // 医院看不到其他机构的实现：直接当作不存在，避免存在性泄露。
      throw new CertificationError("not_found", "登记不存在");
    }
    return reg;
  }

  // ---------- 提交与判定 ----------

  /**
   * 隔离环境提交：逐例输出 + 日志指纹 + 签名声明。
   * 字节相同的重复上传直接返回原认证结果。
   */
  async submit(actor, input) {
    requireActor(actor, "hospital");
    const {
      registration_id,
      package_id,
      answers,
      log_fingerprint,
      environment_fingerprint,
      signature,
    } = input;

    const reg = this.#getRegistrationScoped(actor, registration_id);
    const data = this.store.read();
    const pkg = data.packages[package_id];
    if (!pkg) throw new CertificationError("not_found", "测试包不存在");
    if (!Array.isArray(answers) || answers.length === 0) {
      throw new CertificationError("invalid_input", "缺少逐例输出");
    }

    // 签名声明必须覆盖整份提交的规范化字节，且来自登记公钥。
    const signedBody = {
      registration_id,
      package_id,
      answers,
      log_fingerprint: log_fingerprint ?? null,
      environment_fingerprint: environment_fingerprint ?? null,
    };
    const signatureBase = canonicalJson(signedBody);
    const signatureValid = await verifyDetached(
      reg.signing_public_jwk,
      signature,
      signatureBase
    );

    // 逐例比对封存期望。
    const caseMap = new Map(pkg.cases.map((c) => [c.case_id, c]));
    const answerMap = new Map(
      answers.map((a) => [a.case_id, a.output ?? a])
    );
    const caseVerdicts = pkg.cases.map((c) => {
      const answer = answerMap.get(c.case_id);
      const provided = Boolean(answer);
      const matches = provided && answerMatchesExpected(answer, c.expected);
      return {
        case_id: c.case_id,
        category: c.category,
        critical: c.critical,
        provided,
        matches,
      };
    });
    const failedCritical = caseVerdicts.filter(
      (v) => v.critical && !v.matches
    );
    const failedNonCritical = caseVerdicts.filter(
      (v) => !v.critical && !v.matches
    );

    // 阻断项（任一成立即不得发证）。
    const block_reasons = [];
    if (pkg.leaked) block_reasons.push("package_leaked");
    if (environment_fingerprint !== reg.environment_fingerprint) {
      block_reasons.push("environment_changed");
    }
    if (!signatureValid) block_reasons.push("invalid_signature");
    if (failedCritical.length > 0) block_reasons.push("critical_cases_failed");

    const decision =
      block_reasons.length > 0
        ? "rejected"
        : failedNonCritical.length > 0
          ? "blocked_pending_waiver"
          : "passed";

    const contentHash = await hashJson(signedBody);
    const result = {
      result_id: await randomId("rsl"),
      registration_id,
      institution_id: reg.institution_id,
      package_id,
      package_hash: pkg.package_hash,
      catalog_version: pkg.catalog_version,
      catalog_hash: pkg.catalog_hash,
      submitted_at: this.clock(),
      submission_hash: contentHash,
      log_fingerprint: log_fingerprint ?? null,
      environment_fingerprint: environment_fingerprint ?? null,
      signature_valid: signatureValid,
      package_leaked: pkg.leaked,
      case_verdicts: caseVerdicts,
      failed_case_ids: [...failedCritical, ...failedNonCritical].map((v) => v.case_id),
      failed_non_critical_case_ids: failedNonCritical.map((v) => v.case_id),
      failed_critical_case_ids: failedCritical.map((v) => v.case_id),
      block_reasons,
      decision,
    };

    return this.store.mutate(async (d) => {
      // 幂等：同一登记+同一字节内容 → 返回原结果，不产生新判定。
      const replay = Object.values(d.results).find(
        (r) =>
          r.registration_id === registration_id &&
          r.submission_hash === contentHash
      );
      if (replay) return { result: replay, idempotent_replay: true };

      d.results[result.result_id] = result;

      if (decision === "passed") {
        // 全部通过：立即发证。
        const cert = await this.#buildCertificate(d, reg, pkg, result, []);
        d.certificates[cert.cert_id] = cert;
        result.certificate_id = cert.cert_id;
      }
      return { result, idempotent_replay: false };
    });
  }

  getResult(actor, resultId) {
    requireActor(actor);
    const result = this.store.read().results[resultId];
    if (!result) throw new CertificationError("not_found", "结果不存在");
    if (
      actor.role === "hospital" &&
      result.institution_id !== actor.institution_id
    ) {
      throw new CertificationError("not_found", "结果不存在");
    }
    return result;
  }

  // ---------- 人工豁免 ----------

  /**
   * 经办机构人工豁免：必须限定机构、版本、期限并附整改计划。
   * 只允许覆盖最近一次判定中的非关键失败用例；关键用例不可豁免。
   */
  async grantWaiver(actor, input) {
    requireActor(actor, "agency");
    const {
      registration_id,
      case_ids,
      valid_from,
      valid_to,
      remediation_plan,
    } = input;
    const reg = this.#getRegistrationScoped(actor, registration_id);

    if (!Array.isArray(case_ids) || case_ids.length === 0) {
      throw new CertificationError("invalid_input", "豁免必须列明用例");
    }
    if (!valid_from || !valid_to || valid_to <= valid_from) {
      throw new CertificationError("invalid_input", "豁免必须给出有效起止期限");
    }
    const spanDays =
      (new Date(`${valid_to}T00:00:00Z`) - new Date(`${valid_from}T00:00:00Z`)) /
      86400000;
    if (spanDays > WAIVER_MAX_DAYS) {
      throw new CertificationError(
        "invalid_input",
        `豁免期限不得超过 ${WAIVER_MAX_DAYS} 天`
      );
    }
    if (!remediation_plan || !String(remediation_plan).trim()) {
      throw new CertificationError("invalid_input", "豁免必须附整改计划");
    }

    const data = this.store.read();
    const latest = Object.values(data.results)
      .filter((r) => r.registration_id === registration_id)
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))[0];
    if (!latest) throw new CertificationError("invalid_state", "尚无提交结果");
    const notFailed = case_ids.filter(
      (id) => !latest.failed_non_critical_case_ids.includes(id)
    );
    if (notFailed.length > 0) {
      throw new CertificationError(
        "waiver_denied",
        "豁免只能覆盖本次判定的非关键失败用例（关键用例不可豁免）",
        { rejected_case_ids: notFailed }
      );
    }
    const pkg = data.packages[latest.package_id];
    if (pkg.leaked) {
      throw new CertificationError("waiver_denied", "测试包已泄露，不得豁免发证");
    }

    const waiver = {
      waiver_id: await randomId("wvr"),
      institution_id: reg.institution_id, // 豁免限定机构
      registration_id,
      software_name: reg.software_name,
      software_version: reg.software_version, // 豁免限定版本
      case_ids: [...case_ids].sort(),
      valid_from,
      valid_to, // 豁免限定期限
      remediation_plan,
      granted_by: actor.subject,
      granted_at: this.clock(),
      revoked: false,
    };

    return this.store.mutate(async (d) => {
      d.waivers[waiver.waiver_id] = waiver;
      // 带例外发证。
      const cert = await this.#buildCertificate(d, reg, pkg, latest, [waiver]);
      d.certificates[cert.cert_id] = cert;
      latest.certificate_id = cert.cert_id;
      return { waiver, certificate_id: cert.cert_id };
    });
  }

  // ---------- 证书 ----------

  async #buildCertificate(d, reg, pkg, result, waivers) {
    const cert_id = `cert-${result.catalog_version.replace(/\./g, "")}-${reg.signer_key_id}-${result.result_id.slice(-6)}`;
    const body = {
      cert_id,
      issued_at: this.clock(),
      status: waivers.length > 0 ? "certified_with_exception" : "certified",
      scope_statement:
        `本证书仅说明适配器在目录 ${pkg.catalog_version}（封存哈希 ${pkg.catalog_hash.slice(0, 12)}…）` +
        `对应的不可变测试包 ${pkg.package_id} 上，于登记的隔离环境中的兼容情况；不构成对真实账单的处理授权。`,
      institution: {
        institution_id: reg.institution_id,
      },
      software: {
        software_name: reg.software_name,
        software_version: reg.software_version,
        build_hash: reg.build_hash,
      },
      rule_set_hash: reg.rule_set_hash,
      environment_fingerprint: reg.environment_fingerprint,
      package: {
        package_id: pkg.package_id,
        package_hash: pkg.package_hash,
        coverage: pkg.coverage,
        case_count: pkg.cases.length,
      },
      catalog: {
        catalog_version: pkg.catalog_version,
        catalog_hash: pkg.catalog_hash,
      },
      result_id: result.result_id,
      exceptions: waivers.map((w) => ({
        waiver_id: w.waiver_id,
        case_ids: w.case_ids,
        valid_from: w.valid_from,
        valid_to: w.valid_to,
        remediation_plan: w.remediation_plan,
        signer: w.granted_by,
      })),
      signers: {
        hospital_key_id: reg.signer_key_id,
        agency_signer:
          waivers.length > 0 ? waivers[0].granted_by : "agency:auto-pass",
      },
    };
    // 封存证书内容：cert_hash 覆盖除自身外全部字段，供审查侧核验未被篡改。
    return { cert_id, ...body, cert_hash: await hashJson(body) };
  }

  getCertificate(actor, certId) {
    requireActor(actor);
    const cert = this.store.read().certificates[certId];
    if (!cert) throw new CertificationError("not_found", "证书不存在");
    if (
      actor.role === "hospital" &&
      cert.institution.institution_id !== actor.institution_id
    ) {
      throw new CertificationError("not_found", "证书不存在");
    }
    return cert;
  }

  listCertificates(actor, { institution_id } = {}) {
    requireActor(actor);
    const certs = Object.values(this.store.read().certificates);
    return certs.filter((c) => {
      if (actor.role === "hospital") {
        return c.institution.institution_id === actor.institution_id;
      }
      return !institution_id || c.institution.institution_id === institution_id;
    });
  }

  /**
   * 审查人员从一张证书复原：测试包、目录版本、医院构建、例外意见、签署者。
   */
  reconstructCertificate(actor, certId) {
    requireActor(actor, "agency");
    const data = this.store.read();
    const cert = data.certificates[certId];
    if (!cert) throw new CertificationError("not_found", "证书不存在");
    const reg = Object.values(data.registrations).find(
      (r) =>
        r.institution_id === cert.institution.institution_id &&
        r.software_version === cert.software.software_version &&
        r.build_hash === cert.software.build_hash
    );
    return {
      certificate: cert,
      test_package: data.packages[cert.package.package_id], // 完整归档包
      registration: reg, // 医院构建、规则、环境与公钥
      result: data.results[cert.result_id],
      waivers: cert.exceptions.map((e) => data.waivers[e.waiver_id]).filter(Boolean),
    };
  }

  // ---------- 目录修订：仅受影响适配器复测 ----------

  /**
   * 发布新版本测试包，并按变更坐标找出登记覆盖这些坐标的适配器，
   * 建立复测任务。旧证书原样保留，只作为当时覆盖范围的说明。
   */
  async publishRevision(actor, fromVersion, toVersion) {
    requireActor(actor, "agency");
    const { package: pkg } = await this.publishPackage(actor, toVersion);
    const diff = diffVersions(this.catalog, fromVersion, toVersion);
    const affectedCoords = new Set(diff.affected.map((a) => a.coordinate));

    return this.store.mutate((d) => {
      const tasks = [];
      for (const reg of Object.values(d.registrations)) {
        const touched = reg.covered_coordinates.filter((c) => affectedCoords.has(c));
        if (touched.length === 0) continue;
        // 该适配器针对旧版本的证书：继续保留并说明旧覆盖，不被删除或改写。
        const oldCerts = Object.values(d.certificates).filter(
          (c) =>
            c.institution.institution_id === reg.institution_id &&
            c.software.software_version === reg.software_version &&
            c.catalog.catalog_version === fromVersion
        );
        const task = {
          retest_id: `rt-${toVersion.replace(/\./g, "")}-${reg.registration_id.slice(-6)}`,
          registration_id: reg.registration_id,
          institution_id: reg.institution_id,
          from_version: fromVersion,
          to_version: toVersion,
          package_id: pkg.package_id,
          affected_coordinates: touched,
          affected_mapping_ids: diff.affected
            .filter((a) => touched.includes(a.coordinate))
            .map((a) => a.mapping_id),
          old_certificate_ids: oldCerts.map((c) => c.cert_id),
          status: "retest_required",
          created_at: this.clock(),
        };
        d.retests[task.retest_id] = task;
        tasks.push(task);
      }
      return { new_package_id: pkg.package_id, diff, retests: tasks };
    });
  }

  listRetests(actor, { status } = {}) {
    requireActor(actor);
    const tasks = Object.values(this.store.read().retests ?? {});
    return tasks
      .filter((t) => {
        if (actor.role === "hospital" && t.institution_id !== actor.institution_id) {
          return false;
        }
        return !status || t.status === status;
      })
      .map((t) => (actor.role === "hospital" ? this.#hospitalRetestView(t) : t));
  }

  #hospitalRetestView(t) {
    // 医院侧只知道需要复测与坐标，不接触其他机构信息（本就过滤掉了）。
    return {
      retest_id: t.retest_id,
      to_version: t.to_version,
      package_id: t.package_id,
      affected_coordinates: t.affected_coordinates,
      status: t.status,
    };
  }

  // ---------- 灰度：匿名差异统计门槛 ----------

  /**
   * 上报灰度期匿名差异统计：仅接受聚合计数，拒绝任何记录级数据。
   */
  async reportGrayscaleStats(actor, input) {
    requireActor(actor); // 医院可上报本机构灰度，经办可代报
    const { registration_id, sample_count, mismatch_count, period } = input;
    const reg = this.#getRegistrationScoped(actor, registration_id);
    if (
      !Number.isInteger(sample_count) ||
      !Number.isInteger(mismatch_count) ||
      sample_count < 0 ||
      mismatch_count < 0 ||
      mismatch_count > sample_count
    ) {
      throw new CertificationError("invalid_input", "差异统计计数不合法");
    }
    if (!period) throw new CertificationError("invalid_input", "缺少统计周期标识");
    // 防真实数据混入：明确拒绝任何记录级字段。
    const forbidden = ["records", "cases", "patients", "visits", "details", "items"];
    const leakedField = forbidden.find((f) => input[f] !== undefined);
    if (leakedField) {
      throw new CertificationError(
        "patient_data_forbidden",
        "灰度统计只接受匿名聚合计数，不得包含记录级数据"
      );
    }

    const record = {
      stat_id: await randomId("stt"),
      registration_id,
      institution_id: reg.institution_id,
      period,
      sample_count,
      mismatch_count,
      reported_at: this.clock(),
    };
    await this.store.mutate((d) => {
      d.gray_stats[record.stat_id] = record;
    });
    return record;
  }

  /**
   * 评估是否允许扩大使用：达到最小样本量且差异率不超门槛。
   */
  evaluateGrayscaleGate(actor, registrationId, options = {}) {
    requireActor(actor, "agency");
    const minSamples = options.min_samples ?? 1000;
    const maxMismatchRate = options.max_mismatch_rate ?? 0.005;
    const stats = Object.values(this.store.read().gray_stats).filter(
      (s) => s.registration_id === registrationId
    );
    const totals = stats.reduce(
      (acc, s) => {
        acc.samples += s.sample_count;
        acc.mismatches += s.mismatch_count;
        return acc;
      },
      { samples: 0, mismatches: 0 }
    );
    const rate = totals.samples === 0 ? 1 : totals.mismatches / totals.samples;
    const expansion_allowed =
      totals.samples >= minSamples && rate <= maxMismatchRate;
    return {
      registration_id: registrationId,
      periods: stats.length,
      ...totals,
      mismatch_rate: Number(rate.toFixed(6)),
      threshold: { min_samples: minSamples, max_mismatch_rate: maxMismatchRate },
      expansion_allowed,
      reason: expansion_allowed
        ? "匿名差异统计达到门槛，允许扩大使用"
        : totals.samples < minSamples
          ? "匿名样本量不足"
          : "匿名差异率超过门槛，维持灰度",
    };
  }
}
