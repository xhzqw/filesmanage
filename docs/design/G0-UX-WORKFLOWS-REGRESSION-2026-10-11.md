# G0 完整工作流复测台账 — 2026-10-11

## 执行基线

- 代码：`caae253`（包含此前 Rare 列表治理和并行 CAD 重构）
- 环境：远端 `10.144.144.1`，隔离服务 `127.0.0.1:18092`；专用数据库 `filesmanage_ux_test`，不触及共享业务库
- 命令：`bash scripts/ux_isolated_lab.sh run ux_workflows_check`
- 结果：**105/116 PASS，11 项 FAIL；整体退出码 1**。
- 前一次的 98/106 来自旧版本/旧测试数；不能作为本轮结果引用。

## 未通过分组

| 失败组 | 实际断言/失败 | 当前判断 | 后续处置 |
|---|---|---|---|
| 版本/回滚 | `preview lists both versions`、`WF-12 rollback action offered`、`WORKFLOW suite completed` | 页面结构可能已改为预览/版本 Tab；旧脚本以 `.table tbody tr` 寻找行，随后对不存在的按钮调用方法而抛异常。尚未排除真实版本读取故障 | 实测版本 Tab → 历史版本 → 回滚对话框 → API 新 seq / 保留旧 SHA；修复脚本用稳定语义定位并做空值分支 |
| 统计与导出 | `WF-29 export link carries the chosen folder` | 路由/导出入口可能已由链接切换为按钮；不等同于下载行为失败 | 以浏览器网络请求验证选目录后的真实导出请求携带 folder ID |
| 回收站 | `purge entry visible for admin`、`purge stage 1 states the irreversible impact`、`BATCHUI suite completed` | 现版本永久删除藏在行「更多操作」菜单，且采用两级确认和长按执行；测试仍直接找旧表格按钮/旧对话框标题 | 菜单打开 → 影响说明 → 二级确认 → 长按完成 → API/DB 状态一致 |
| 搜索 | `WF-30 search renders the first page`、`加载更多 appears`、`appends the rest`、`count line` | 搜索专项 Rare 表格浏览器检查已验证可渲染，但全流程夹具的搜索初始化或脚本选择器可能过时 | 单独建立 60+ 结果夹具，执行提交、50 条展示、加载更多追加、去重、总数和筛选变化 |

## 处理原则

- **以上均为待排查**，不得将假设“脚本过时”写成已证实的根因。
- 修复断言必须覆盖用户实际操作链和服务端状态，不通过删除/弱化检查达成“全绿”。
- 各组在 `caae253` 或其后继提交上分别复现、修正，记录最终的浏览器/API/数据库证据；与本批 G1 视觉重构分开追踪。
- 隔离 QA 与正式开发服务严格分离；任何破坏性夹具仅使用隔离数据库。
