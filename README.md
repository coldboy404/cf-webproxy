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

## 部署到 Cloudflare

本项目是 **Cloudflare Worker**，不是 Cloudflare Pages 项目。最简单的部署方式是点击下面的一键部署按钮。

### 方法一：一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/coldboy404/cf-webproxy)

点击按钮后按以下步骤操作：

1. 登录你的 Cloudflare 账户。
2. 如果页面要求连接 GitHub，请授权 Cloudflare 访问 GitHub。
3. Cloudflare 会把本项目复制到你的 GitHub 账户，并自动识别 `wrangler.toml`。
4. Worker 名称可以保持默认，也可以改成你喜欢的名称，例如 `tg-webproxy`。
5. 在 Secret 配置页面填写：
   - `PROXY_SECRET`：32 位小写十六进制字符串；也可以是 `dd` 加 32 位十六进制字符串。
6. 确认部署。Cloudflare 会自动创建并绑定项目需要的 Durable Object。
7. 部署完成后，Cloudflare 会提供类似下面的地址：

```text
https://tg-webproxy.你的账户名.workers.dev
```

如果一键部署页面没有要求填写 Secret，请在部署完成后进入：

```text
Cloudflare 控制台
→ Workers & Pages
→ 选择刚部署的 Worker
→ Settings（设置）
→ Variables and Secrets（变量和机密）
→ Add（添加）
```

添加下面两个 **Secret**，不要添加成普通明文变量：

| 名称 | 示例格式 |
|---|---|
| `PROXY_SECRET` | `0123456789abcdef0123456789abcdef` |

保存后，在 Worker 的 **Deployments（部署）** 页面重新部署一次，使 Secret 生效。

### 如何生成 Secret

Linux、macOS、Git Bash 或装有 OpenSSL 的 Windows：

```bash
# 生成 PROXY_SECRET
openssl rand -hex 16

```

没有 OpenSSL 时，可以在浏览器开发者工具的 Console 中执行：

```js
// PROXY_SECRET
[...crypto.getRandomValues(new Uint8Array(16))]
  .map(x => x.toString(16).padStart(2, "0")).join("")

```

如果希望使用 `dd` Secret，在生成的 32 位 `PROXY_SECRET` 前面加上 `dd`：

```text
dd0123456789abcdef0123456789abcdef
```

### 方法二：在 Cloudflare 控制台导入 GitHub 仓库

如果不使用一键部署按钮，也可以手动导入：

1. 打开 Cloudflare 控制台。
2. 进入 **Workers & Pages**。
3. 点击 **Create application（创建应用）**。
4. 选择 **Import a repository（导入仓库）** 或连接 GitHub。
5. 选择你 Fork 后的 `cf-webproxy` 仓库。
6. 使用以下构建配置：

| 配置 | 填写内容 |
|---|---|
| Production branch | `main` |
| Build command | 留空或填写 `npm test` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

7. 保存并部署。
8. 按上一节的方法，在 Worker 设置中添加 `PROXY_SECRET`。
9. 添加 Secret 后重新部署。

仓库已经包含 `wrangler.toml`，其中声明了 Worker 入口和 Durable Object。不要把该项目当成 Pages 静态网站部署，也不需要填写 `dist` 输出目录。

### 方法三：使用 Wrangler 命令行部署

要求：

- Node.js 20 或更高版本
- npm
- Cloudflare 账户

克隆项目：

```bash
git clone https://github.com/coldboy404/cf-webproxy.git
cd cf-webproxy
npm install
```

登录 Cloudflare：

```bash
npx wrangler login
```

设置两个 Secret：

```bash
npx wrangler secret put PROXY_SECRET
```

命令执行后，按照终端提示粘贴随机值。然后运行测试和部署：

```bash
npm test
npx wrangler deploy
```

部署成功后，终端会显示 Worker 地址，例如：

```text
https://cf-webproxy.你的账户名.workers.dev
```

### 绑定自定义域名（推荐）

`workers.dev` 域名可以直接使用，但部分网络环境可能无法稳定访问，因此建议绑定一个托管在 Cloudflare 的自定义域名。

1. 进入 Cloudflare 控制台中的 Worker。
2. 打开 **Settings（设置）→ Domains & Routes（域和路由）**。
3. 点击 **Add（添加）→ Custom Domain（自定义域）**。
4. 填写域名，例如：

```text
proxy.example.com
```

5. 等待证书签发完成。
6. 修改 `wrangler.toml`：

```toml
[vars]
PUBLIC_HOSTNAME = "proxy.example.com"
MAX_STREAMS = "64"
SESSION_TTL_SECONDS = "300"
```

7. 提交修改触发自动部署，或者再次执行：

```bash
npx wrangler deploy
```

如果 `PUBLIC_HOSTNAME` 保持为空，Worker 会自动使用收到请求时的主机名。因此仅使用 `workers.dev` 地址时通常不需要修改它。

### 验证部署是否成功

在浏览器访问：

```text
https://你的 Worker 域名/healthz
```

正常情况下会返回：

```json
{
  "ok": true,
  "carrier": "websocket",
  "relay": "direct-telegram-dc"
}
```

如果能看到以上结果，说明 Worker 和 Durable Object 已经成功部署。这个健康检查只验证 Worker 服务正常，不会暴露 Secret。

### 更新项目

命令行部署的项目可以这样更新：

```bash
git pull
npm install
npm test
npx wrangler deploy
```

通过一键部署或 GitHub 导入的项目，推送到生产分支后，Cloudflare Workers Builds 会自动重新部署。
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

> 会话签名密钥由程序使用 `PROXY_SECRET` 进行域隔离派生，不需要额外配置 `SESSION_SIGNING_KEY`，也不会把派生密钥发送给客户端。

| 名称 | 类型 | 默认值 | 说明 |
|---|---|---:|---|
| `PROXY_SECRET` | Worker Secret | 无 | 必填。32 位十六进制字符串，可添加 `dd` 前缀。 |
| `PUBLIC_HOSTNAME` | 环境变量 | 空 | 对外使用的自定义域名，不包含协议。 |
| `MAX_STREAMS` | 环境变量 | `64` | 每个会话允许的最大逻辑连接数。 |
| `SESSION_TTL_SECONDS` | 环境变量 | `300` | Bridge Bootstrap 凭证的有效期，单位为秒。 |

## 延迟说明

Telegram 显示的延迟不只是域名 Ping，还包含客户端到 Cloudflare、Worker/Durable Object 调度以及 Cloudflare 到 Telegram 数据中心的链路耗时。不同域名即使都使用 Cloudflare，也可能因运营商路由、接入节点、账号所在 Telegram DC 和冷启动状态产生明显差异。

建议连续观察几次稳定连接后的延迟，不要只看首次连接。项目默认关闭逐帧诊断日志，避免日志序列化增加 CPU 开销；临时排障时可在 Worker 环境变量中设置 `DIAGNOSTICS=1`，排障结束后删除或设为 `0`。

可优先尝试：

- 使用在本地网络路由更好的 Cloudflare 自定义域名；
- 避免同时开启会改写路由的 VPN、分流或私有 DNS；
- 分别用移动网络和宽带测试，判断是否为运营商到 Cloudflare 的路由问题；
- 等连接稳定后再比较延迟，首次连接包含 Session、WebSocket 和 TCP 建连成本。

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
