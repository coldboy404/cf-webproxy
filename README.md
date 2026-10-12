‼️‼️写在最前面：

‼️‼️免责声明：

‼️‼️‼️‼️本项目仅供交流学习，禁止搭建公共代理去薅cf羊毛，如果发现账号被限制或者封禁与本项目无关，请自备小号测试❗️❗️❗️❗️❗️

# cf-webproxy

轻量的 Telegram WEB Proxy，支持 **Workers + Durable Objects** 和 **独立 Pages** 两种部署方式，直连 Telegram 数据中心。**无需 VPS、后端 MTProxy 或管理面板，只需配置一个 `PROXY_SECRET`。**

```text
Telegram Android → HTTPS / WebSocket → Workers 或 Pages → Telegram DC:443
```

支持多路复用、流控与超时清理；使用 WebCrypto 原生加密、已排队小包合并及有界背压等待。仅允许连接预设的 Telegram DC，不接受任意 TCP 目标。

## 1. 部署到 Cloudflare

### Pages：直接连接 Git 仓库

在 Cloudflare 创建 **Pages** 项目，连接本仓库或你的 Fork：

| 配置 | 值 |
|---|---|
| 根目录 | `pages` |
| 构建命令 | `npm run build` |

生产分支确认是 `main`，框架保持 `None`。输出目录由配置文件指定；若创建页面要求填写，填 `dist`。**Node 版本已在仓库指定，无需添加 `NODE_VERSION`。** 这些设置只需在首次创建时确认，后续更新不用重填。

在 Pages 生产环境添加加密变量 `PROXY_SECRET`，重新部署使其生效。**不需要额外 Worker、Durable Object 或部署命令。**

完整步骤与会话差异见 **[Pages 部署说明](./pages/README.md)**。Pages 版使用 60 秒接入票据，不支持跨请求 HTTP DELETE 撤销；已连接的 WebSocket 不受这个期限影响。

### Workers：保留原有部署方式

以下按钮及命令仅用于 **Workers + Durable Objects**，不用于 Pages；仓库根目录已配置绑定和迁移，无需填写输出目录。

#### Workers 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/coldboy404/cf-webproxy)

1. 点击按钮，登录 Cloudflare，按提示连接 GitHub 并创建仓库。
2. 保留默认配置，按提示填写 `PROXY_SECRET` 并部署。
3. 部署成功后，记录 Worker 的 `*.workers.dev` 地址。

**如果部署时没有要求填写密钥**，打开：

```text
Workers & Pages → 你的 Worker → Settings → Variables and Secrets → Add
```

添加 **Secret（机密）**，名称为 `PROXY_SECRET`，不要使用普通明文变量。保存后按控制台提示部署，使配置生效。

密钥要求：**32 位小写十六进制字符（0–9、a–f）**，也支持 `dd` 前缀加 32 位（共 34 位）；不支持 `ee` / FakeTLS。请使用自己的密钥，不要照抄他人的代理链接。

#### Workers 其他部署方式

<details>
<summary>Fork 后导入 GitHub 仓库</summary>

1. Fork 本仓库。
2. 在 Cloudflare 的 **Workers & Pages → Create application → Import a repository** 中选择你的仓库。
3. 填写以下配置并部署：

| 配置 | 值 |
|---|---|
| Production branch | `main` |
| Build command | 留空或 `npm test` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

4. 按上方说明添加 `PROXY_SECRET`，并使其生效。

</details>

<details>
<summary>命令行部署</summary>

需要 Node.js 22.15+、npm 和 Cloudflare 账户。

```bash
git clone https://github.com/coldboy404/cf-webproxy.git
cd cf-webproxy
npm ci
npx wrangler login
npx wrangler secret put PROXY_SECRET
npm test
npx wrangler deploy
```

运行 `secret put` 时输入自己的密钥，部署成功后终端会显示 Worker 地址。

Windows PowerShell 若提示禁止运行 `npx.ps1`，将 `npx` / `npm` 替换为 `npx.cmd` / `npm.cmd`，无需修改系统执行策略。

</details>

#### Workers 自定义域名（可选）

如果 `workers.dev` 访问不稳定，可使用托管在 Cloudflare 的自定义域名：

1. 打开 **Worker → Settings → Domains & Routes → Add → Custom Domain**。
2. 添加域名（例如 `proxy.example.com`），等待证书就绪。
3. 在下方 Telegram 链接中使用这个域名。

**无需修改 `wrangler.toml` 或填写 `PUBLIC_HOSTNAME`。** 不要将个人域名写入公共仓库的 `[[routes]]`，以免其他账号 Fork 后部署失败。

