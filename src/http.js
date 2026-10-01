import http from "node:http";
import { CertificationError } from "./core/service.js";

/**
 * 认证服务 HTTP 面。
 * 鉴权：Authorization: Bearer <token>。
 * 可见性隔离在领域层强制（医院访问他机构资源得到 404）。
 */

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        rejectBody(new CertificationError("invalid_input", "请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new CertificationError("invalid_input", "请求体不是合法 JSON"));
      }
    });
    request.on("error", rejectBody);
  });
}

const STATUS_BY_CODE = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_state: 409,
  waiver_denied: 422,
  patient_data_forbidden: 422,
};

export function createHttpServer(app, { serviceId, serviceName }) {
  const { service, tokens } = app;

  async function authenticate(request) {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) throw new CertificationError("unauthorized", "缺少 Bearer 令牌");
    const actor = await tokens.resolve(match[1].trim());
    if (!actor) throw new CertificationError("unauthorized", "令牌无效或已注销");
    return actor;
  }

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    const method = request.method;

    if (path === "/health") {
      send(response, 200, { status: "ok", service: serviceId, name: serviceName });
      return;
    }

    let actor;
    try {
      actor = await authenticate(request);
      let body = {};
      if (method === "POST" || method === "PUT") body = await readBody(request);
      await route({ request, response, path, method, body, actor, url });
    } catch (err) {
      if (err instanceof CertificationError) {
        send(response, STATUS_BY_CODE[err.code] ?? 400, {
          error: err.code,
          message: err.message,
          ...(Object.keys(err.details).length ? { details: err.details } : {}),
        });
      } else {
        send(response, 500, { error: "internal_error", message: "服务内部错误" });
        request.destroy();
        // 保留服务端堆栈到日志，不回传调用方。
        console.error(err);
      }
    }
  });

  async function route({ response, path, method, body, actor, url }) {
    // ---- 测试包 ----
    if (method === "POST" && path === "/packages/publish") {
      const result = await service.publishPackage(actor, body.catalog_version);
      return send(response, 200, result.package);
    }
    let m;
    if ((m = /^\/packages\/([^/]+)$/.exec(path)) && method === "GET") {
      return send(response, 200, service.getPackage(actor, m[1]));
    }
    if ((m = /^\/packages\/([^/]+)\/leak$/.exec(path)) && method === "POST") {
      const pkg = await service.markPackageLeaked(actor, m[1], body.reason);
      return send(response, 200, { package_id: pkg.package_id, leaked: true });
    }

    // ---- 医院登记 ----
    if (method === "POST" && path === "/adapters/register") {
      const result = await service.registerAdapter(actor, body);
      // 登记响应不含其他机构信息；公钥回显便于核对。
      return send(response, 200, result.registration);
    }

    // ---- 提交与结果 ----
    if (method === "POST" && path === "/submissions") {
      const result = await service.submit(actor, body);
      return send(response, 200, result);
    }
    if ((m = /^\/results\/([^/]+)$/.exec(path)) && method === "GET") {
      return send(response, 200, service.getResult(actor, m[1]));
    }

    // ---- 豁免 ----
    if (method === "POST" && path === "/waivers") {
      const result = await service.grantWaiver(actor, body);
      return send(response, 200, result);
    }

    // ---- 证书 ----
    if (method === "GET" && path === "/certificates") {
      return send(
        response,
        200,
        service.listCertificates(actor, {
          institution_id: url.searchParams.get("institution_id") ?? undefined,
        })
      );
    }
    if ((m = /^\/certificates\/([^/]+)$/.exec(path)) && method === "GET") {
      return send(response, 200, service.getCertificate(actor, m[1]));
    }
    if ((m = /^\/certificates\/([^/]+)\/reconstruct$/.exec(path)) && method === "GET") {
      return send(response, 200, service.reconstructCertificate(actor, m[1]));
    }

    // ---- 目录修订 / 复测 ----
    if (method === "POST" && path === "/revisions/publish") {
      const result = await service.publishRevision(actor, body.from_version, body.to_version);
      return send(response, 200, result);
    }
    if (method === "GET" && path === "/retests") {
      return send(
        response,
        200,
        service.listRetests(actor, {
          status: url.searchParams.get("status") ?? undefined,
        })
      );
    }

    // ---- 灰度统计 ----
    if (method === "POST" && path === "/grayscale/stats") {
      const record = await service.reportGrayscaleStats(actor, body);
      return send(response, 200, record);
    }
    if (method === "GET" && path === "/grayscale/evaluate") {
      const registration_id = url.searchParams.get("registration_id");
      const gate = service.evaluateGrayscaleGate(actor, registration_id, {
        min_samples: Number(url.searchParams.get("min_samples") ?? 1000),
        max_mismatch_rate: Number(url.searchParams.get("max_mismatch_rate") ?? 0.005),
      });
      return send(response, 200, gate);
    }

    send(response, 404, { error: "not_found", message: "未找到资源" });
  }
}
