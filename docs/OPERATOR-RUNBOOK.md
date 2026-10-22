# filesmanage v2.1 — 操作手册（Operator Runbook）

目标机：`192.168.1.22`（Debian 13；本机不可达时经 `10.144.144.1`，主机名 `openclaw77`）
工程目录：`/root/repository77/filesmanage-v21`
业务数据库：`filesmanage_v21`（PostgreSQL 14+，迁移 0001–0011 已应用）
开发服务：`0.0.0.0:18091`（LAN 白名单外拒绝）｜压测实例：`127.0.0.1:18092`（库 `filesmanage_perf`）
文档编辑：自托管 ONLYOFFICE Document Server 8.2.2（Docker 容器 `filesmanage-office`，端口 18080）
内部 HTTPS（LAN/VPN）：`https://192.168.1.22:18443` 或 `https://10.144.144.1:18443`；在线编辑器 HTTPS `18444`。独立内部 CA 的安装、信任、验证及回退详见 [LAN-HTTPS.md](LAN-HTTPS.md)。旧 `18091` HTTP 为兼容过渡期入口，尚未关闭。

> 生产端口 `8091` **未授权**（BLK-05）。在获得明确授权前，不得占用 8091、不得安装
> systemd 单元、不得切换生产入口。本手册描述的一切均为 dev 级操作。

---

## 1. 访问与凭据

| 项 | 值 |
|---|---|
| URL | `http://192.168.1.22:18091`（LAN 内；本机访问经 `10.144.144.1:18091`） |
| 账号 | `admin` |
| 初始/当前口令 | `/root/repository77/filesmanage-v21/.secrets/admin.password`（模式 0600，仅 root 可读） |
| 环境变量 | `.secrets/server.env`（0600；含 `DATABASE_URL`、`FILESMANAGE_OFFICE_SECRET`、`FILESMANAGE_ADDR` 等） |
| 压测库连接串 | `postgres://filesmanage_v21:***@127.0.0.1:5432/filesmanage_perf?sslmode=disable` |

取口令的安全方式（不落盘、不进日志）：

```bash
ssh root@192.168.1.22 'cat /root/repository77/filesmanage-v21/.secrets/admin.password'
```

安全边界：会话 Cookie 为 `fm_session`（HttpOnly + SameSite=Strict，24h）；LAN 白名单
`FILESMANAGE_LAN_ALLOW_CIDRS` 默认 `127.0.0.1/32,::1/128,192.168.1.0/24`，按**套接字对端地址**
校验（不信任转发头）；非白名单对端一律 403 `E_NETWORK`。首次登录不强制修改密码，
管理员创建的账号可立即凭所设置的密码使用业务功能；建议运维妥善分发凭据并按需轮换。

## 1.1 从零搭建一个新环境（clean clone 之后）

`.secrets/` 被 `.gitignore` 排除，clone 出来的树里没有它；下列步骤用系统自身的
bootstrap 流程建出环境（**不要**手工设默认密码）。

```bash
cd /root/repository77/filesmanage-v21

# 1) 密钥目录（仅 root 可读）
mkdir -p .secrets && chmod 700 .secrets

# 2) 强随机初始口令（>=20 字符，仅本机留存）
openssl rand -base64 48 > .secrets/bootstrap.password && chmod 600 .secrets/bootstrap.password

# 3) 运行环境（按目标机实际情况填写）
cat > .secrets/server.env <<'ENV'
DATABASE_URL=postgres://filesmanage_v21:<password>@127.0.0.1:5432/filesmanage_v21?sslmode=disable
FILESMANAGE_ADDR=0.0.0.0:18091
FILESMANAGE_COOKIE_SECURE=false
FILESMANAGE_ALLOW_LAN_HTTP=true
FILESMANAGE_LAN_ALLOW_CIDRS=127.0.0.1/32,::1/128,192.168.1.0/24
FILESMANAGE_BLOB_DIR=.blobs
FILESMANAGE_OFFICE_URL=http://127.0.0.1:18080/
FILESMANAGE_OFFICE_SECRET=<random>
FILESMANAGE_OFFICE_SOURCE_BASE=http://192.168.1.22:18091
FILESMANAGE_OFFICE_VERSION=8.2.2
ENV
chmod 600 .secrets/server.env

# 4) 迁移 + 一次性 bootstrap（仅限空数据库）
set -a; . ./.secrets/server.env; set +a
go run ./cmd/migrate -dir migrations
FILESMANAGE_ALLOW_BOOTSTRAP=new-empty-database \
  BOOTSTRAP_ADMIN_PASSWORD_FILE=.secrets/bootstrap.password \
  go run ./cmd/bootstrap

# 5) 初始口令归档为 admin 口令（登录后不强制轮换）
mv .secrets/bootstrap.password .secrets/admin.password
```

