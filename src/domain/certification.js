import {
  sha256,
  stableStringify,
  shortId,
  signWithAuthority,
  verifyWithAuthority,
  verifySubmissionSignature,
} from "./crypto.js";
import {
  validateCatalog,
  getVersion,
  latestVersion,
  versionHash,
  revisionDiff,
  scopeIsAffected,
} from "./catalog.js";
import { sealTestPackage, verifyPackageIntegrity, watermarkedCopy } from "./testpackage.js";
import { isExpired, isValidDate, today } from "./time.js";

export const DECLARATION_TEMPLATE =
  "本机构承诺提交内容由登记的软件版本与转换规则在隔离环境生成；测试数据为合成用例，非真实患者账单。";

const GRAYSCALE_MIN_EXPOSURES = 100;
const GRAYSCALE_MAX_DIFF_RATE = 0.01;

/**
 * 适配认证服务核心。只判定兼容性，不接触真实患者账单。
 */
export class CertificationService {
  constructor({ catalog, authorityKey, store, clock = () => new Date() }) {
    validateCatalog(catalog);
    this.catalog = catalog;
    this.authorityKey = authorityKey;
    this.store = store;
    this.clock = clock;
    this.tokens = new Map();
    if (!store.get("state")) {
      store.set("state", {
        orgs: {},
        registrations: {},
        packages: {},
        distributions: {},
        submissions: {},
        certificates: {},
        waivers: {},
        leaks: { packages: {}, watermarks: [] },
        revisions: [],
        grayscale: { exposures: 0, differences: 0, by_code: {} },
      });
    }
  }

  get state() {
    return this.store.get("state");
  }

  nowDate() {
    return today(this.clock);
  }

  // ---------- 令牌与角色 ----------

  issueToken(descriptor) {
    const token = shortId("TOK-");
    this.tokens.set(token, descriptor);
    return token;
  }

  authenticate(token) {
    const descriptor = this.tokens.get(token);
    if (!descriptor) throw new HttpError(401, "未识别的访问令牌");
    return descriptor;
  }

  requireRole(token, role) {
    const descriptor = this.authenticate(token);
    if (descriptor.role !== role) throw new HttpError(403, "角色无权访问");
    return descriptor;
  }

  // ---------- 审查者 ----------

  createReviewer({ name }) {
    if (!name) throw new HttpError(400, "审查者姓名必填");
    const reviewerId = shortId("REV-USER-");
    const token = this.issueToken({ role: "reviewer", reviewer_id: reviewerId, name });
    return { reviewer: { reviewer_id: reviewerId, name }, token };
  }

  createAuthorityToken() {
    return this.issueToken({ role: "authority", name: "经办机构认证操作员" });
  }

  // ---------- 医院登记 ----------

  registerHospital({ name, provinces, public_key }) {
    if (!name || !Array.isArray(provinces) || provinces.length === 0 || !public_key) {
      throw new HttpError(400, "机构名称、覆盖省份与公钥缺一不可");
    }
    const orgId = shortId("ORG-");
    this.state.orgs[orgId] = {
      org_id: orgId,
      name,
      provinces: [...new Set(provinces)],
      public_key,
      status: "active",
      registered_at: this.nowDate(),
    };
    const token = this.issueToken({ role: "hospital", org_id: orgId });
    return { org: this.state.orgs[orgId], token };
  }

  registerBuild(token, body) {
    const { org_id } = this.requireRole(token, "hospital");
    const { software_name, software_version, rule_set_version, env_fingerprint, provinces } = body;
    if (!software_name || !software_version || !rule_set_version || !env_fingerprint) {
      throw new HttpError(400, "软件名称、软件版本、转换规则版本与隔离环境指纹缺一不可");
    }
    const scope = provinces?.length ? provinces : this.state.orgs[org_id].provinces;
    for (const province of scope) {
      if (!this.state.orgs[org_id].provinces.includes(province)) {
        throw new HttpError(400, `登记省份超出机构范围: ${province}`);
      }
    }
    const registrationId = shortId("BLD-");
    this.state.registrations[registrationId] = {
      registration_id: registrationId,
      org_id,
      software_name,
      software_version,
      rule_set_version,
      env_fingerprint,
      provinces: [...new Set(scope)],
      registered_at: this.nowDate(),
      status: "active",
    };
    return { registration: this.state.registrations[registrationId], declaration_template: DECLARATION_TEMPLATE };
  }

