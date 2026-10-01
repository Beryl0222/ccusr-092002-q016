import http from "node:http";

import { CertificationService, HttpError } from "./domain/certification.js";

/**
 * HTTP 适配层：鉴权（Bearer 令牌）、路由与 JSON 编解码。
 * 业务规则全部在 CertificationService 中，本层不做判定。
 */
export function createApp(deps) {
  const service = new CertificationService(deps);

  function tokenOf(request) {
    const header = request.headers.authorization ?? "";
    if (header.startsWith("Bearer ")) return header.slice(7);
    return request.headers["x-auth-token"];
  }

  async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, "请求体不是合法 JSON");
    }
  }

  const routes = [];
  function route(method, pattern, handler, role) {
    routes.push({ method, pattern, handler, role });
  }

  // ---- 机构（医院）侧 ----
  route("POST", /^\/v1\/hospitals$/, async (req, body, token) => {
    service.requireRole(token, "authority");
    return service.registerHospital(body);
  });
  route("POST", /^\/v1\/builds$/, (req, body, token) => service.registerBuild(token, body));
  route("POST", /^\/v1\/packages\/([^/]+)\/distribute$/, (req, body, token, m) =>
    service.distributePackage(token, m[1]));
  route("POST", /^\/v1\/submissions$/, (req, body, token) => service.submitResults(token, body));
  route("GET", /^\/v1\/certificates\/([^/]+)$/, (req, body, token, m) =>
    service.getOwnCertificate(token, m[1]));
  route("POST", /^\/v1\/grayscale\/events$/, (req, body, token) =>
    service.recordGrayscaleEvents(token, body.events));

  // ---- 审查者侧 ----
  route("POST", /^\/v1\/reviewers$/, (req, body, token) => {
    service.requireRole(token, "authority");
    return service.createReviewer(body);
  });
  route("POST", /^\/v1\/waivers$/, (req, body, token) => service.approveWaiver(token, body));
  route("GET", /^\/v1\/review\/certificates\/([^/]+)$/, (req, body, token, m) =>
    service.reconstructCertificate(token, m[1]));

  // ---- 经办机构侧 ----
  route("POST", /^\/v1\/packages$/, (req, body, token) =>
    service.publishPackage(token, body.catalog_version ?? null, body.province));
  route("POST", /^\/v1\/leaks$/, (req, body, token) => service.reportLeak(token, body));
  route("POST", /^\/v1\/revisions$/, (req, body, token) => service.applyRevision(token, body));
  route("GET", /^\/v1\/grayscale\/decision$/, (req, body, token) =>
    service.grayscaleDecision(token));

  const handler = async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/health") {
      const payload = {
        status: "ok",
        service: deps.serviceId ?? "medical-service-catalog",
        name: "医保适配器适配认证服务",
      };
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
      return;
    }

    try {
      const match = routes.find(
        (r) => r.method === request.method && r.pattern.test(url.pathname),
      );
      if (!match) throw new HttpError(404, "未找到资源");
      const token = tokenOf(request);
      if (!token) throw new HttpError(401, "缺少访问令牌");
      // 统一鉴权；具体角色由服务方法按端点再校验。
      service.authenticate(token);
      const body = request.method === "POST" ? await readJson(request) : {};
      const result = await match.handler(request, body, token, url.pathname.match(match.pattern));
      if (deps.store?.filePath && request.method === "POST") await deps.store.persist();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error.message }));
    }
  };

  return { service, server: http.createServer(handler) };
}