## 2. 添加到 Telegram

在支持 WEB Proxy 的 Telegram Android 客户端中打开：

```text
https://t.me/webproxy?server=你的域名&secret=你的PROXY_SECRET
```

- `server`：Worker / Pages 地址或自定义域名，**不含 `https://` 或路径**。
- `secret`：与 Cloudflare 配置完全一致，包括可选的 `dd` 前缀。
- 添加后实际测试消息收发；域名能 Ping 通或浏览器能打开，不代表代理可用。

## 3. 配置项

**正常使用只需设置 `PROXY_SECRET`，其他项保持默认。**

| 名称 | 默认值 | 用途 |
|---|---|---|
| `PROXY_SECRET` | 必填，使用 Secret 类型 | 代理密钥，格式见部署说明。 |
| `PUBLIC_HOSTNAME` | 空 | 可选，限制入口域名；不含协议或路径。为空时使用请求主机名。 |
| `MAX_STREAMS` | `64` | 每个会话的最大逻辑连接数。 |
| `SESSION_TTL_SECONDS` | `300` | Bootstrap 凭证有效期（秒），不是已建立连接的时长上限。 |
| `DIAGNOSTICS` | 关闭 | 设为 `1` 开启诊断日志；排障后删除或设为 `0`。 |

除 `PROXY_SECRET` 外均为可选环境变量。会话签名密钥由代理密钥派生，**无需配置 `SESSION_SIGNING_KEY`**。

**Workers 版**创建后 10 分钟内未接入 WebSocket 的会话会过期并自动清理；**Pages 版**接入票据有效期为 60 秒。两者都不会因接入期限结束而中断已建立的正常连接。

## 4. 验证与排障

访问 `https://你的域名/healthz`，正常应返回：

```json
{"ok":true,"carrier":"websocket","relay":"direct-telegram-dc"}
```

此接口**仅检查 HTTP 入口**，不验证会话或 Telegram DC 连通性。直接访问根路径不会显示代理管理面板，这是正常行为。

| 问题 | 检查方法 |
|---|---|
| Telegram 无法连接 | 确认密钥已部署生效，并与链接一致；确认客户端支持 WEB Proxy。 |
| 换域名后不通 | 确认域名绑定到正确 Worker / Pages 项目、证书已就绪；若设置了 `PUBLIC_HOSTNAME`，需与入口一致。 |
| 仍无法定位 | 临时开启 `DIAGNOSTICS=1`，查看对应 Worker / Pages Functions 日志，并在 Telegram 中重新连接。 |
| 能连接但延迟偏高 | 分别测试移动网络和宽带。TG 延迟包含 Worker / Durable Object 调度及到 Telegram DC 的链路耗时，不等同于域名 Ping。 |

不要公开真实密钥、会话 Token 或完整 Bridge URL。代码优化不能保证特定网络延迟。

## 更新与开发

- **GitHub 自动部署**：Fork 用户先同步上游；已连接 Workers Builds 或 Pages Git 的生产分支更新后会触发对应部署。
- **确认更新生效**：在对应 Worker / Pages 项目的 Deployments 页面核对提交 ID 和部署结果；GitHub 推送成功不代表 Cloudflare 已部署成功。
- **Workers 命令行更新**（Pages 使用 Git 推送更新）：

```bash
git pull
npm ci
npm test
npx wrangler deploy
```

部署成功后，在 Telegram 中**关闭再开启代理**，重建会话。

<details>
<summary>本地开发与构建检查</summary>

```bash
npm ci
npm test
npx wrangler dev
```

仅检查构建，不部署：

```bash
npx wrangler deploy --dry-run --outdir .wrangler-dry-run
```

测试覆盖帧校验、保序、队列限额、流控、AES-CTR 及连接生命周期，不能替代 Telegram 真机和生产网络验证。

</details>

## 协议与安全

本项目参考 Telegram 官方 [tproxy-server](https://github.com/telegramdesktop/tproxy-server) 的 [PROTOCOL.md](https://github.com/telegramdesktop/tproxy-server/blob/master/PROTOCOL.md) 和 [ANDROID.md](https://github.com/telegramdesktop/tproxy-server/blob/master/ANDROID.md)，为独立实现，**不是官方 Cloudflare 部署方案**，也未实现全部载体模式。

不要提交 `.dev.vars` 或真实凭证。可用性受本地网络、Cloudflare TCP 出站限制及 Telegram 链路影响，请遵守相关服务条款及所在地法律法规。

## 许可证

[MIT License](./LICENSE)
