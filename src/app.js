import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JsonStore } from "./core/store.js";
import { CertificationService } from "./core/service.js";
import { TokenRegistry } from "./core/auth.js";
import { sha256Hex } from "./core/crypto.js";

const DEFAULT_DATA = {
  packages: {},
  registrations: {},
  results: {},
  waivers: {},
  certificates: {},
  retests: {},
  gray_stats: {},
  tokens: {},
};

export async function createApp({
  catalogPath = resolve("contracts/catalog_mapping.json"),
  dataPath = resolve("data/state.json"),
  clock,
} = {}) {
  const raw = await readFile(catalogPath, "utf8");
  const doc = JSON.parse(raw);
  const catalogHash = await sha256Hex(raw);
  const catalog = doc.catalog;

  const store = new JsonStore(dataPath);
  await store.init(DEFAULT_DATA);
  for (const key of Object.keys(DEFAULT_DATA)) {
    if (!store.read()[key]) store.read()[key] = {};
  }

  const tokens = new TokenRegistry(store);
  const service = new CertificationService({
    store,
    catalog,
    catalogHash,
    clock,
  });

  return { store, catalog, catalogHash, service, tokens };
}