  // ---------- 测试包发布与分发 ----------

  /**
   * 发布不可变测试包。(目录版本, 省份) 决定同一包：
   * 目录未变时重复发布返回原包及其原哈希。
   */
  publishPackage(authorityToken, catalogVersionString, province) {
    this.requireRole(authorityToken, "authority");
    const versionString = catalogVersionString ?? latestVersion(this.catalog);
    const catalogVersion = getVersion(this.catalog, versionString);
    const catalogHash = versionHash(catalogVersion);
    const deterministicId = `PKG-${sha256(`${versionString}:${province}`).slice(7, 23)}`;
    const existing = this.state.packages[deterministicId];
    if (existing) {
      if (existing.catalog_hash !== catalogHash) {
        // 同一 (版本号, 省份) 却出现不同目录内容：目录版本被非法改写，拒绝。
        throw new HttpError(409, "目录版本内容与已发布测试包不一致，目录疑似被篡改");
      }
      return { package: existing.envelope, reused: true };
    }
    const envelope = sealTestPackage({
      packageId: deterministicId,
      catalogVersion,
      catalogHash,
      province,
      issuedAt: this.nowDate(),
    });
    if (envelope.case_count === 0) {
      throw new HttpError(400, `目录版本 ${versionString} 在省份 ${province} 无映射，拒绝发布空测试包`);
    }
    envelope.authority_signature = signWithAuthority(
      this.authorityKey.privateKey,
      envelope.package_hash,
    );
    this.state.packages[deterministicId] = {
      envelope,
      catalog_hash: catalogHash,
      published_at: this.nowDate(),
    };
    return { package: envelope, reused: false };
  }

  /** 医院领取带水印的测试包副本。 */
  distributePackage(token, packageId) {
    const { org_id } = this.requireRole(token, "hospital");
    const record = this.state.packages[packageId];
    if (!record) throw new HttpError(404, "测试包不存在");
    if (!this.state.orgs[org_id].provinces.includes(record.envelope.province)) {
      throw new HttpError(403, "测试包省份不在机构登记范围内");
    }
    if (this.state.leaks.packages[packageId]) {
      throw new HttpError(409, "测试包已整体泄露，停止分发");
    }
    const copy = watermarkedCopy(record.envelope, org_id);
    const key = `${org_id}:${packageId}`;
    if (!this.state.distributions[key]) {
      this.state.distributions[key] = {
        ...copy,
        catalog_version: record.envelope.catalog_version,
        issued_at: this.nowDate(),
      };
    }
    return {
      package: record.envelope,
      watermark: this.state.distributions[key].watermark,
    };
  }

  // ---------- 豁免 ----------

  /**
   * 人工豁免必须同时限定：机构、版本（软件+转换规则）、期限、整改计划。
   * 任一缺失或过期一律拒绝。
   */
  approveWaiver(reviewerToken, body) {
    const reviewer = this.requireRole(reviewerToken, "reviewer");
    const {
      org_id,
      software_version,
      rule_set_version,
      valid_from,
      valid_until,
      case_ids,
      reason,
      remediation_plan,
    } = body;
    if (!org_id || !this.state.orgs[org_id]) throw new HttpError(400, "豁免必须限定有效机构");
    if (!software_version || !rule_set_version) throw new HttpError(400, "豁免必须限定软件版本与转换规则版本");
    if (!isValidDate(valid_from) || !isValidDate(valid_until) || valid_until < valid_from) {
      throw new HttpError(400, "豁免必须限定合法且有效的期限");
    }
    if (!remediation_plan || !remediation_plan.trim()) {
      throw new HttpError(400, "豁免必须附整改计划");
    }
    if (!Array.isArray(case_ids) || case_ids.length === 0) {
      throw new HttpError(400, "豁免必须指明被豁免的关键用例");
    }
    if (isExpired(valid_until, this.nowDate())) throw new HttpError(400, "豁免期限已过，不予登记");

    const waiverId = shortId("WVR-");
    const waiver = {
      waiver_id: waiverId,
      org_id,
      software_version,
      rule_set_version,
      valid_from,
      valid_until,
      case_ids: [...case_ids],
      reason: reason ?? null,
      remediation_plan,
      approved_by: reviewer.reviewer_id,
      approved_at: this.nowDate(),
    };
    const payload = stableStringify(waiver);
    waiver.reviewer_signature = signWithAuthority(this.authorityKey.privateKey, payload);
    this.state.waivers[waiverId] = waiver;
    return { waiver };
  }

