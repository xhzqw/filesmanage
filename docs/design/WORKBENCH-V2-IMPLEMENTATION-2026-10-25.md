# Workbench V2 — 工作台整体重构（首个工程交付）

日期：2026-10-25
代码分支：`feat/workbench-v2`
基线：`feat/knowledge-workspace-isolated`
变更审查：Draft PR #3
发布许可：**仅代码 Review；测试门禁完成且浏览器复验前不得覆盖 18091。**
生产 8091：**未操作**。

## 产品边界

**此次只重构工作台。** Finder 文件管理、文件夹视图、文件预览主结构、拖拽复制、受控文件版本、品牌 Logo、登录背景与文件存储均保留，未在此分支修改。这是用户已明确限定的不可变边界。

Notion 式知识编辑器属于工作台中的项目知识工作区，不再是主导航上的独立系统。历史 `/knowledge?...` 链接被安全地重定向至 `/workbench?view=knowledge&...`，不会丢失 `page` 等查询参数。

## 交付结构

### 个人工作

- 工作首页：当前受控文件待办、我发起的、退回需整改、等待其他人处理四类状态，点击查看原处理队列。
- 独立审批系统及 DHF 签审数量单独请求、单独显示，读取失败显示破折号而非假装零待办。**不把不同业务系统的数据未经归并就伪称为统一待办数字。**
- 按审批验收、工作整改、签收阅读筛选；退回项优先排序；工作行展示来源、实际状态、下一步建议，并打开既有受控处理流程。
- 可直接发起文件修订、DHF 项目或客户登记。

### 审批与 Stage Gate

- **原 ApprovalInbox 和 ApprovalReviewDialog 原样复用**并内嵌 `?view=approvals`，保留原审计、责任链及后端权限。
- DHF 统一操作视图 `?view=dhf-operations`，按「待处理」「阶段决策」「治理」分组，七类事项直接调用既有组件。
- Gate 独立复核与条件整改预案继续仅为建议与预案，**不等于正式 Gate 审批或条件放行**。
- 修复了 DHF 责任链读取被前一个 `useEffect` 的提前 `return` 跳过的问题；将责任链与签审任务放在两个可独立清理的 Effect 中。

### 项目与知识

- 保留现有 `ProjectDatabase` 及 `DHFHomeProjects`。
- `KnowledgeWorkspace` 支持 `embedded`，直接渲染在工作台同一画布和导航壳内；原 API、修订历史、版本冲突控制、页面双向关联保留。
- 页面编辑与引用的授权仍由后端 ACL 判定，前端入口不能单独授予文件预览/审批权。

### 交互规范

- 工作台左栏按「个人工作 / 项目与知识 / 审批与 Gate / 受控文件工作」重新组织。
- 常用操作置顶、低频工具折叠，选中态、深链接、回退与查询参数同步。
- `workbenchV2.css` 完全局部作用于工作台；沿用 RareUI CSS tokens、冷灰底座、白色嵌入画布，响应宽度 1150/800/540。
- `prefers-reduced-motion` 关闭不必要动画。

## 测试与门禁

- `node scripts/workbench_v2_contract_check.mjs`：断言 Finder、预览无知识页侵入，工作台真实包含审批、Gate、知识及旧链接兼容能力。
- 新增 `.github/workflows/workbench-v2-checks.yml`，自动执行前端 `npm ci`、TypeScript + Vite build、UI 样式治理、组件治理，以及 Go internal tests/vet。
- Draft PR #3 基于修复后的知识工作区分支；GitHub `main` 与现用分支没有共同祖先，不得直接将 PR 误合并进 main。
- 首轮 CI Go 和前端均 PASS；后续各修订由相应 CI workflow 复验，具体结果见 PR。
- 尚缺隔离开发机 authenticated browser E2E、DHF/CDW 路由跳转视觉复测、CDW 与审批并发回归、正式环境切换，因此不对 `18091` 宣称已部署。

## 实际部署要求

1. 先确保远端原文件管理/预览代码仍与基线完全一致；
2. 创建隔离构建及原开发数据库备份，使用原数据库与 Blob 目录；
3. 在独立候选端口登录，浏览器检查 1440/1024/760/390px；
4. 从 Workbench 首页分别打开 CDW 待办、审批、DHF Gate 和知识页面并回退，确认导航状态；
5. 再切换 `18091` 并执行登录品牌和核心旧业务复验，保留可一键回退旧二进制；
6. 无权或无测试证据时不切换、不声称已上线。
