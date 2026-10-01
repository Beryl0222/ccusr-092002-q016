import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 极简 JSON 持久化存储。认证记录须可复查，默认落盘；
 * 测试使用内存模式（filePath 为 null）。
 */
export class JsonStore {
  constructor(filePath = null, initial = {}) {
    this.filePath = filePath;
    this.data = structuredClone(initial);
  }

  static async create(filePath, initial = {}) {
    const store = new JsonStore(filePath, initial);
    if (filePath) {
      try {
        const raw = await readFile(filePath, "utf8");
        store.data = JSON.parse(raw);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return store;
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
  }

  update(key, producer, initial) {
    this.data[key] = producer(this.data[key] ?? structuredClone(initial));
    return this.data[key];
  }

  async persist() {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }
}