  waiverCovers(waiver, { orgId, softwareVersion, ruleVersion, caseId, now }) {
    return (
      waiver.org_id === orgId &&
      waiver.software_version === softwareVersion &&
      waiver.rule_set_version === ruleVersion &&
      waiver.case_ids.includes(caseId) &&
      waiver.valid_from <= now &&
      (!waiver.valid_until || waiver.valid_until >= now)
    );
  }

  // ---------- 泄露处置 ----------

  reportLeak(authorityToken, { package_id, watermark, org_id }) {
    this.requireRole(authorityToken, "authority");
    if (!this.state.packages[package_id]) throw new HttpError(404, "测试包不存在");
    if (watermark) {
      const entry = Object.entries(this.state.distributions).find(
        ([, dist]) => dist.watermark === watermark && dist.package_id === package_id,
      );
      if (!entry) throw new HttpError(404, "未找到水印对应的分发记录");
      const [key, dist] = entry;
      this.state.leaks.watermarks.push({ package_id, watermark, org_id: dist.org_id, reported_at: this.nowDate() });
      this._revokeCertsForLeak(package_id, dist.org_id);
      return { scope: "organization", org_id: dist.org_id, package_id };
    }
    this.state.leaks.packages[package_id] = { reported_at: this.nowDate(), org_id: org_id ?? null };
    this._revokeCertsForLeak(package_id, null);
    return { scope: "package", package_id };
  }

  _revokeCertsForLeak(packageId, orgId) {
    for (const cert of Object.values(this.state.certificates)) {
      if (cert.package_id !== packageId) continue;
      if (cert.status !== "valid" && cert.status !== "conditional") continue;
      if (orgId && cert.org_id !== orgId) continue;
      cert.status = "revoked";
      cert.revocation = { reason: orgId ? "watermark_leak" : "package_leak", at: this.nowDate() };
    }
  }

  packageLeakedFor(packageId, orgId) {
    if (this.state.leaks.packages[packageId]) return "package_leaked";
    const hit = this.state.leaks.watermarks.find(
      (l) => l.package_id === packageId && l.org_id === orgId,
    );
    return hit ? "test_package_leaked" : null;
  }

  // ---------- 提交与判定 ----------

