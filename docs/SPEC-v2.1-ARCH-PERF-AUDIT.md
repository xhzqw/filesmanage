# SPEC v2.1 — 全局架构/性能/安全审计报告
> 日期：2026-10-08
> 审查对象：SPEC-v2.1.md（扩展前 v2.1-draft.4 / 1,533 行）、旧 SPEC.md（416 行）、旧 Node 部分关键模块、视频证据与两张截图。
> 审查方式：章节全量覆盖检查 + 架构/API/DDL/事务/权限/性能/运维交叉比对；未运行 Go、React、数据库迁移、Office/CAD PoC 或生产性能压测。
> 严重度：P0 阻断进入无约束业务 Build / 生产发布；P1 对应功能开发前明确；P2 进入代码阶段持续治理。
> 判定：**SPEC 方向成熟，但仍为 DRAFT。已将架构治理写入 §23、性能验收写入 §24；这些只是规范补齐，不是工程通过。**

## 1. 执行结论
已有清晰已确认项：Gin+PostgreSQL+React、Logo 蓝白工业风、第一期五项新增功能、真实 DOCX 编辑、机械 CAD 预览、Append-only 回滚、Plain Text A/B 与现有 S1–S22。
体系主要风险：业务边界尚未变成可编译接口和可执行 SQL；旧数据迁移方案已由 DEC-15 明确取消（全新 PostgreSQL/BlobDir/业务数据）；Office/DWG 引擎合法授权与硬件容量未实测；性能没有已批准真实基线。
从现在起“工程完成”的定义必须同时满足：架构边界静态检查、数据完整性、统一授权、端到端业务合约、压测和部署恢复。不得按文档总行数判质量。

## 2. P0 问题台账：先补阻断项
| ID | 位置 | 审查发现 | 强制整改/关闭证据 | 当前状态 |
|---|---|---|---|---|
| P0-01 | §6、旧 §3 DDL | 新版仅是逻辑表定义，没有可执行且验证通过的 PostgreSQL migration；旧版 DDL 缺少必要 FK/约束 | 编写版本化 up migration、FK/复合唯一/CHECK/索引/迁移校验；隔离 PG 启动、升级、失败回滚测试 | OPEN |
| P0-02 | §5/§9/API | 新版 API 与旧 Node 的 JSON body/错误码/字段及新增 save lockToken 不完全等价，缺唯一的版本化 OpenAPI Schema | OpenAPI 3.x + 请求响应 JSON schema/Go/TS 类型生成、错误码、兼容/安全拒绝用例；确定破坏性 API 升级策略 | OPEN |
| P0-03 | §7.1/§7.3/§6.4 | DB commit 与 blob publish 不能天然原子化；success→blob 不可读/孤儿 blob 风险 | §23 TX-05/06 staging/ready/outbox/reconciliation 与崩溃注入 AG08/AG09 实际通过 | DESIGN SPECIFIED / NOT TESTED |
| P0-04 | §2/§6/§10/§23 | 目录 ACL、文件共享、raw/preview/download、搜索/统计/导出可能出现多条不一致的权限 SQL | 统一 VisibleResourceScope/use-case Policy、显式权限决策表和跨全部接口的负向测试；撤销权限立即生效 | DESIGN SPECIFIED / NOT TESTED |
| P0-05 | §6.6/§7.4/§19 | 审批 pending、Office 异步 callback、锁 hold、回滚 CAS 存在复杂的并发状态交叉 | 定义唯一活跃 pending 的 DB 约束、完整状态转移表、SaveGeneration/idempotency、并发回放/崩溃测试 | OPEN |
| P0-06 | §12.4/§14.4/旧 SQLite | DEC-15：用户确认不需要旧数据；新 PG/Blob/账号与全新演示数据，旧资料不导入 | 决策已解决；实施需要验证新旧目录隔离、首装幂等、旧归档保护和切换回退 | DECISION RESOLVED / SAFETY GATE PENDING |
| P0-07 | §19 | 真实 DOCX 写回依赖自托管编辑引擎；许可证、部署、资源、回调、格式兼容尚未实证 | 确认合法授权 + Document Server PoC + DO01–DO14 + 隔离环境性能/重启回调 | OPEN |
| P0-08 | §20 | STEP/IGES/DXF/DWG 格式支持的解析链有不同许可证/平台风险；DWG B 类存在实质采购依赖 | 确定 8 类主流格式的真实样本，OCCT+DXF PoC；DWG 合法引擎与版本样本/费用/目标 OS 或以明确 BLOCKED 处理 | OPEN |
| P0-09 | §18 / §11.5 | Logo 源图虽有用户视觉确认和 SHA，但此前项目附件导入未成功 | 原始二进制可信入库、哈希校验，前端从项目本地真实加载，BG01–BG06、VS01 | OPEN |
| P0-10 | §14/§24 | 用户要求高性能，但目标机 CPU/RAM/SSD/实际并发未知；新 p95/p99 只是提议数字 | 记录真实资源和并发画像，隔离 PG + Worker 负载跑 PE01–PE18，审批基线及容量上限 | DESIGN SPECIFIED / NOT TESTED |
| P0-11 | §5/§23 | 原层次表述不够强制；未存在 Go/TS 可检查 import graph 和 CI fail 示例 | 实现 Go AST + ESLint 边界测试，AG01–AG16 的真实失败注入，代码 review 与 ADR 例外流程 | DESIGN SPECIFIED / NOT TESTED |
| P0-12 | §14.2/§14.3/§14.4 | 新 PG 与 blobs 备份并非天然一致；切回旧 Node 不会看到新 PG 的任何增量数据 | 新库一致性快照/restore，停写窗口、增量保全、旧 SQLite 归档与完整切换回退 runbook | OPEN |