验证：`bash scripts/build.sh --with-tests` 全绿，`bash scripts/run-dev.sh start` 后
`curl -s http://127.0.0.1:18091/health/ready` 返回 `{"ok":true}`。

已实测（2026-10-09）：从 clean clone 执行 `bash scripts/build.sh`（无 node_modules、
无 .bin）会自行 `npm ci` 并完成 web → go → vet → 架构门禁 → OpenAPI 漂移门禁 →
验收矩阵门禁，`go test ./...` 4 个包全部通过；`--with-tests` 额外需要步骤 3 的
`.secrets/server.env`（其中含迁移校验所需的 DATABASE_URL）。

## 2. 服务生命周期

```bash
cd /root/repository77/filesmanage-v21
bash scripts/run-dev.sh start    # 构建检查 + 启动 server/worker + 健康验证
bash scripts/run-dev.sh status   # PID + /health/ready
bash scripts/run-dev.sh stop     # 停止（幂等）
```

- 日志：`.bin/server.log`、`.bin/worker.log`、`.bin/perf-server.log`
- 健康：`curl -s http://127.0.0.1:18091/health/ready` → `{"ok":true}`
- 构建：`bash scripts/build.sh --with-tests`（web → go → vet → 架构门禁 → OpenAPI 漂移门禁
  → 验收矩阵门禁 → go test → 迁移校验），失败即非零退出
- **改 Go 代码后必须 `go build -o .bin/server ./cmd/server` 再重启**：`go build ./...` 不会
  产出 `.bin/` 下的二进制，只编译不替换（本手册维护期间实测踩过）

## 3. 压测实例（仅压测门禁需要）

```bash
DATABASE_URL="postgres://filesmanage_v21:***@127.0.0.1:5432/filesmanage_perf?sslmode=disable" \
FILESMANAGE_ADDR="127.0.0.1:18092" FILESMANAGE_DB_MAX_CONNS=25 \
FILESMANAGE_BLOB_DIR=".blobs" FILESMANAGE_LAN_ALLOW_CIDRS="127.0.0.1/32" \
setsid nohup ./.bin/server >> .bin/perf-server.log 2>&1 < /dev/null &
```

**测延迟的门禁（`pe12_cad_saturation.py`、`pe15_heap_growth.mjs`、`loadtest.py`）必须在
perf 实例停止时运行**：perf 实例与 dev 实例共享 CPU 与同一台 PostgreSQL，并发运行会污染
“空闲基线”，曾把 PE12 的比率门禁从 x1.14 推到 x1.64（实测复现，已记录在
`docs/M7-PERF-DATASET-GATE.md`）。

停止后还要**确认进程已消失**再跑门禁：kill 之后立即测量会把仍在释放的连接与 CPU 算进
基线（实测：kill 后 1 秒跑 PE12 得到 4/7，确认进程消失后重跑 7/7）。