  submitResults(token, body) {
    const { org_id } = this.requireRole(token, "hospital");
    const {
      registration_id,
      package_id,
      results,
      log_fingerprint,
      env_fingerprint,
      claim,
      signature,
    } = body;

    const registration = this.state.registrations[registration_id];
    if (!registration || registration.org_id !== org_id) {
      throw new HttpError(404, "未找到本机构的登记构建");
    }
    const packageRecord = this.state.packages[package_id];
    if (!packageRecord) throw new HttpError(404, "测试包不存在");
    const envelope = packageRecord.envelope;

    // 幂等：同一构建对同一测试包的首个结论即最终结论；
    // 任何重复上传（无论内容是否变化）都原样返回首次认证结果。
    // 整改后须重新登记软件构建（新 registration）再进入新一轮认证。
    const idempotencyKey = `${registration_id}:${package_id}`;
    const previous = this.state.submissions[idempotencyKey];
    if (previous) {
      return {
        verdict: previous.verdict,
        certificate: previous.certificate_id ? this.state.certificates[previous.certificate_id] : null,
        idempotent: true,
      };
    }

    if (!Array.isArray(results)) throw new HttpError(400, "results 必须为逐例输出数组");

    const blockers = [];
    const leak = this.packageLeakedFor(package_id, org_id);
    if (leak) blockers.push(leak);
    if (env_fingerprint !== registration.env_fingerprint) blockers.push("environment_changed");

    // 包完整性：医院无法篡改，但服务端仍复核一次。
    const integrity = verifyPackageIntegrity(envelope);
    if (!integrity.ok) blockers.push(integrity.reason);

    // 签名声明校验。
    const org = this.state.orgs[org_id];
    let signatureValid = false;
    let claimValid = false;
    if (claim && signature) {
      signatureValid = verifySubmissionSignature(org.public_key, claim, signature);
      const resultsHash = sha256(stableStringify(results));
      claimValid =
        signatureValid &&
        claim.org_id === org_id &&
        claim.registration_id === registration_id &&
        claim.package_id === package_id &&
        claim.package_hash === envelope.package_hash &&
        claim.software_version === registration.software_version &&
        claim.rule_set_version === registration.rule_set_version &&
        claim.env_fingerprint === env_fingerprint &&
        claim.log_fingerprint === log_fingerprint &&
        claim.results_hash === resultsHash &&
        typeof claim.submitted_at === "string";
    }
    if (!signatureValid) blockers.push("invalid_signature");
    if (signatureValid && !claimValid) blockers.push("invalid_declaration_claim");

    // 逐例判定。
    const caseResults = evaluateCases(envelope, results);
    const failed = caseResults.filter((c) => !c.passed);
    const criticalFailures = failed.filter((c) => c.critical);

    // 豁免：仅覆盖与本机构、本版本、当前期限、对应用例精确匹配的失败。
    const now = this.nowDate();
    const waivedCaseIds = new Set();
    const usedWaivers = [];
    for (const failure of criticalFailures) {
      const waiver = Object.values(this.state.waivers).find((w) =>
        this.waiverCovers(w, {
          orgId: org_id,
          softwareVersion: registration.software_version,
          ruleVersion: registration.rule_set_version,
          caseId: failure.case_id,
          now,
        }),
      );
      if (waiver) {
        waivedCaseIds.add(failure.case_id);
        usedWaivers.push(waiver.waiver_id);
      }
    }
    const unwaivedFailures = criticalFailures.filter((f) => !waivedCaseIds.has(f.case_id));
    if (unwaivedFailures.length > 0) blockers.push("critical_case_failure");

    const waivedCriticalFailures = criticalFailures.filter((f) => waivedCaseIds.has(f.case_id));

    const verdict = {
      verdict_id: shortId("VRD-"),
      org_id,
      registration_id,
      package_id,
      package_hash: envelope.package_hash,
      catalog_version: envelope.catalog_version,
      catalog_hash: envelope.catalog_hash,
      submitted_at: now,
      software_version: registration.software_version,
      rule_set_version: registration.rule_set_version,
      env_fingerprint,
      log_fingerprint,
      signature_valid: signatureValid,
      claim_valid: claimValid,
      total_cases: envelope.case_count,
      passed_cases: caseResults.filter((c) => c.passed).length,
      waived_critical_failures: waivedCriticalFailures.length,
      failures: failed.map((f) => ({ case_id: f.case_id, category: f.category, reason: f.reason, critical: f.critical, waived: waivedCaseIds.has(f.case_id) })),
      blockers,
      compatible: blockers.length === 0,
      status: blockers.length === 0 ? (usedWaivers.length ? "conditional_pass" : "pass") : "fail",
    };

    let certificate = null;
    if (verdict.compatible) {
      certificate = this._issueCertificate({
        verdict,
        registration,
        envelope,
        waiverIds: [...new Set(usedWaivers)],
        waivedCaseIds: [...waivedCaseIds],
      });
    }

    this.state.submissions[idempotencyKey] = {
      verdict,
      certificate_id: certificate?.certificate_id ?? null,
      received_at: now,
    };
    return { verdict, certificate, idempotent: false };
  }