## 3. P1 问题台账：对应功能开始前关闭
| ID | 发现 | 改进/验收 |
|---|---|---|
| P1-01 | 旧 API DELETE /files/:id 永久删除，与新版回收站软删不一致 | 将其标为 intentional breaking/compatibility change；旧旧客户端不得绕过软删除 |
| P1-02 | 用户/组“并集”与 share 的 includeDescendants、仅目录和下载粒度边界不够形式化 | 用动作×资源×授权来源×到期×生命周期决策表验证 |
| P1-03 | 非 UTF-8/BOM/混合行尾边界和 2M 字符静默截断的错误路径需要浏览器字节级实测 | PT01–PT12 + 下载 checksum + 非法编码拒写 |
| P1-04 | PostgreSQL simple/CJK 插空格算法可能产生召回、短语和标点误判 | 50k 中文语料真实查准/查全评估；明确 fallback 与索引延迟 |
| P1-05 | 100MB 上传与旧 dataURL(JSON 150MB) 不能等价；base64 膨胀和多重拷贝会 OOM | 大文件 multipart streaming 优先，旧 dataURL 限小样本向后兼容 |
| P1-06 | 统计的“文件数/总容量”可能把同一版本或共享副本重复计数 | 定义当前版本唯一文件/可见对象/历史版本的指标口径，写 SQL 期望值测试 |
| P1-07 | CSV UTF-8 BOM 和公式注入中和方式尚未给出跨 Excel/LibreOffice 实测样本 | 包括 =,+,-,@ 前缀、Tab、CRLF 的 CSV 回归，客户端打开抽样 |
| P1-08 | DOCX 复杂格式与 CAD 单位/拓扑无法纯靠截图判无损 | 格式兼容报告、几何 bbox/单位、源码 SHA + 派生误差阈值，经样本签收 |
| P1-09 | 前端缓存/状态同步若缺 mutation invalidation 可能造成错误权限按钮、旧文件覆盖新目录 | 明确 pages→features→entities→shared 和服务器权威；E2E 两账户切换 |
| P1-10 | 版本永久保留与 purge/数据保留/审计之间的法律/存储上限语义未完全闭合 | 明确 append-only 只约束存续文件的业务回滚，不阻止经特别授权/审计的资源生命周期结束 |