## 4. 验收门禁一览（全部在目标机执行）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 架构 | `python3 scripts/check_architecture.py` | PASS（71 Go / 41 TS） |
| OpenAPI 漂移 | `python3 scripts/gen_openapi.py --check` | up to date |
| 验收矩阵 | `python3 scripts/gen_acceptance_matrix.py --check` | 123 PASS / 2 PARTIAL / 1 EXTERNAL |
| 迁移 | `python3 scripts/verify_migration.py` | PASS |
| 未授权安全 | `python3 scripts/unauth_security_smoke.py` | 17/17 |
| 安全 E2E | `python3 scripts/m7_security_e2e.py` | 31/31 |
| S 矩阵 | `python3 scripts/s_matrix_e2e.py` | 35/35 |
| 纯文本保真 | `python3 scripts/pt_samples_e2e.py` | 112/112 |
| 回滚专项 | `python3 scripts/rb_rollback_e2e.py` | 72/72 |
| CAD 矩阵 | `python3 scripts/mc_cad_e2e.py` | 78/78 |
| 多样资源模型 | `node scripts/mc_multiasset_check.mjs` | 15/15 |
| 查看器控件 | `node scripts/mod01_controls_check.mjs --file <id>` | 10/10 |
| 元数据面板 | `node scripts/mod03_meta_check.mjs` | 30/30 |
| 装配树 | `node scripts/mc02_assembly_check.mjs` | 8/8 |
| DOCX 兼容 | `python3 scripts/do05_header_footer_check.py` | 15/15 |
| 堆增长 | `node scripts/pe15_heap_growth.mjs --file <id> --control-json .secrets/perf/pe15-control-10.json` | PASS |
| CAD 饱和 | `python3 scripts/pe12_cad_saturation.py` | 7/7 |
| 数据集 | `python3 scripts/perf_readiness_audit.py` | 12/12 |
| CSV 导出 | `python3 scripts/perf_csv_export_check.py` | 9/9 |
| 上传压测 | `python3 scripts/perf_upload_stress.py` | 10/10 |
| 媒体 Range | `python3 scripts/media_range_check.py --cookie <c> --file-id <mp4>` | 10/10 |
| Office 会话 | `python3 scripts/office_session_check.py --cookie <c> --file-id <docx>` | 12/12 |
| 负载 | `python3 scripts/loadtest.py --users 10 --duration 45` | 11/11 |
| 备份清单 | `python3 scripts/test_backup_manifest.py` | 12/12 |
| 缓存 soak | `python3 scripts/cache_soak_check.py --queries 6000 --sessions 40` | 4/4（RSS 走平 + 撤销即时） |
| 稳定性 soak | `python3 scripts/stability_soak.py --minutes 10` | FD/RSS 走平，无 5xx |
| 备份恢复 | `set -a; . .secrets/server.env; set +a; python3 scripts/backup_restore_drill.py` | PASS |
| 崩溃恢复 | `python3 scripts/ag09_recovery_drill.py` | 4/4 |
| 升级回退 | `python3 scripts/upgrade_rollback_drill.py` | 12/12 |
| 浏览器旅程 | `node scripts/browser_journey_check.mjs` | 19/19 |
| 项目 API 合同 | `node scripts/project_api_check.mjs` | PASS（§3–§5 全端点 + 幂等批量关联 + 视图状态） |
| 项目界面验收 | `node scripts/project_browser_check.mjs` | PASS（新建/内联改状态/甘特/归档 + 1440/1280/1024 三档无横向溢出） |
| 预览返回来源 | `node scripts/preview_return_check.mjs` | PASS（`from=projects/my-projects` 回项目页；伪造/大小写不匹配回文件列表；`/workbench?view=projects` 直达） |
| 项目库隔离测试 | `bash scripts/project_fresh_pg_lab.sh` | PASS（临时库建迁移 → 跑 `TestProjectPostgresRoundTrip` → 删库） |
| 业务界面 | `node scripts/browser_business_check.mjs` | 12/12 |
| UX 桌面交互 | `node scripts/ux_desktop_check.mjs` | 待远端复跑确认 |
| UX 业务闭环 | `node scripts/ux_workflows_check.mjs` | 待远端复跑确认 |
| UX 视觉与 a11y | `node scripts/ux_visual_check.mjs` | 待远端复跑确认（截图落 `docs/evidence/ux/`） |
| UX 性能实测 | `node scripts/ux_perf_check.mjs` | 待远端复跑确认（advisory 阈值，见下） |

