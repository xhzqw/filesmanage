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
5. 本文件（AGENTS.md）是有意不提交的本地指引，保持本地工作树与远端一致。

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
| `deploy/` | systemd 单元（**未安装**，BLK-05） |
| `.secrets/` `.blobs/` | 仅存在于远端，gitignore 排除 |
