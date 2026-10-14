# AGENTS.md — filesmanage v2.1 本地工作副本

## 这个目录是什么

- 本目录是远端正式仓库的 **git 工作副本**（`origin = deploy-host:/srv/filesmanage`），
  只用来**看代码和写代码**。
- **应用不在本地运行。** 构建、启动、测试、验收门禁一律在远端完成。
- 远端（唯一事实来源，2026-10-09 经用户确认）：
  - `ops@203.0.113.10:/srv/filesmanage`（SSH 别名 `deploy-host`）
  - 本机不可达时经 `203.0.113.1`（同一台机，主机名 `filesmanage-host`）
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
7. **导航页面不许再增加“页面名称”独占整行（2026-10-12）**：主导航已高亮的“统计/共享/关注/组织与权限/生命周期/回收站”等，工作区紧贴业务筛选、列表或工作台，不渲染单独的 `breadcrumb`、`h1` 标题条，也不能留下等高空容器、背景边框和上边距。若同一行还有刷新、过滤等操作，移入现有功能工具栏，不另开一行。**例外**：文件夹真实层级路径、可点击的布局标签、包含文件名和格式的工作台上下文必须保留；有用的返回链接要合并到现有操作区，不能静默删除。回归门禁见 `scripts/rare_emil_interaction_check.mjs`。
8. **技术实现细节不得常驻普通用户界面（2026-10-13）**：延迟毫秒数、构建版本号、调试标志、原始接口状态和内部统计不得出现在面向用户的固定底栏、标题栏、文件卡片或主要操作区。确需展示时放在经用户主动开启的账户/设置/诊断详情中，并使用通俗名称。状态栏仅保留当前任务有用的文件数、选择数等业务信息；隐藏技术信息不得削弱服务端日志、可观测性和故障排查能力。

## RareUI × Emil Skills 交互审查原则（2026-10-12）

- RareUI、现有主题 token 和共享组件是唯一运行时 UI 体系。Emil Kowalski 的 Skills（https://github.com/emilkowalski/skills）用于 Agent 设计工程审查，不得借此引入第二套 Toast、Dialog、Select 或 CSS 体系。
- 修改交互前优先参照 `emil-design-eng` / `break-ui` 审查布局和极端数据；动画用 `animate` 设计、`review-animations` 复核、`animation-performance` 检查卡顿。引用的是上游方法，不代表已把外部技能安装进运行时。
- 动画先论证必要性，不能为装饰而增加；高频操作宜短、可中断，尽量只改变 `transform` / `opacity`，尊重 `prefers-reduced-motion`。禁止 `transition:all`、`scale(0)` 入场和无意义反复动效。
- 全局 Toast 位于屏幕中间上方，文案简短；异步过程由一条通知从 loading 更新为完成/失败，不叠加页面级成功提示。Hover、焦点和页面隐藏要暂停有限时长 Toast，退出动画要与自动消失时机一致。
- 文件拖拽只能呈现文件名和必要数量，保留上传/内部移动的隔离。源项、合法目标、非法目标和取消操作均应有唯一明确的反馈；放下后的移动仍需走服务端预检/权限/同名冲突流程。
- **全站 OS 文件拖拽上传属于不可回退的基础能力（2026-10-13）**：登录页以外所有已认证页面必须接收从系统文件管理器拖入的文件；文档管理页仅在当前目录真实解析并且显示文件列表时直接上传到该目录，拖到具体文件夹行/卡片时优先上传到该文件夹；其他页面及关注/共享视图须先弹出共享目录选择器，确认后才加入既有上传队列。取消/离开不得入队；不允许将内部文件移动误识别为 OS 上传；必须保留上传进度、服务端权限校验与队列复用。任何全局导航/页面布局重构不得移除此能力；远端 Chrome 回归脚本为 `scripts/global_upload_browser_check.mjs`。
- 每批 UI 变更通过桌面/窄工作区、长文件名、空/大数据集、多选、键盘与减少动态效果实测；静态门禁只能防回退，不能替代远端 Chrome 验收。工作清单见 `docs/design/RARE-EMIL-INTERACTION-AUDIT.md`。

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
ssh deploy-host
cd /srv/filesmanage
bash scripts/build.sh --with-tests          # web → go → vet → 架构/OpenAPI/矩阵门禁 → 测试
go build -o .bin/server ./cmd/server        # 改了 Go 代码必须重新产出二进制
bash scripts/run-dev.sh stop && bash scripts/run-dev.sh start
bash scripts/run-dev.sh status              # 健康检查应输出 health/ready OK
```

- 访问：`http://203.0.113.10:18091`（LAN 内；经 `203.0.113.1:18091` 亦可）
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
