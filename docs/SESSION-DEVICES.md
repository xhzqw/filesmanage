# 自助登录设备与会话审计

## 访问

右上角当前用户菜单 → **登录设备与安全**，或在已登录浏览器访问 `/account/sessions`。普通用户和管理员只能看到自己的会话与自己的安全操作日志。

## 操作

- 查看自己的有效登录设备（最近最多 50 条），标记当前设备、来源 IP、浏览器/系统、登录/最近活跃/到期时间。
- 撤销指定**其他**设备，或一次退出其他全部设备；当前设备保留。想退出当前设备请使用原「退出」功能。
- 最近 30 条安全记录：成功登录、退出、撤销单设备、撤销所有其他设备。
- 成功撤销后触发 `session.changed`，同一账号下已连接的 WebSocket 接收到更新并通过 `/api/me` 重新鉴权；后台每 12 秒心跳复验。无 WebSocket 时下一次 REST 请求仍会生效。

## 安全边界

- 身份验证仍是 HttpOnly + SameSite=Strict 的 `fm_session` Cookie，不传输原始会话令牌到前端的列表。
- `id` 是 96-bit 截断的 SHA-256 **摘要前缀**，只能用于按当前账号过滤的撤销接口，无法充当登录令牌。
- 数据库撤销带用户 ID 条件、当前会话排除和未到期条件；不存在与跨用户设备返回同一 `404`。
- 登录时只保存有限的 browser/OS **粗标签**和套接字客户端 IP；Nginx 代理仅在 loopback 连接时信任经过覆写的转发地址，不保存完整 User-Agent 或设备指纹。
- 最近活跃时间由已登录页面的 WebSocket 心跳与本页刷新更新，数据库限制最多约每 60 秒写一次。它是连接活跃近似值，不应宣传为具体鼠标活动。
- 审计与会话创建或撤销在同一事务提交；审计存储失败则不允许此次会话状态操作假装成功。
- 登录失败的限流和登录错误仍遵循现有策略，本批记录成功登录与会话操作，暂不持久化错误密码或未知账号。
- HTTP `18091` 与 HTTPS `18443` 并行，无强制重定向，TLS 入口 Cookie 保留 Secure 属性。

## 数据库

`0013_session_devices.sql` 添加 `sessions.client_ip`、`device_label`、`last_seen_at` 和相关索引，为既有会话提供默认值。迁移使用原项目的校验和管理；不能重写已执行迁移。

## API

- `GET /api/me/sessions`
- `GET /api/me/auth-activity`
- `DELETE /api/me/sessions/others`
- `DELETE /api/me/sessions/:id`

详见 `docs/openapi-implemented.yaml`。测试需覆盖跨用户、当前设备保护、撤销后真实 Session 被拒、审计事务及 WebSocket 会话失效。
