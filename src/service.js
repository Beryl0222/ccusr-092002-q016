import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { createHttpServer } from "./http.js";

export const serviceId = "medical-service-catalog";
export const serviceName = "医保项目跨省映射";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

export { createApp, createHttpServer };

/**
 * 首次引导：尚无令牌时签发一枚经办机构令牌与一枚医院令牌。
 * 明文只在引导当次输出；落盘仅存哈希。
 */
async function bootstrap(app, institutionId) {
  const { tokens } = app;
  if (tokens.hasAgencyToken()) {
    console.log("已存在经办令牌，跳过引导");
    return;
  }
  const agency = await tokens.issue({
    role: "agency",
    subject: "agency:bootstrap",
  });
  const hospital = await tokens.issue({
    role: "hospital",
    subject: `hospital:${institutionId}`,
    institution_id: institutionId,
  });
  console.log(JSON.stringify({ agency_token: agency, hospital_token: hospital }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const catalogPath = resolve("contracts/catalog_mapping.json");
  const dataPath = resolve("data/state.json");

  if (args.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    console.log("基础检查通过");
  } else if (args.includes("--bootstrap")) {
    const idx = args.indexOf("--institution");
    const institutionId = idx >= 0 ? args[idx + 1] : "H-DEMO-001";
    const app = await createApp({ catalogPath, dataPath });
    await bootstrap(app, institutionId);
  } else {
    const portIndex = args.indexOf("--port");
    const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8000;
    const app = await createApp({ catalogPath, dataPath });
    createHttpServer(app, { serviceId, serviceName }).listen(port, "0.0.0.0", () => {
      console.log(`${serviceName} 认证服务监听 :${port}`);
    });
  }
}
