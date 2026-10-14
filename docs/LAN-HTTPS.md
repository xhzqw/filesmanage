# filesmanage 内部 HTTPS（LAN/VPN，开发环境）

## 地址与现阶段兼容性

- 文件系统：`https://203.0.113.10:18443` 或 `https://203.0.113.1:18443`
- ONLYOFFICE 在线编辑：同一主机 `18444` 端口，独立 HTTPS 站点（浏览器自动连接）
- Nginx 转发到现有开发后端 `127.0.0.1:18091`；ONLYOFFICE 转发 `127.0.0.1:18080`
- 仅监听 `203.0.113.10` 和 `203.0.113.1`，只允许 `203.0.113.0/24`、`198.51.100.0/24` 与回环客户端
- 不触碰已有的 `80/443` Nginx 网站和未授权生产端口 `8091`
- HTTPS 响应中的 `fm_session` Cookie 由 Nginx 强制附加 Secure、HttpOnly 和 SameSite=Strict

**这是并行迁移期。旧 `http://...:18091` 暂不关闭，仍可签发非 Secure Cookie**，以免现有客户端、自动化验收及 ONLYOFFICE 内部回调中断。等全部客户端配置并验证内部 CA 后，应单独安排旧 HTTP 入口收敛，形成唯一 HTTPS 用户入口。

## 创建证书和启用 HTTPS

只在目标机以 root 运行：

```bash
cd /srv/filesmanage
bash scripts/setup-lan-https.sh
```

脚本生成 P-256 内部 CA（10 年）和服务端证书（397 天），叶子证书包含 SAN：`IP:203.0.113.10`、`IP:203.0.113.1`、`DNS:filesmanage-host`；安装 Nginx 站点，通过 `nginx -t` 后仅 reload Nginx。不会新增 systemd 服务。重跑脚本会在叶子证书剩余不足 30 天时用原 CA 续签，不擅自轮换根 CA。

- **不可分发**的根 CA 私钥：`.secrets/lan-tls/ca.key`
- **不可分发**的服务端私钥：`.secrets/lan-tls/server.key`
- **可以分发**的公有根 CA：`.secrets/lan-tls/ca.crt`
- 配置来源：`deploy/nginx/filesmanage-lan-https.conf`

根 CA 私钥存放于服务器是当前开发环境的权衡；正式环境建议将根 CA 转移到离线 PKI，并加密备份。

## 客户端证书信任（必须）

只复制公有 CA 证书到管理员设备：

```bash
scp ops@203.0.113.1:/srv/filesmanage/.secrets/lan-tls/ca.crt ./filesmanage-lan-ca.crt
openssl x509 -in ./filesmanage-lan-ca.crt -noout -fingerprint -sha256
```

与管理员通过可信渠道获取的服务端 SHA-256 根 CA 指纹比对；可在 SSH 会话中执行 `openssl x509 -in .secrets/lan-tls/ca.crt -noout -fingerprint -sha256` 获取。**不要导入任何私钥，不要点浏览器的“忽略证书错误/仍然访问”。**

- Windows（管理员）：`certutil -addstore -f Root filesmanage-lan-ca.crt`；公司设备建议使用组策略统一下发
- macOS：在钥匙串访问中导入根 CA 并按公司策略设置信任；受管设备优先 MDM
- Debian/Ubuntu：将公有 CA 放入 `/usr/local/share/ca-certificates/filesmanage-lan-ca.crt`，执行 `sudo update-ca-certificates`
- iOS/iPadOS：配置描述文件安装后，在「设置 → 通用 → 关于本机 → 证书信任设置」启用完全信任
- Android：在设备证书管理中导入公有 CA；用户自装 CA 是否被应用信任依 Android/应用版本而异

## 验收

```bash
cd /srv/filesmanage
nginx -t
bash scripts/run-dev.sh status
for ip in 203.0.113.10 203.0.113.1; do
  curl --fail --silent --show-error --cacert .secrets/lan-tls/ca.crt "https://$ip:18443/health/ready"
  curl --fail --silent --show-error --cacert .secrets/lan-tls/ca.crt "https://$ip:18444/web-apps/apps/api/documents/api.js" -o /dev/null
done
openssl x509 -in .secrets/lan-tls/server.crt -noout -dates -ext subjectAltName
```

然后在已安装根 CA 的真实浏览器中分别测试 LAN/VPN 登录、退出、图片/视频/模型预览、DOCX 编辑及保存。ONLYOFFICE 内部保存回调仍通过原 HTTP 开发端口，不应贸然关闭。

## 回退

不影响旧应用及其他 Nginx 站点：

```bash
rm -f /etc/nginx/sites-enabled/filesmanage-lan-https
nginx -t && systemctl reload nginx
```

保留证书以便调查和重启；后续可重新运行部署脚本启用。
