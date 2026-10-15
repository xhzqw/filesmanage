# CDW G4 — 直属验收、退回重提、冻结稿下载（2026-10-15）

> 阶段：**开发版 18091 已部署；任务交付验收内核通过 PostgreSQL 隔离集成测试；完整受控文件体系仍 NO-GO。**

## 1. 本批交付

- 直属上级验收列表、详情和决策：`GET /api/workbench/review-gates/inbox`、`GET /api/workbench/review-gates/:id`、`POST /api/workbench/review-gates/:id/decide`。依实际登录人、当前文件预览权限、任务最新轮次、gate 的 revision/状态，依事务锁校验。仅直属责任审核人有效；不凭管理员身份直接越级。
- 冻结稿：`GET /api/workbench/review-gates/:id/content`，认证后按 gate→delivery_item→Blob 精确返回快照 DOCX，禁止把普通 `current_version_seq` 的文件错当此冻结交付。
- 退回执行人：`POST /api/workbench/tasks/:id/resume`。返回状态下同一现时责任人才能恢复，新轮次 + 新分支，**继承上轮冻结交付 Blob/SHA 的首个分支修订**，不是重新从原始 formal file_version 编辑；需再次最终保存回执和交付冻结。
- 事务中写入不可变 review_decision、return_order、领域事件、审计及 outbox；幂等请求可回放原交付/决定，独立 CAS 避免并发双决定。
- 旧交付、旧 gate、归档修订不可覆盖。直属验收通过仅将任务改为 `accepted_delivery`，不能自动 `closed` 或 `release`；B/A 等中间管理/整合/上报义务仍 `pending`。
- 前端 Finder / RareUI 的「任务」增加「待我验收」标签，详情展示准确冻结稿 SHA、下载、验收通过/退回原因表单；「已退回」任务显示从退回稿继续修订。
- G3 单文件任务每轮最多一个活动工作分支，防止不同请求创建两个竞态分支；担任父任务工作组负责人的 reviewer 调岗或被撤销角色后会被拒绝决定。

## 2. 验证凭据

- 专用 PostgreSQL 17 测试库：`CDW_REVIEW_POSTGRES_PASS`，覆盖：A→B→C、未授权审核拒绝、退回必须给出理由、同键幂等、同 gate 仅一次决定、只有原执行人恢复、新轮次继承同一旧 SHA、第二轮重新保存并冻结、第二轮审核通过后六项义务继续 pending、正式 `file_versions` 不变。
- `bash scripts/build.sh` 全部核心步骤 PASS：TypeScript/Vite、RareUI 组件所有权、UX/Toast 门禁、Go build/vet、架构、OpenAPI（153 paths）、验收矩阵。
- 真实远端 Chrome 认证会话：`CDW_BROWSER_PASS`，任务/验收 inbox 均 HTTP 200、待我验收标签可选、创建表单可打开、1440/1024/780 三种尺寸无横向溢出。
- 开发环境 `18091` 服务已重启及健康检查成功，`18080/healthcheck` ONLYOFFICE Document Server 200，`8091` 未碰。

## 3. 不夸大的未完成事项

1. 不包含 `override_grants` 越级批准/替代 gate API；虽然数据结构存在，本期**不支持越级代签**，中间人的责任始终保留。
2. 不包含独立 `formal_approval`、发布生效指针、受控分发、部门签收及个人阅读回执，也不包含培训。
3. 真实 ONLYOFFICE 浏览器**编辑→callback→本地持久化→冻结**的自动化全链路仍未独立验证。当前依据的是持久化数据库事务负例、JWT 校验与命令 HTTP 仿真；`18080` 健康 200 只说明服务可达，不说明整个编辑闭环成功。
4. 任务及验收 inbox 每次最多 100 条，没有 cursor 分页；高密度生产待办与正式监管 G0 门禁不应提前启用。
5. 这轮没有改数据库 schema，也不清理生产/开发业务库与文件 Blob。仅对已上线的 CDW 迁移结构增加事务和 UI。

## 4. 下一门禁

在严格隔离的数据库/Blob 环境跑真实 ONLYOFFICE 浏览器端到端保存测试（含 30 分钟以上会话续约、回调乱序、未知保存状态），再补授权越级审批但不免除中间责任、审核历史和受控发行。
