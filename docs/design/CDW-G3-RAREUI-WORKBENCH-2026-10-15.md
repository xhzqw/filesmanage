# CDW G3 工作台 UI — 开发部署与 Chrome 验证（2026-10-15）

## 1. 实施范围

- `/workbench`（导航名「任务」）：AppShell + RareUI 的浅灰无界底座与白色内嵌画布。宽屏三栏：分类 168px，任务列表 360px，详情自适应；普通笔记本与窄工作区按断点收敛，列表及详情独立滚动，不产生全页水平溢出。
- 用户可查看当前已授权任务和待履行责任，接收单文件任务，向 ACL 可见的人员下派并保留自己的管理/整合/上报义务。管理员可按文件名搜索 DOCX、选择负责人并创建根任务。
- `/workbench/branch/:id/edit`：复用 ONLYOFFICE DocsAPI、共享脚本加载器和原生编辑器保存体验。业务操作「提交交付校验」触发已部署的强制持久化请求；只有严格匹配回执状态 `persisted` 和分支修订 CAS 后显示「冻结并提交验收」。不用 ONLYOFFICE 本地 cache 状态伪造保存成功。
- 新增两个权限收紧的只读 API：`GET /api/workbench/tasks/:id/branches` 与 `GET /api/work-branches/:id`。查询只允许现时任务已接受指派人及工作组有效负责人，返回已授权分支与修订，便于页面刷新和恢复。
- 只共享既有 RareButton/RareInput/RareSelect/RareBadge/RareNotice、AppShell、Toast、BrandLoader；未引入第二套全局控件和持久存储。

## 2. 验证

- 远端 `npm run build`、`bash scripts/build.sh`、`go test ./internal/application ./internal/httpx ./internal/adapter/postgres -run '^TestCDW'` 成功。
- `scripts/check_architecture.py`、OpenAPI 漂移（148 paths）、验收矩阵一致性成功。
- 使用真实远端 Chrome 和受认证会话运行 `node scripts/cdw_workbench_browser_check.mjs`：`CDW_LAYOUT_PASS` 宽度 1440 / 1024 / 780，主体无横向溢出；`CDW_BROWSER_PASS` 身份态任务 API 200、分类切换、管理员派发面板正常。脚本只读、**不创建真实任务**。
- 独立 PostgreSQL 集成测试 `CDW_BRANCH_POSTGRES_PASS` 和 `CDW_TASK_POSTGRES_PASS`，新增验证一名任务责任人不可读取另一人的工作分支。
- 开发服务器 `18091` 已构建重启，`/workbench` HTTP 200；**未触碰生产端口 8091**。

## 3. 本期边界 / 待完成

- 无训练系统及训练率口径；不会将任务派发等同于正式审批或文件生效。
- 首个直属上级 review gate 目前只能创建、显示待处理，**尚无逐级审核决定/越级授权/退回重新提交**的完整事务/UI，必须后续实施。
- 使用单文件（DOCX）与独占编辑分支，尚无跨文件资料包、协作实时编辑/分支合并。
- 尚未通过真实 ONLYOFFICE Document Server 在浏览器中编辑和最终持久化回调的独立 E2E；当前校验由回调 JWT 负例、真实 PostgreSQL 事务以及模拟 command HTTP 组成。
- 待办 API 当前最多 100 条，没有 keyset 分页；如果用户超过 100 条，工作台不可声称全量。该阶段明确保留后续分页实施。
- 没有为演示向现有业务库插入任何样本或重置任何 Blob；测试数据只进入明确隔离的 PostgreSQL 17 测试库。