  _issueCertificate({ verdict, registration, envelope, waiverIds, waivedCaseIds }) {
    const certificateId = shortId("CERT-");
    const coverageStatement =
      `本证书仅证明 ${registration.software_name} ${registration.software_version}（规则 ${registration.rule_set_version}）` +
      `在目录 ${envelope.catalog_version}、省份 ${registration.provinces.join("/")}、测试包 ${envelope.package_id} 范围内的兼容性；` +
      `不构成对其他目录版本或范围的认可。`;
    const cert = {
      certificate_id: certificateId,
      schema: "adapter-conformance-cert/1",
      org_id: registration.org_id,
      registration_id: registration.registration_id,
      build: {
        software_name: registration.software_name,
        software_version: registration.software_version,
        rule_set_version: registration.rule_set_version,
        env_fingerprint: registration.env_fingerprint,
        provinces: registration.provinces,
      },
      catalog_version: envelope.catalog_version,
      catalog_hash: envelope.catalog_hash,
      package_id: envelope.package_id,
      package_hash: envelope.package_hash,
      case_count: envelope.case_count,
      exceptions: waiverIds,
      waived_cases: waivedCaseIds,
      coverage: { statement: coverageStatement },
      signer: "authority",
      issued_at: this.nowDate(),
      status: waiverIds.length ? "conditional" : "valid",
      retest: null,
    };
    cert.authority_signature = signWithAuthority(
      this.authorityKey.privateKey,
      signingPayload(cert),
    );
    this.state.certificates[certificateId] = cert;
    return cert;
  }

  getOwnCertificate(token, certificateId) {
    const { org_id } = this.requireRole(token, "hospital");
    const cert = this.state.certificates[certificateId];
    if (!cert || cert.org_id !== org_id) throw new HttpError(404, "证书不存在");
    return { certificate: cert };
  }

  // ---------- 审查复原 ----------

  /**
   * 一张证书复原：测试包（含全部用例）、目录版本快照、医院构建、
   * 例外意见（豁免全文与整改计划）、签署者，并就地验签。
   */
  reconstructCertificate(reviewerToken, certificateId) {
    this.requireRole(reviewerToken, "reviewer");
    const cert = this.state.certificates[certificateId];
    if (!cert) throw new HttpError(404, "证书不存在");
    const packageRecord = this.state.packages[cert.package_id];
    const catalogVersion = getVersion(this.catalog, cert.catalog_version);
    const registration = this.state.registrations[cert.registration_id];
    const org = this.state.orgs[cert.org_id];
    const submission = Object.values(this.state.submissions).find(
      (s) => s.certificate_id === certificateId,
    );

    const certSignatureValid = verifyWithAuthority(
      this.authorityKey.publicKey,
      signingPayload(cert),
      cert.authority_signature,
    );
    const packageSignatureValid = verifyWithAuthority(
      this.authorityKey.publicKey,
      packageRecord.envelope.package_hash,
      packageRecord.envelope.authority_signature,
    );
    const packageIntegrity = verifyPackageIntegrity(packageRecord.envelope);
    const catalogHashMatches = versionHash(catalogVersion) === cert.catalog_hash;

    return {
      certificate: cert,
      signatures: {
        authority_cert: certSignatureValid,
        authority_package: packageSignatureValid,
        package_integrity: packageIntegrity.ok,
        catalog_hash_matches: catalogHashMatches,
        hospital_declaration: submission?.verdict.signature_valid ?? false,
      },
      test_package: packageRecord.envelope,
      catalog_version: catalogVersion,
      hospital_build: { registration, org: { ...org, public_key: undefined } },
      submission_verdict: submission?.verdict ?? null,
      exceptions: cert.exceptions.map((id) => this.state.waivers[id]).filter(Boolean),
      signers: {
        authority: "经办机构适配认证服务（Ed25519）",
        hospital_org_id: cert.org_id,
        waiver_approvers: [...new Set(cert.exceptions.map((id) => this.state.waivers[id]?.approved_by).filter(Boolean))],
      },
    };
  }

  // ---------- 目录修订与复测 ----------

  /**
   * 应用目录修订：只把受影响的适配器（登记构建）对应证书标记为需复测，
   * 旧证书保留并继续说明当时覆盖范围。
   */
  applyRevision(authorityToken, { from_version, to_version }) {
    this.requireRole(authorityToken, "authority");
    const diff = revisionDiff(this.catalog, from_version, to_version);
    const a = getVersion(this.catalog, from_version);
    const b = getVersion(this.catalog, to_version);
    const affected = [];
    for (const cert of Object.values(this.state.certificates)) {
      if (cert.catalog_version !== from_version) continue;
      if (cert.status === "revoked") continue;
      if (cert.retest?.to_version === to_version) continue;
      const result = scopeIsAffected(diff, cert.build.provinces, [a, b]);
      if (!result.affected) continue;
      cert.retest = {
        required: true,
        to_version,
        affected_codes: result.affected_codes,
        marked_at: this.nowDate(),
      };
      const registration = this.state.registrations[cert.registration_id];
      if (registration) registration.status = "retest_required";
      affected.push({
        certificate_id: cert.certificate_id,
        org_id: cert.org_id,
        registration_id: cert.registration_id,
        affected_codes: result.affected_codes,
      });
    }
    const record = {
      revision_id: shortId("REV-"),
      from_version,
      to_version,
      diff,
      affected,
      applied_at: this.nowDate(),
    };
    this.state.revisions.push(record);
    return record;
  }