## 4. P2 文档与维护债
P2-01：旧 SPEC.md 标记“DDL 即契约/已定稿”，新草案不是可运行 SQL，必须通过版本优先级声明明确历史文件只作证据。
P2-02：主 SPEC §17 的“审查结论”位于新增 §18–§24 之前，容易使弱 Agent 在此停止阅读；应把总验收索引放文末，规定必须完整阅读。
P2-03：JSON 命名方式（snake_case 与 camelCase）、日期毫秒与 timestamptz 映射，需 OpenAPI 统一标准。
P2-04：普通 HTML/SVG 操作图标与品牌 JPEG 资产约束可以同时成立，静态校验规则需区分产品图标/品牌/用户文档。
P2-05：原 9 项 pending 的任务序列与现 §15 垂直切片不同，必须在 Build board 重新映射并逐项关联新的 Gate，而非悄悄开始。

## 5. 全章节审阅结论
| 章节 | 内容状态 | 主要需注意的点 |
|---|---|---|
| §0–§1 | 业务范围足够 | 明确原 v2 优先级与扩展能力 |
| §2–§4 | 信息/授权/视频契约较完整 | 权限真相须统一且可运行 |
| §5–§6 | 架构目录与逻辑 DB 已定义 | 由 §23 约束依赖；仍需 SQL migration |
| §7–§8 | 保存/版本/Plain Text 覆盖关键流程 | 文件-事务一致性与并发验证仍需做 |
| §9–§10 | API 和搜索形式明确 | OpenAPI、中文检索性能/正确性未实测 |
| §11 | React 与 Logo 设计可执行 | 需真实品牌资源和视觉回归 |
| §12–§13 | 种子、功能测试齐全度较高 | 需要孤立 DB 与可重复 fixtures |
| §14–§15 | 运维和 Build 方向明确 | §24 给性能硬指标；生产恢复要演练 |
| §16–§18 | 决策、Logo | 品牌二进制尚未真正入库 |
| §19–§20 | Office / CAD 强交付范围明确 | 最大第三方许可证与硬件风险 |
| §21–§22 | 集成验收较清楚 | 不能用未执行 PoC 证明支持 |
| §23 | 新增强制分层治理 | AG01–AG16 在代码库中落地前不算通过 |
| §24 | 新增性能合同 | p95/p99、数据集、机器配额尚需实际测量 |

## 6. 推荐的工程前置审查包（不进入正式 Build）
GATE-A：真实 PostgreSQL migration + 事务状态机 + API OpenAPI 契约。
GATE-B：Office/CAD/Logo 资源与合法许可可用性 PoC，以及目标机容量报告。
GATE-C：100k 文件基准数据生成器设计、Go/TS 架构 import-lint 设计、性能测试脚本和预算审批。
GATE-D：DEC-15 已决定全新数据域；验证新 PostgreSQL/BLOB_DIR、受控 bootstrap、旧归档保全，完成新数据备份恢复和入口回退 runbook。
上述 GATE 使用隔离环境和可删除 spike 允许研究性验证，但不得修改旧 Node 的代码/数据，不能拿 PoC 替代完整 Build。
所有结果状态分：SPECIFIED → IMPLEMENTED → TESTED → RELEASED；设计报告只能处于 SPECIFIED。
用户此前明确的业务决策已回填，但 **目前整体建议：NO-GO（不允许无约束进入 Build/部署）**。

## 7. 可操作的下一执行顺序
1. P0-06 已由用户确认：不迁移 Node/SQLite，采用新数据。仍需核实目标机资源、初始化安全和新系统可交付性。
2. 单独补齐 migration、OpenAPI、架构边界检查脚本与基准压测计划（可多文件，主 SPEC 作为索引）。
3. 在隔离环境完成 Office、OCCT/DXF、DWG 许可与 Logo 导入验证，形成适用格式和成本报告。
4. 执行架构/安全/正确性/性能测试先行垂直切片；每完成一个功能提供测试和性能证据。
5. 用户确认后才能正式切换入口；旧 Node/SQLite/blob 保留隔离归档、绝不复制进新库；8091 在此前保持不动。
