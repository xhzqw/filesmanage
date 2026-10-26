# DHF V0.8.0 — 主系统兼容增量部署与回退证据（2026-10-25）

> 状态：仅 **开发环境 Review GO**；企业正式 Gate / CDW 发行 **NO-GO**
> 原系统基线：远端 `main` `9dbfd7b`
> 试点功能来源：`feat/dhf-v06-gate-pilot` `931a773`，结构性移植，不可直接 Git merge
> 兼容整合分支：`feat/dhf-v080-main-compatible`（`fb19f83` 起）
> 环境：`10.144.144.1:18091`，**原数据库 `filesmanage_v21` / 原账号 / 原文件**
> 生产 `8091`：未修改

## 发现的真实版本冲突

原业务 `main` 是独立的较新 Git 历史，带有 CDW、DHF 九阶段、项目数据库及到 `0074_project_database.sql` 的 **76 条已应用迁移**。旧试点分支在 `0043`–`0060` 号部署了另一组 DHF 表。两个目录 Git 历史无共同祖先，也存在迁移版本重号，**不可以覆盖原来的文件、数据库或前端登录页**。

## 采取的增量兼容方案

1. 从原业务代码 `9dbfd7b` 建立隔离整合工作树，同时复制并保留用户原有的三处未提交工作台修改（`CDWWorkbenchHome.tsx`、`DHFHomeProjects.tsx`、`cdwWorkbench.css`）。**原工作树三处修改依然未提交、未覆盖。**
2. 只移植不重名的 67 个新 DHF 领域、适配器、接口与测试 Go 文件、9 个 DHF Workbench TSX 面板、RareUI 样式，再在原路由与审批页面增量添加 pilot 入口。保留原 `DHF 九阶段验收`、CDW 和登录页面。
3. 将试点 18 条全新 PostgreSQL 迁移编号映射到 `0075`–`0092`，所有原有 `0001`–`0074` 迁移与表均保留。试点新模型的 `dhf_pilot_*` 状态不代表原 DHF 正式 Gate 放行；二者不会自动互相授予批准权。
4. 原登录 Logo 与展示背景的构建后 SHA-256 完全一致；原账号密码与 Session 配置照旧，绝不使用示例库覆盖原业务库。
5. 发布目录为 `/root/repository77/filesmanage-dhf-v080-compat-release-20261025`，与原主目录完全隔离；源码保存在远端整合 Git 分支。
6. 使用原业务密钥配置，覆盖 Blob 路径为其原有绝对位置（`/root/repository77/filesmanage-v21/.blobs`），数据库沿用 `filesmanage_v21`。

## 两轮兼容验证与执行记录

| 验证 | 实际结果 |
|---|---|
| 在原业务 PostgreSQL 备份的数据库副本上应用 76+18 条迁移 | **94/94 PASS** |
| 使用原应用数据库账号而非 postgres 超级用户在另一副本上升级 | **94/94 PASS** |
| 真实 PostgreSQL DHF 提交/签审/权限/整改集成测试 | **PASS · 13.73 s** |
| 原用户身份在克隆系统的 `/api/me` 与原 DHF 项目接口 | **200** |
| 新 DHF tasks、conditional-plans、independent-gate-review 接口 | **200**（用原账号副本测试及正式切换后） |
| Go server+migrate 构建、`go vet ./internal/...` | **PASS** |
| Vite/TypeScript 前端生产构建与 RareUI 审查 | **PASS** |
| UI 样式治理 | **64 stylesheets PASS** |
| RareUI 组件治理 | **152 TSX PASS** |
| 登录 Chromium 测试（真实 Logo、展示背景、交互、900px/390px） | **LOGIN_BROWSER_OK**，切换前后均通过 |
| 原业务文件库、数据库主表、账号与未提交代码 | **保留** |
| 其他正式 Gate 企业授权、CDW 受控发行的证据 | **NO-GO** |

特别说明：既有 `cdw_workbench_browser_check.mjs` 的部分旧断言要求已被当前工作台改版取消的 `.cdw-home-heading` 元素，因此该原有脚本 **FAIL（过期选择器）**，不应写作 PASS。上线前的 Chromium 登录验收、原 DHF/CDW 实际主页面渲染以及受保护接口均另行核验。

## 原数据库保护、回退

- 完整 pg_dump 备份：`/root/repository77/filesmanage-dhf-v080-backups/filesmanage_v21_pre_v080_20261025.backup`（root-only 0600，`pg_restore -l` 校验）
- 新增 `0075`–`0092` 时，数据库凭据使用原应用账号，**只新增 DHF 独立表/约束及记录迁移版本**。
- 原服务二进制和原前端资源仍在 `/root/repository77/filesmanage-v21/.bin/server` 和 `web/dist`；未覆盖。
- 如果新发布服务异常，先按 PID / `/proc/<pid>/exe` 核对并停止 `18091` 新服务，再从原工作目录加载原 `.secrets/server.env`、启动 `./.bin/server`。新增独立 DHF 表可留在数据库中，对旧版本为向后兼容额外对象；不可盲目回滚旧业务表。
- 本次只切换远端 **开发端口 18091**；`8091` 和生产入口没有部署动作。

## 尚未宣称完成的范围

正式企业签名授权、CDW 发行/培训/签收、真正的 pilot `accepted` 状态放行、Pilot/Legacy DHF 双账本自动映射、完整受登录保护的所有界面交互 E2E、并发压力验收、及新增路由对主分支 OpenAPI 文档的合同合并，仍需分别复核。当前可供用户在原系统里实际 Review，不代表企业正式验收。
