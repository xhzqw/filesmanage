# WebSocket 实时事件通道

登录用户的浏览器会使用已有 HttpOnly Session Cookie 订阅服务端通知；文件读写与权限判断仍走现有 REST API。

- HTTP 页面连接 `ws://192.168.1.22:18091/api/events/ws`。
- HTTPS 页面连接 `wss://192.168.1.22:18443/api/events/ws`。
- VPN 可使用 `10.144.144.1` 的对应端口。
- 不强制 HTTPS，不修改 `443`、`8091`；Nginx 已透传 Upgrade。
- 必须同源 Origin，包含方案、Host 与端口。服务端验证 Cookie 并拒绝未完成改密的用户。
- 不支持查询参数中的令牌，不接收客户端业务命令，连接中不包含密码、Cookie 或文件内容。

## 事件（协议版本 1）

| type | 含义 |
|---|---|
| `connection.ready` | 建立连接，含 `version:1`、`heartbeatSeconds:12` |
| `connection.heartbeat` | 每 12 秒重验 Session |
| `session.changed` | 用户登录、退出、改密、停用或重置密码后触发，前端重新请求 `/api/me` |
| `session.revoked` | 当前 Session 已失效，前端退出到登录页 |
| `session.password_change_required` | 必须修改密码 |
| `server.unavailable` | 暂时无法检查会话，不应误判为退出 |

连接断开后客户端指数退避重连，最多 30 秒。连接和重连不会阻止 HTTP 文件管理功能。服务端全局最多 128 条连接，入站消息不超过 1 KiB，发送超时为 4 秒；每用户消息通道是单条有界缓冲，新事件会合并旧事件。

这是**单进程内发布订阅总线**，不存储历史，也不跨实例广播。未来多实例部署需要引入共享事件传输（例如 PostgreSQL LISTEN/NOTIFY）；当前单实例 LAN 部署不需要 Redis。无法通过 WS 收到事件时，API 仍会独立执行身份验证。

## 验收

仅在远端 `/root/repository77/filesmanage-v21` 执行 `bash scripts/build.sh --with-tests`、测试跨站拒绝、无 Session 拒绝、合法握手返回 101、初始 `connection.ready`、断线重连和双入口 WS/WSS。未完成改密及账号停用等事件要经过实际权限验证，不能只靠前端信号。
