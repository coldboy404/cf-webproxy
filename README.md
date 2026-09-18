# cf-webproxy

这是一个基于 **Cloudflare Workers** 的 Telegram Android 官方 **WEB Proxy** 实现。它不需要 VPS、原版 MTProxy 进程或其他代理后端。

```text
Telegram Android
  → HTTPS / WebSocket WEB 载体
  → Cloudflare Worker + Durable Object
  → 在 Worker 内终止并转换 MTProxy 混淆流
  → 通过 cloudflare:sockets 直接连接 Telegram DC:443
```

## 功能特性

- 实现 Telegram 官方 WEB Proxy Bridge（`TelegramWebProxy` Android Bridge）
- 实现二进制载体帧和 WebSocket 多路复用
- 使用 Durable Object 管理代理会话
- 在 Worker 内解析 MTProxy 64 字节混淆握手
- 双向、带状态的 AES-256-CTR 流转换
- 根据握手中的 DC ID 直接连接 Telegram DC 1–5
- 支持以下传输协议标签：
  - Abridged
  - Intermediate
  - Secure Intermediate
- 支持普通 16 字节 Secret 和带 `dd` 前缀的 Secret
- 包含连接数、流量窗口及握手合法性检查

> Telegram WEB Proxy 模式不支持 FakeTLS，因此本项目不支持以 `ee` 开头的 Secret。

## 工作原理

Telegram Android 客户端首先通过 HTTPS 打开 Worker 提供的 Bridge 页面，然后通过 WebSocket 建立 WEB Proxy 载体连接。

每个逻辑连接都会在 Worker 内完成以下操作：

1. 接收客户端发送的 MTProxy 混淆握手。
2. 使用配置的 `PROXY_SECRET` 验证并解密握手。
3. 从握手中读取传输协议和 Telegram DC ID。
4. 通过 `cloudflare:sockets` 连接对应 Telegram DC 的 TCP 443 端口。
5. 为 Telegram DC 创建新的混淆握手。
6. 在客户端加密流和 Telegram DC 加密流之间进行双向实时转换。

项目没有 `UPSTREAM_HOST` 或 `UPSTREAM_PORT` 配置，也不会连接用户指定的任意目标。通过验证的连接只能访问代码内预设的 Telegram DC 地址和 TCP 443 端口。

## 部署要求

- Node.js 20 或更高版本
- 已启用 Workers 的 Cloudflare 账户
- 推荐使用托管在 Cloudflare 上的自定义域名

## 安装依赖

```bash
npm install
```

登录 Cloudflare：

```bash
npx wrangler login
```

## 配置 Secret

生成 16 字节随机 Secret：

```bash
openssl rand -hex 16
```

将生成的 32 位小写十六进制字符串写入 Worker Secret：

```bash
npx wrangler secret put PROXY_SECRET
```

如果需要使用 `dd` 格式，可以在生成的 Secret 前添加 `dd`，例如：

```text
dd0123456789abcdef0123456789abcdef
```

再生成一个独立的会话签名密钥：

```bash
openssl rand -hex 32
npx wrangler secret put SESSION_SIGNING_KEY
```

请不要将 `PROXY_SECRET` 和 `SESSION_SIGNING_KEY` 直接写入 `wrangler.toml` 或提交到 Git 仓库。

## 配置自定义域名

可以在 `wrangler.toml` 中填写对外使用的域名：

```toml
[vars]
PUBLIC_HOSTNAME = "proxy.example.com"
MAX_STREAMS = "64"
SESSION_TTL_SECONDS = "300"
```

`PUBLIC_HOSTNAME` 不要包含 `https://`，也不要包含路径。

如果保持为空：

```toml
PUBLIC_HOSTNAME = ""
```

Worker 将使用当前请求的主机名。

## 测试与部署

运行单元测试：

```bash
npm test
```

执行 Wrangler 构建检查，但不实际部署：

```bash
npx wrangler deploy --dry-run
```

正式部署：

```bash
npm run deploy
```

也可以直接执行：

```bash
npx wrangler deploy
```

部署后建议在 Cloudflare 控制台中为 Worker 绑定自定义域名。

## 添加到 Telegram

代理链接格式如下：

```text
https://t.me/webproxy?server=你的域名&secret=你的Secret
```

普通 Secret 示例：

```text
https://t.me/webproxy?server=proxy.example.com&secret=0123456789abcdef0123456789abcdef
```

`dd` Secret 示例：

```text
https://t.me/webproxy?server=proxy.example.com&secret=dd0123456789abcdef0123456789abcdef
```

注意事项：

- `server` 中不要填写 `https://`。
- `server` 应填写 Telegram 客户端可以访问的 Worker 自定义域名。
- 链接中的 Secret 必须与 Cloudflare Worker 中设置的 `PROXY_SECRET` 完全一致。

## Bridge 鉴权

客户端和 Worker 会使用以下规则计算隐藏的 Bridge Capability：

```text
base64url(
  HMAC-SHA256(
    secret_bytes,
    "tdesktop-web-proxy-bridge-v1\n" + lowercase_hostname
  )
)
```

普通访问者打开 Worker 根路径时只会看到伪装页面。只有携带正确 Bridge Capability 的请求才会加载代理 Bridge。

## 配置项

| 名称 | 类型 | 默认值 | 说明 |
|---|---|---:|---|
| `PROXY_SECRET` | Worker Secret | 无 | 必填。32 位十六进制字符串，可添加 `dd` 前缀。 |
| `SESSION_SIGNING_KEY` | Worker Secret | 无 | 强烈建议设置，用于签发短期会话凭证。 |
| `PUBLIC_HOSTNAME` | 环境变量 | 空 | 对外使用的自定义域名，不包含协议。 |
| `MAX_STREAMS` | 环境变量 | `64` | 每个会话允许的最大逻辑连接数。 |
| `SESSION_TTL_SECONDS` | 环境变量 | `300` | Bridge Bootstrap 凭证的有效期，单位为秒。 |

## 健康检查

部署后可以访问：

```text
https://你的域名/healthz
```

正常情况下会返回类似内容：

```json
{
  "ok": true,
  "carrier": "websocket",
  "relay": "direct-telegram-dc"
}
```

## 本地开发

启动 Wrangler 本地开发服务器：

```bash
npx wrangler dev
```

本地测试真实 TCP 连接时，需要注意 Wrangler 本地运行环境与 Cloudflare 生产网络之间可能存在差异。

## 安全说明

- 不要提交 `.dev.vars`、Secret、会话 Token 或带 Bridge Capability 的完整 URL。
- `SESSION_SIGNING_KEY` 应与 `PROXY_SECRET` 不同，并使用独立的随机值。
- Worker 不接受客户端指定的 TCP 目标，只允许连接内置的 Telegram DC 地址。
- Cloudflare Workers 的 TCP 出站能力、连接数量和运行时限制可能因套餐及地区而异。
- Cloudflare 或 Telegram 流量受限制的网络环境中，本项目无法保证代理可用性。
- 使用本项目时，请遵守所在地法律法规及 Cloudflare、Telegram 的服务条款。

## 项目结构

```text
src/index.js       WEB 载体、Bridge 页面、会话和 Durable Object
src/mtproxy.js     MTProxy 握手、AES-CTR 转换和 Telegram DC 路由
test/              单元测试
wrangler.toml      Cloudflare Workers 配置
```

## 许可证

本项目采用 [MIT License](./LICENSE)。
