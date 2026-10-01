import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 极简 JSON 文档存储：单文件、整体读写、串行化写入。
 * 认证服务是低频管理面，无需真实数据库；文件即审计底账。
 */
export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.chain = Promise.resolve();
  }

  async init(defaultData = {}) {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = JSON.parse(raw);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.data = structuredClone(defaultData);
      await this.#flush();
    }
    return this.data;
  }

  #flush() {
    const job = this.chain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
      await rename(tmp, this.filePath);
    });
    this.chain = job.catch(() => {});
    return job;
  }

  /** 在串行写入队列中执行变更，结束后原子落盘。 */
  async mutate(fn) {
    const run = this.chain.then(async () => {
      const result = await fn(this.data);
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
      await rename(tmp, this.filePath);
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  read() {
    return this.data;
  }
}
