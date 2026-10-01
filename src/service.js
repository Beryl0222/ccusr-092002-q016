import http from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { createApp } from "./app.js";
import { JsonStore } from "./domain/store.js";
import {
  generateAuthorityKeyPair,
  exportPrivateKey,
} from "./domain/crypto.js";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * 机构签名密钥：密钥文件存在则加载（重启后旧证书签名仍可验证），
 * 否则首次启动时生成并持久化，权限 0600。
 */
export function loadOrCreateAuthorityKey(keyFile) {
  if (keyFile && existsSync(keyFile)) {
    const privateKey = createPrivateKey(readFileSync(keyFile, "utf8"));
    const publicKey = createPublicKey(privateKey);
    return { publicKey, privateKey };
  }
  const pair = generateAuthorityKeyPair();
  if (keyFile) {
    writeFileSync(keyFile, exportPrivateKey(pair.privateKey), { mode: 0o600 });
  }
  return pair;
}

export const serviceId = "medical-service-catalog";
export const serviceName = "医保适配器适配认证服务";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

export async function bootstrap({ dataFile = null, keyFile = null, clock } = {}) {
  const catalogPath = resolve(process.cwd(), "contracts/catalog_mapping.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const authorityKey = loadOrCreateAuthorityKey(keyFile);
  const store = await JsonStore.create(dataFile);
  const app = createApp({ catalog, authorityKey, store, clock, serviceId });

  // 运维引导令牌：生产环境应通过带外方式分发，这里仅用于启动引导。
  const authorityToken = app.service.createAuthorityToken();
  return { ...app, authorityToken };
}

export function createServer() {
  const server = http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "未找到资源" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(healthPayload()));
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    console.log("基础检查通过");
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8000;
    const dataIndex = process.argv.indexOf("--data");
    const dataFile = dataIndex >= 0 ? process.argv[dataIndex + 1] : null;
    const keyIndex = process.argv.indexOf("--key-file");
    const keyFile = keyIndex >= 0 ? process.argv[keyIndex + 1] : null;
    bootstrap({ dataFile, keyFile }).then(({ server, authorityToken }) => {
      server.listen(port, "0.0.0.0", () => {
        console.log(`${serviceName} 已启动，端口 ${port}`);
        if (authorityToken) console.log(`经办机构引导令牌: ${authorityToken}`);
      });
    });
  }
}
