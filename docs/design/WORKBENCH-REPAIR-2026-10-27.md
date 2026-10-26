# 工作台修复与远端验收（2026-10-27）

本轮修复已部署到开发入口 `18091`。运行目录恢复为正式仓库 `/root/repository77/filesmanage-v21`，server 与 worker 健康检查通过。

## 故障与修复

- 实际入口此前运行独立的 `filesmanage-notion-workbench-v10-release-20261026` 发布目录，正式仓库缺少其知识页源码。已合入已有 GitHub 工作台分支及其 v11/v12 修复，保留已上线的知识页、DHF 和审批能力，让代码、构建与运行目录重新一致。
- 工作台样式把全部视图改成 flex，破坏了原有 grid 布局，造成待办详情、项目、审批、生效文件及签章视图收缩。恢复有界 grid 画布；整页视图占满工作区；列表与详情在桌面左右分区，可用内容宽度不超过 700px 时上下重排并分别滚动。
- 保留单一页面树、知识页块编辑、项目看板/表格/甘特，以及原业务授权。移除重复页面名称条、重复的“更多业务”标题、项目各列及空状态的重复创建入口。项目子视图使用 `projectView` 参数，避免覆盖工作台的 `view` 路由。
- 知识页返回保护原先晚于 Router 的 popstate 处理，取消返回仍可能丢失当前草稿。改为在 Router 初始化前注册返回拦截，并实时读取编辑/保存状态；未收到保存确认时阻止离开。
- 修复合入源码的三处跨层依赖，继续通过原架构门禁；未放宽检查规则。

## 已执行验证

所有构建、运行及浏览器测试均在远端机器执行。本地只读写源码和保存截图。

| 验证 | 结果 |
| --- | --- |
| `bash scripts/build.sh --with-tests` | `BUILD_OK`；Go 测试、vet、架构、OpenAPI、验收矩阵、CAD、Toast、加载状态、全局上传和迁移校验通过；迁移校验 `MIGRATIONS_OK 96` |
| 最终知识页修复后的 `npm --prefix web run build` | TypeScript 与 Vite 构建通过 |
| 最终架构、工作台范围、RareUI 和交互静态门禁 | 全部通过 |
| `node scripts/workbench_layout_browser_check.mjs`（18091） | 十种视图 × 1440/1024/760/390；画布占满、边界、滚动、窄工作区分区、唯一创建入口、项目父子路由通过 |
| 同一布局脚本的压力夹具 | 120 行、长标题，在真实 Chrome 验证自身区域滚动且不产生页面水平溢出；夹具只修改浏览器 DOM |
| `node scripts/workbench_notion_v05_browser_check.mjs http://127.0.0.1:18092` | 隔离数据库：三级页面深链接、自动保存、暂停真实保存请求时的离开保护、双方版本冲突恢复、键盘块编辑、四尺寸、取消/确认离开、浏览器返回和最近页面排序通过 |
| `node scripts/project_browser_check.mjs http://127.0.0.1:18092` | 隔离数据库：新建、表格内联改状态、甘特、三尺寸及归档通过 |
| `node scripts/workbench_notion_v05_browser_check.mjs http://127.0.0.1:18091 --read-only` | 实际入口页面树、知识页读取、项目子视图、移动导航、四尺寸、Finder 与 DHF 读取通过 |
| `node scripts/global_upload_browser_check.mjs`（18091） | 全站 OS 拖拽、分页目录选择、取消不入队、当前文档目录、收藏视图、内部移动隔离通过 |

知识页与项目的创建、修改、冲突及归档测试仅使用隔离数据库 `filesmanage_notion_ui_review_20261026`，测试临时服务已停止。实际入口未新增或修改业务记录；项目视图切换会保存测试账号的视图偏好。

Jev Review 已尝试调用，但运行环境未配置 `JEV_API_KEY`，未取得评审分数；不将其计为通过项。

## 实际入口截图

下列图片为真实业务入口的截图，不包含压力测试的 DOM 夹具。已检查桌面、笔记本与窄内容区的控件排列和滚动归属。

- [首页，1440px](../evidence/workbench-repair-20261027/home-1440.png)
- [待办详情，1440px](../evidence/workbench-repair-20261027/todo-1440.png)
- [项目视图，1024px](../evidence/workbench-repair-20261027/projects-1024.png)
- [待办详情，760px](../evidence/workbench-repair-20261027/todo-760.png)

本轮不涉及生产端口 `8091` 或 systemd。旧 v10 发布目录仍保留；旧 worker 二进制在远端 `.backups/workbench-repair-20261027/` 留存。没有复制本机密钥或修改数据库结构。