  // ---------- 灰度匿名差异统计 ----------

  /**
   * 记录灰度差异。调用方须经认证，但存储层只保留聚合计数，
   * 不保留机构标识、构建标识或事件时间，保证匿名。
   */
  recordGrayscaleEvents(token, events) {
    this.requireRole(token, "hospital");
    if (!Array.isArray(events) || events.length === 0) throw new HttpError(400, "events 不能为空");
    const stats = this.state.grayscale;
    for (const event of events) {
      const code = event.national_code;
      if (!code || typeof event.matched !== "boolean") throw new HttpError(400, "事件须含 national_code 与 matched");
      stats.exposures += 1;
      if (!event.matched) stats.differences += 1;
      if (!stats.by_code[code]) stats.by_code[code] = { exposures: 0, differences: 0 };
      stats.by_code[code].exposures += 1;
      if (!event.matched) stats.by_code[code].differences += 1;
    }
    return { accepted: events.length, anonymous: true };
  }

  grayscaleDecision(authorityToken) {
    this.requireRole(authorityToken, "authority");
    const stats = this.state.grayscale;
    const diffRate = stats.exposures === 0 ? 1 : stats.differences / stats.exposures;
    const sampleReached = stats.exposures >= GRAYSCALE_MIN_EXPOSURES;
    const decision = {
      exposures: stats.exposures,
      differences: stats.differences,
      difference_rate: Number(diffRate.toFixed(6)),
      thresholds: { min_exposures: GRAYSCALE_MIN_EXPOSURES, max_difference_rate: GRAYSCALE_MAX_DIFF_RATE },
      by_code: stats.by_code,
      can_expand: sampleReached && diffRate <= GRAYSCALE_MAX_DIFF_RATE,
      reasons: [
        ...(sampleReached ? [] : [`样本量不足（${stats.exposures}/${GRAYSCALE_MIN_EXPOSURES}）`]),
        ...(diffRate <= GRAYSCALE_MAX_DIFF_RATE ? [] : [`差异率 ${diffRate.toFixed(4)} 超过门槛 ${GRAYSCALE_MAX_DIFF_RATE}`]),
      ],
    };
    return decision;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function signingPayload(cert) {
  const { authority_signature, ...rest } = cert;
  return rest;
}

/** 逐例比对：输出接受标志、省级代码集合、拒绝原因必须与期望一致。 */
export function evaluateCases(envelope, results) {
  const byId = new Map(results.map((r) => [r.case_id, r]));
  return envelope.body.cases.map((expected) => {
    const actual = byId.get(expected.case_id);
    if (!actual) {
      return { case_id: expected.case_id, category: expected.category, critical: expected.critical !== false, passed: false, reason: "missing_result" };
    }
    const output = actual.output ?? {};
    const want = expected.expected;
    let passed = output.accepted === want.accepted;
    let reason = null;
    if (passed && want.accepted) {
      const actualCodes = [...(output.province_codes ?? [])].sort();
      const wantCodes = [...(want.expected_province_codes ?? [])].sort();
      if (wantCodes.length > 0 && stableStringify(actualCodes) !== stableStringify(wantCodes)) {
        passed = false;
        reason = "code_mismatch";
      }
    } else if (passed && !want.accepted && want.reason) {
      if (output.reason !== want.reason) {
        passed = false;
        reason = "reason_mismatch";
      }
    } else if (!passed) {
      reason = output.accepted ? "unexpected_accept" : "unexpected_reject";
    }
    return {
      case_id: expected.case_id,
      category: expected.category,
      critical: expected.critical !== false,
      passed,
      reason,
    };
  });
}