新增的四条 UX 门禁（`UX-ACCEPTANCE-v1` §8/G5、`docs/design/UX-ACCEPTANCE-v1.md` §9）
独立于浏览器旅程/业务界面门禁，不削减既有覆盖，状态在**同一提交的远端复跑确认前不得记
PASS**：

- `ux_desktop_check.mjs`：Dialog 真模态/焦点回归/脏数据守卫、共享 Shell 8 路由一致性、
  文件选择控制器（DI-01..08）、目录树键盘合同（DI-12..15）、右键菜单与拖放上传队列
  （DI-03/05/17），共 89 项检查。
- `ux_workflows_check.mjs`：文件移动 + 预检 API（含幂等/CAS/同名冲突/404 语义）、
  经 FolderPicker 的文件/目录移动 UI（WF-01..06）、回滚/回收站恢复/审批意见 UI 闭环、
  纯文本安全编辑字节保真，共 60 项检查。
- `ux_visual_check.mjs`：1366×768 / 1440×900 / 1920×1080 三视口遍历
  `/doc`、`/trash`、`/org`、`/approvals`、`/preview/:id`，断言无横向溢出、主操作在视口内、
  表格与面包屑可达，PNG 落盘 `docs/evidence/ux/<route>-<viewport>.png`，并断言 `/doc`
  的 grid/tree/shell 可访问性元数据，共 51 项检查。
- `ux_perf_check.mjs`：在**自建隔离夹具**（61 目录子树 / 200 文件目录 / 两文件夹快速切换）
  上实测行单击选择、右键菜单、目录树键盘漫游、游标分页、快速切目录、上传中键盘响应的
  p50/p95 与长任务/CPU/堆记录，并输出 DOM 节点计数。合同 §7 的阈值是**建议值**：只以
  advisory 行打印，不作为失败条件；检查仅在缺样本、无反馈、分页重复、视图串流或 DOM
  无界增长时失败。PERF-05/07 需全量数据集与 CAD 场景，明确 SKIP 并打印原因。

四条命令均默认读取 `.secrets/admin.password`，可用 `--base`、`--password-file`、`--port`
覆盖（默认端口 9360/9361/9362/9363）；运行期间会临时创建时间戳夹具并自行清理。
`ux_visual_check.mjs` 需要仓库目录可写（创建 `docs/evidence/ux/`）；`ux_perf_check.mjs`
会创建约 205 个上传文件与一个 12 MiB 上传任务并在结束后删除，单次运行约 2–5 分钟。

需要会话 Cookie 的门禁：`curl -s -c /tmp/c.txt -X POST http://127.0.0.1:18091/api/login
-H 'Content-Type: application/json' -d "{\"login\":\"admin\",\"password\":\"$(cat .secrets/admin.password)\"}"`
然后 `grep fm_session /tmp/c.txt | awk '{print $7}'`。

## 4.1 证据采集工具

`node scripts/capture_evidence.mjs` 通过已认证的 headless Chrome 抓取全部真实页面
截图到 `docs/evidence/`（登录、文档管理、预览、模型查看器含装配零件树、搜索、统计、
组织、审批、回收站），用于给客户做可视化验收；行为断言仍以 §4 各门禁为准。

## 5. 备份与恢复

```bash
set -a; . ./.secrets/server.env; set +a
python3 scripts/backup_restore_drill.py     # 快照 + 媒体归档 + 恢复到临时库 + 校验 + 删除临时库
```

- 归档落在 `.secrets/backup-drills/<UTC时间戳>/`（root-only，不入 Git）
- 演练断言表数与快照引用媒体一致（最近一次：26 表 / 288 blob）
- 恢复使用一次性临时库，绝不触碰业务库

## 6. 升级与回退

