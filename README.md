# 医保项目跨省映射 · 适配认证服务

国家医保医疗服务项目目录启用前，各医院的收费、医嘱和病案系统对同一组国家→省级映射可能给出不同结果。
本服务是目录跨省结算启用前的**适配器兼容性认证服务**：

- 依据 `contracts/catalog_mapping.json` 中的国家项目、省级代码和映射类型，发布**不可修改的测试包**；
- 医院登记软件版本、构建与转换规则后，在**隔离环境**提交逐例输出、日志指纹和签名声明；
- 服务**只判定兼容性，不处理任何真实患者账单**；
- 重复上传返回原认证结果；泄露、环境变化、关键用例失败均阻止发证；
- 人工豁免必须限定机构、版本、期限并附整改计划；
- 目录修订后仅受影响适配器复测，旧证书继续说明当时覆盖范围；
- 灰度期匿名差异统计达到门槛才允许扩大使用；
- 审查人员可从一张证书复原测试包、目录版本、医院构建、例外意见和签署者；医院之间互不可见。

## 目录契约

`contracts/catalog_mapping.json` 的 `catalog` 段保存两个版本快照（`2026.1` / `2026.2`），含：

- `national_items`：国家项目；`versions[*].mappings`：国家项目→省代码映射；
- `mapping_type`：`direct` 直通、`one_to_many` 一对多组合、`conditional` 条件分支；
- `valid_from` / `valid_to`：生效边界（`valid_from <= 就诊日期 < valid_to`）；
- `status: withdrawn` 与 `withdrawn_on`：撤销；撤销日前历史就诊仍按原规则，撤销日起不可结算；
- `mutex_groups`：同次就诊互斥项目（普通/专家门诊诊查费）。

`2026.2` 相对 `2026.1` 修改了一对多组合（M01）并撤销旧项目（M06），用于验证修订影响分析。
契约仅含公开领域样例，不含真实个人资料、凭据或生产连接信息。

## 关键规则

| 主题 | 规则 |
| --- | --- |
| 不可变测试包 | 用例由目录内容**确定性派生**（无随机/时间戳），同版本重复发布得到相同 `package_id` 与封存哈希；期望结果只存经办侧，医院视图只含输入 |
| 覆盖范围 | 一对多组合、条件分支、互斥（冲突+单一）、生效边界（前后各一天）、撤销、历史就诊日期 |
| 登记 | 机构 + 软件名 + 版本 + `build_hash` + 规则集 + 覆盖坐标 + 隔离环境指纹 + Ed25519 提交公钥；重复登记返回原记录 |
| 提交 | 逐例输出 + 日志指纹 + 环境指纹 + 对整份提交规范化字节的 Ed25519 签名 |
| 阻断发证 | 测试包已泄露 / 环境指纹变化 / 签名无效 / 任一关键用例失败 |
| 待豁免 | 仅非关键用例失败时 `blocked_pending_waiver` |
| 幂等 | 同一登记 + 同一提交字节哈希 → 返回原结果（`idempotent_replay: true`） |
| 人工豁免 | 经办机构签发；限定机构、软件版本、起止期限（≤180 天）、整改计划；只能覆盖最近判定中的非关键失败用例；泄露包不可豁免 |
| 证书 | 含测试包/目录版本与哈希、医院构建、规则哈希、环境指纹、例外意见、签署者，并用 `cert_hash` 封存；状态为 `certified` 或 `certified_with_exception` |
| 修订复测 | 按 `国家代码|省` 坐标做版本差异，仅覆盖受影响坐标的适配器生成复测任务；旧证书原样保留 |
| 灰度门槛 | 只接受匿名聚合计数（样本数/差异数），拒绝任何记录级字段；默认 `样本≥1000 且 差异率≤0.5%` 才允许扩大 |
| 可见性 | 医院访问他机构资源得到 404；证书列表仅本机构；审查复原仅经办机构 |

## HTTP 接口

鉴权：`Authorization: Bearer <token>`。经办角色 `agency`，医院角色 `hospital`。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 公开 | 服务身份 |
| POST | `/packages/publish` | agency | 发布/幂等取回不可变测试包 |
| GET | `/packages/:id` | 两者 | 医院视图无 `expected`，经办视图完整 |
| POST | `/packages/:id/leak` | agency | 登记泄露并永久封存 |
| POST | `/adapters/register` | hospital | 登记适配器 |
| POST | `/submissions` | hospital | 提交逐例输出+日志指纹+环境指纹+签名 |
| GET | `/results/:id` | 机构内 | 取认证判定 |
| POST | `/waivers` | agency | 人工豁免并带例外发证 |
| GET | `/certificates` | 两者 | 医院仅本机构 |
| GET | `/certificates/:id` | 机构内 | 单张证书 |
| GET | `/certificates/:id/reconstruct` | agency | 复原包/登记/结果/豁免/签署者 |
| POST | `/revisions/publish` | agency | 发布新版本并生成复测任务 |
| GET | `/retests` | 两者 | 复测任务（医院仅本机构、精简视图） |
| POST | `/grayscale/stats` | 两者 | 上报匿名聚合差异 |
| GET | `/grayscale/evaluate?registration_id=` | agency | 评估扩大使用门槛 |

## 运行

```bash
npm run check                 # 服务身份自检
npm test                      # 29 项契约/领域/HTTP 测试
npm run bootstrap -- --institution H-DEMO-001   # 首次引导，打印经办/医院令牌（仅一次）
npm start                     # 默认 :8000，可用 --port 指定
```

运行态写入 `data/state.json`（已在 `.gitignore`），令牌仅存 SHA-256 哈希。

## 代码结构

- `src/core/catalog.js`：时态映射引擎、互斥校验、版本差异影响分析；
- `src/core/package.js`：确定性测试包生成、封存哈希、医院视图；
- `src/core/service.js`：认证领域（登记、提交判定、幂等、豁免、证书、复测、灰度）；
- `src/core/auth.js` / `store.js` / `crypto.js`：令牌、JSON 底账、哈希与 Ed25519；
- `src/http.js` / `src/app.js` / `src/service.js`：HTTP 面、装配与入口；
- `test/`：目录引擎、测试包、认证全流程、修订/灰度、HTTP 集成测试。
