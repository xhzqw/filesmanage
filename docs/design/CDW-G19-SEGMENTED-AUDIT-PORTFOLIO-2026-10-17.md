# CDW G19：跨审批文件统计与分段审计证据

G19 复用 G18 文控审计请求及正式审批权限，**不另建审批系统或公司外部通知通道**。本轮只使用原业务授权及持久化审批事实，绝不因为多一个“统计”页面就放开文件读取权限。

## 分段导出协议

- `GET /api/workbench/qms-formal-lineage/{id}/audit-segmented`：具现行 `document_control` 资格和全部文件实时预览权限的文控可从任一审批 ID 导出。服务端在 PostgreSQL **REPEATABLE READ 事务**中获取完整有界链，审计读取限 **512 节点**；每 **16 节点**拆成一个独立负载，包含对应节点、所有流程步骤（含未签/跳过）、签字事实/授权快照、逐人通知及督办事实。全包一次性返回，所以各段是同一数据库快照的证据。
- 分段负载以 `payloadBase64` 存储 JSON 的原始 UTF-8 字节。段摘要计算为 `SHA256("cdw-qms-segment-v1\\n" + index + "\\n" + firstApprovalId + "\\n" + lastApprovalId + "\\n" + previousSegmentSha256 + "\\n" + decodedPayloadBytes)`，防止重新编码 JSON 后摘要不一致；每段附本段首尾审批 ID 和前一段 SHA，整包包括 `totalNodes`、`totalSegments`、`rootApprovalId`、`lastSegmentSha256` 和 `complete`。服务端在提交审计事实前验证缺段、错序、签署血缘不连续、摘要篡改、焦点审批缺失及统计总数。
- 常规 G18 审计仍保留 31 节点上限以兼容旧客户端；G19 分段导出超过 512 节点时**失败关闭**，不返回伪称完整的截断文件。响应附 `X-Content-SHA256`（整个响应文件字节），留痕为导出**请求**而非客户端实际收到文件；摘要证明自此服务端导出的证据字节一致，不具有法规电子签名法律效力。
- **离线校验**：审计人员在可信环境中运行 `python3 scripts/verify_cdw_segmented_audit.py CDW-QMS-segmented-audit.json`，无需访问数据库即可复核分段摘要、前后继连续性、节点总量和事实范围，校验失败返回非零退出码。开发合同测试 `python3 scripts/check_cdw_audit_verifier.py` 使用 33 节点/3 段模拟及四类篡改负例。校验只能证明同一导出包内的数学一致性，不能证明签名本人身份或没有经过特权后台篡改。

## 跨文件统计的边界

- `GET /api/workbench/qms-formal-portfolio` 只返回当前用户具有实时文控角色且当前文件预览 ACL 允许的**最多100个最近有正式审批的文件**，按最新审批时间排序；每文件显示所有审批次数、具有中断事实的冲突次数、正式血缘重启次数、待签数量、批准数量及未确认通知数。显示是否被 100 项上限截断，不以该结果计算全公司质量合规率。
- UI 复用现有 DHF/DMR 专项文控工作台的紧凑列表；G19 分段下载复用 G18 正式审批追溯组件。无新全局导航、无额外设计体系。

## 通知升级权限策略

- G18 的一次性人工督办、个人确认及不可变审计仍为唯一可执行的提醒操作。**截至本期，未取得明确、已经生效的公司通知升级程序和合法发送渠道，因此不安装任何自动升级任务、不设置默认 SLA、不自动将未读认定逾期违规。** G19 不伪造制度来源或任命；后续只有取得有效受控版本中的责任角色、具体时间阈值和批准的渠道，才能设计独立的升级状态机。

## 完成前验收要求

- G19 必须验证：32+ 节点分三段、片段顺序缺失和 SHA 篡改拒绝、重启父子链、现有每次签字证据、逐文件角色 ACL 统计；并通过全新临时 PostgreSQL **70 项迁移**与 G2–G19 回归、Go/TypeScript/OpenAPI/架构、Chrome 1440/1024/780，最后只对 18091 进行真实部署。8091 与用户原有质量制度及未提交文件不可触碰。

## 2026-10-17 执行与复核

- Git `6019296`：G19 受控文控跨文件统计、512 节点上限的分段链查询、分段摘要连锁、相同 MVCC 快照导出、Go 正反例和工作台集成全部提交并推送；`ba6144a`：独立离线校验工具与 33 节点/3 段四类反绕过测试提交并推送。OpenAPI 已升级至 **227 paths / 263 operations**。没有本轮专用迁移。
- 全新隔离 PostgreSQL `cdw_g2_tasks_iso_20261015_f5c7d030034dfc4e`：`MIGRATIONS_OK 70`、`CDW_G19_SEGMENT_PORTFOLIO_PASS`，原 G2–G18 正反例全部通过，最终 `CDW_FRESH_LAB_DROPPED`。G19 包含独立 G17 正向血缘读取及文件级统计断言。
- 在远端完成 `go test ./internal/application -run TestCDWQMSG19`，33 节点生成 3 段，验证摘要、缺段、乱序、负载篡改及完整性标志；`python3 scripts/check_cdw_audit_verifier.py` 输出 `CDW_G19_OFFLINE_AUDIT_VERIFY_PASS`。
- 前端 `tsc --noEmit`、Vite（726 modules）、后端 Go build/vet、HTTP 定向测试、OpenAPI 漂移及架构检查通过。旧 Three.js 体积和混合加载警告仍存在，非 G19 导致。
- 开发端 18091 使用 `ba6144a` 重建后端并启动原 worker，连续两次 `health/ready OK`。真实 Chrome `CDW_LAYOUT_PASS`（1440 / 1024 / 780）及 `CDW_G19_SEGMENT_PORTFOLIO_BROWSER_PASS`，G6–G18 浏览器回归继续正常。
- 浏览器验证为真实登录、空数据/当前权限视图、伪造审批拒绝；**真正的 32+ 节点导出一致性**由服务端 Go 单元测试、隔离数据库正向事实测试及独立离线验证工具承担。没有在公司开发库创建虚构监管批准或审批角色。
- 自动法规升级维持关闭，直到相关正式有效受控文件明确责任人、SLA、升级条件和渠道。原始 `docs/流程参考文档/`、8091 及用户未提交文件均未改动。