```bash
python3 scripts/upgrade_rollback_drill.py                    # 回滚到 HEAD~1
python3 scripts/upgrade_rollback_drill.py --rollback-to <sha> # 指定提交
```

流程：验证当前构建 → 写入标记文件 → worktree 构建旧版并换入 → 旧版启动/认证/数据字节级存活
→ 还原当前构建（摘要校验）。真实升级即反向操作：构建新二进制 → 换入 → 重启 → 验证。

## 7. 故障排查

| 现象 | 原因与处理 |
|---|---|
| 改完代码行为没变 | 只跑了 `go build ./...`；需 `go build -o .bin/server ./cmd/server` 再 `run-dev.sh stop/start` |
| `GET /api/files?...&limit=200` 返回 400 | 历史缺陷（仓库守卫与服务端 page+1 探测差一），已修复为共享常量 `ports.MaxFilePage`；若复现说明二进制过期 |
| PE12/PE15/loadtest 数字异常 | perf 实例是否还在跑（见 §3） |
| 构建报 openapi/matrix drift | 路由或验收项变更后未重新生成：`python3 scripts/gen_openapi.py` / `python3 scripts/gen_acceptance_matrix.py` |
| 启动报 `E_NETWORK` | 对端不在 `FILESMANAGE_LAN_ALLOW_CIDRS`；从 LAN 内访问或调整白名单 |
| 上传同名文件 409 | 名称冲突属预期；E2E 脚本用时间戳避免 |
| 畸形 CAD 文件派生 ready 且为空 | 已修复：worker 校验 MSH/STL 输出真含几何，否则 `failed` + `CONVERT_FAILED` |
| 会话突然 401 | 24h 过期或被禁用/登出；重新登录 |

日志位置：`.bin/server.log`、`.bin/worker.log`、`.bin/perf-server.log`；错误详情开关
`FILESMANAGE_DEBUG_ERRORS=true`（仅开发用，生产响应不泄露内部信息）。

## 7.1 读缓存与失效语义

服务端有三个进程内缓存，均按“主体 + 完整过滤条件”为键并受 TTL 约束：会话校验
5 s、搜索页 10 s、统计聚合 30 s。失效保证：

- 任何授权变更（建/撤授权、建/撤共享、禁用用户、移动目录、恢复回收站）都会
  递增 **authorization epoch**，全部缓存读的键都含该 epoch——授权变更立即使所有
  缓存读失效，不等 TTL（PE04）；
- 登出立即删除会话缓存；改密与禁用账号立即删除该用户全部会话缓存；
- 因此“撤销后下一次请求即失权”“登出后会话立即失效”在缓存存在时依然成立，
  由 `m7_security_e2e.py`（31/31）与 `TestSessionCacheRevokesImmediately` 把关；
- 三个缓存均有上限（`maxCacheEntries` = 4096）：达到上限先驱逐过期条目，
  仍满则不缓存新条目（只多一次查询，不影响正确性），由
  `TestCachesAreBounded` 把关，长时间运行不会无界增长。

## 8. 禁止事项

- 不得占用 8091、不得安装 systemd 单元、不得切换生产入口（BLK-05 未授权）
- 不得删除/覆盖/迁移旧 Node/SQLite 数据，不得复用旧 Blob（DEC-15）
- 不得把密钥或管理员口令提交 Git 或写入日志
- 不得对共享 PostgreSQL 执行破坏性操作；压测实例池上限 25，避免挤占其他项目
- 不得宣称未经实测的功能已完成

## 9. 发布门禁现状

见 `docs/RELEASE-GATES.md`：M1–M6 GO(dev)，M7 证据齐全但 100/200 用户容量受共享主机限制
（BLK-07），M8 dev 级恢复 GO、生产切换待授权。矩阵 123 PASS / 2 PARTIAL（S12 systemd
安装待授权 BLK-05、S20 官方 Logo 已入库待远端 VS01–VS18 截图签收）/ 1 EXTERNAL（MC11 DWG 许可）。
