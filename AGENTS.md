# AGENTS.md — filesmanage v2.1 本地工作副本

## 这个目录是什么

- 本目录是远端正式仓库的 **git 工作副本**（`origin = target22:/root/repository77/filesmanage-v21`），
  只用来**看代码和写代码**。
- **应用不在本地运行。** 构建、启动、测试、验收门禁一律在远端完成。
- 远端（唯一事实来源，2026-10-09 经用户确认）：
  - `root@192.168.1.22:/root/repository77/filesmanage-v21`（SSH 别名 `target22`）
  - 本机不可达时经 `10.144.144.1`（同一台机，主机名 `openclaw77`）
- 技术栈：Go >= 1.22 + Gin + PostgreSQL 17 + React 18 + TypeScript + Vite（SPEC v2.1）。
- 旧 Node/Express/SQLite demo 已于 2026-10-09 删除（原目录在废纸篓
  `~/Trash/filesmanage-node-old-20261009`）。它是历史行为参照，不是事实来源，
  不得恢复、不得参照其结构改本仓库。

## 硬性规则

1. **禁止在本地运行、构建或启动任何服务。** 本地 clone 按设计没有 `.secrets/`、
   `.blobs/`，也没有 PostgreSQL / ONLYOFFICE 环境；本地跑不起来也不该跑。
2. **本地 `main` 必须与 `origin/main` 保持一致。** 动手前 `git pull`；改完
   `git commit` + `git push`。远端已开启 `receive.denyCurrentBranch=updateInstead`，
   可直接 push 到远端的 checked-out `main`；禁止 `git push --force`。
3. **生产端口 8091 未授权（BLK-05）。** 远端 dev 服务只监听 `18091`。不得占用
   8091、不得安装 systemd 单元、不得切换生产入口。
4. **密钥不出远端。** `.secrets/`（admin 口令、server.env）为 root-only 且被
   `.gitignore` 排除，禁止复制到本地、禁止写进任何提交。需要口令时在远端读取。
5. **本文件已纳入版本控制，且是所有 Agent 的项目约束。** 规则调整须随代码提交并推送，确保本地工作副本和远端仓库保持一致；不以口头约定或临时聊天消息替代。

## UI/UX 强制布局规范（用户明确要求，2026-10-10）

1. **禁止把桌面页面默认设计成“从上到下铺满整页”的多段大块堆叠**（例如：顶部整宽说明、整宽创建表单、整宽大选择器、底部才是数据表）。信息架构必须以当前用户任务为中心，在桌面宽屏优先使用**左右分区的紧凑工作台**：左侧筛选/资源导航/快捷操作，右侧主要结果、详情或数据列表。按功能合理设置比例，避免空置的大块白区。
2. **主要内容优先展示**：默认标签页必须是此页面最常用的任务视图；创建、编辑等低频任务用侧栏、抽屉、弹窗或紧凑工具区呈现，不得把主列表挤到首屏下方。共享/关注页的默认第一入口是「关注」，不是「与我共享」。
3. **布局优先看实际工作区宽度**，兼容可调整侧栏，禁止控件溢出父容器、错列或由全局按钮规则导致居中。列表、资源树等长内容须在自己的受限区域滚动；窗体不应产生页面级水平滚动。窄屏（约 820px 以下）确有必要时才允许响应式上下重排。
4. **UI 统一、克制、简洁**：复用 RareUI 语义控件、系统 token、适度圆角与统一间距。能用清晰标签表达就不要写大段说明，不要无意义多重卡片/边框、超大留白、重复标题或巨大的独立按钮。
5. **交付前必须做真实尺寸验收**：至少桌面宽屏、普通笔记本、窄内容区三个工况；重点检查初屏主要内容可见、滚动归属、控件排列、下拉/弹窗层级、溢出和空状态。仅编译通过不等于 UI 验收通过。所有构建、运行和验收仍严格只在远端机器进行。
6. **功能 UI 去重属于硬性要求（2026-10-12 再次强调）**：相同业务动作不能因为入口、弹窗、页面不同而各自复制一套操作控件/字段/状态显示。先检查已有组件与入口，再复用同一个受控组件或抽取共享组件；保留不同场景必需的授权确认与权限边界。每个页面一个主操作入口，空状态、工具栏、编辑态不得同时出现重复的“新增/返回/确认”按钮。禁止用额外重复标题、密集边框、多层卡片和冗长说明制造所谓高级感；优先排版、留白与一层必要的结构分隔。

## 日常协作流程

写代码（本地）：

```bash
git pull                 # 同步远端最新
# ... 编辑 ...
git add -A && git commit
git push                 # 推到远端 main，远端工作树同步更新
```

部署与运行（远端，永远在远端）：

```bash
ssh target22
cd /root/repository77/filesmanage-v21
bash scripts/build.sh --with-tests          # web → go → vet → 架构/OpenAPI/矩阵门禁 → 测试
go build -o .bin/server ./cmd/server        # 改了 Go 代码必须重新产出二进制
bash scripts/run-dev.sh stop && bash scripts/run-dev.sh start
bash scripts/run-dev.sh status              # 健康检查应输出 health/ready OK
```

- 访问：`http://192.168.1.22:18091`（LAN 内；经 `10.144.144.1:18091` 亦可）
- 账号 `admin`；口令在远端 `.secrets/admin.password`（0600）
- 日志：`.bin/server.log`、`.bin/worker.log`

## 验收门禁

全部在远端执行，完整清单见 `docs/OPERATOR-RUNBOOK.md` §4（架构、OpenAPI 漂移、
验收矩阵、迁移、未授权安全、S 矩阵、CAD、DOCX、压测、备份恢复等 30+ 项）。
改动涉及路由或验收项时，先重新生成再提交：

```bash
python3 scripts/gen_openapi.py
python3 scripts/gen_acceptance_matrix.py
```

## 目录速览

| 路径 | 内容 |
|---|---|
| `cmd/` | `server`（API）、`worker`（CAD 转换）、`migrate`、`bootstrap` |
| `internal/` | Go 业务代码 |
| `web/` | React + TypeScript + Vite 前端 |
| `migrations/` | PostgreSQL 迁移 0001–0011 |
| `scripts/` | 构建、run-dev、全部验收门禁脚本 |
| `docs/` | SPEC v2.1、OPERATOR-RUNBOOK、验收证据 |
| `docs/design/` | UX 设计合同包（DESIGN-SYSTEM / DESKTOP-INTERACTION / COMPLEX-WORKFLOWS / UX-ACCEPTANCE，草案，按 G0–G5 门禁实施） |
| `deploy/` | systemd 单元（**未安装**，BLK-05） |
| `.secrets/` `.blobs/` | 仅存在于远端，gitignore 排除 |
