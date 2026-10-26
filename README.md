‼️‼️写在最前面：

‼️‼️免责声明：

‼️‼️‼️‼️本项目仅供交流学习，禁止搭建公共代理去薅cf羊毛，如果发现账号被限制或者封禁与本项目无关，请自备小号测试❗️❗️❗️❗️❗️

# cf-webproxy

Telegram WEB Proxy，无需 VPS 或后端 MTProxy，支持 TCP / KWS 出站。

- [`worker.js`](./worker.js)：Workers 版，需要 Durable Object。
- [`page.js`](./page.js)：Pages 版，无需 Durable Object。

两个 JS 均可独立使用，无本地模块依赖。`pages/` 仅保留现有 Git 部署需要的构建配置。

## Pages 部署

在 Cloudflare 创建 **Pages** 项目，连接本仓库或 Fork：

- 生产分支：`main`
- 框架：`None`
- 根目录：`pages`
- 构建命令：`npm run build`
- 输出目录：`dist`

进入 **Settings → Variables and Secrets → Production**，添加加密变量 `PROXY_SECRET`，重新部署。

已有 Pages 项目无需更改上述设置。构建只将根目录 `page.js` 复制成 CF 要求的 `dist/_worker.js`，不需要安装第三方构建依赖。

手动部署时也必须将 `page.js` 重命名为 `_worker.js`，放入部署目录根部；不要粘贴进 Workers 编辑器。

## GitHub Actions 自动部署

仓库已提供 [Deploy to Cloudflare](./.github/workflows/deploy-cloudflare.yml)：推送到 `main` 自动运行，也可在 **Actions → Deploy to Cloudflare → Run workflow** 手动运行。默认部署 **Workers**；也支持切换为 Pages，单次只部署一种。

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 配置：

**Secrets：**

- `CLOUDFLARE_API_TOKEN`：Cloudflare API Token，仅授权目标账户。Pages 部署需要 **Account → Cloudflare Pages → Edit**；Workers 部署需要 **Account → Workers Scripts → Edit**。绑定自定义域名等额外资源时，按 Cloudflare 提示补充权限。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账户 ID（不是 Zone ID）。

**Variables：**

- `CLOUDFLARE_DEPLOY_TARGET`：`workers`（默认，无需填写）或 `pages`。Workers 模式不需要配置 Pages 项目名。
- `CLOUDFLARE_PAGES_PROJECT_NAME`：Pages 模式必填，填写**已有 Pages 项目的准确名称**，不是域名；工作流不会自动新建项目。生产分支应为 `main`。

**部署前先在 Cloudflare 目标项目设置加密变量 `PROXY_SECRET`**，格式见下节。工作流不会将代理密钥写入代码或日志。Workers 模式使用根目录 `wrangler.toml`，目标名称为 `cf-webproxy`，保留 Dashboard 上已有普通变量和 Secrets；Pages 模式部署 `page.js` 构建结果，并使用该 Pages 项目的生产环境变量。

尚未配置 Cloudflare 凭据时，工作流只做语法与构建检查，部署 job 会明确显示 **Skipped**；这不表示已经部署。配置好后手动运行或再次推送即可。

如果原来已启用 Cloudflare 的 Git 自动部署，切换到 Actions 后请在 Cloudflare 项目 **Settings → Builds & deployments** 关闭相应 Git 自动构建，避免同一次推送重复部署。Pages 生产环境修改变量后也可手动重新运行此工作流。

## Workers 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/coldboy404/cf-webproxy)

按提示部署并设置 `PROXY_SECRET`。仓库 `wrangler.toml` 已包含 `SESSIONS` 绑定和 `WebProxySession` 迁移；若手动粘贴 `worker.js`，仍需配置这些 Durable Object 资源，不能只填密钥。

命令行部署（Node.js 22.15+）：

```bash
npm ci
npx wrangler login
npx wrangler secret put PROXY_SECRET
npx wrangler deploy
```

## 密钥与连接

`PROXY_SECRET` 使用 **32 位小写十六进制（0–9、a–f）**，也支持 `dd` 加 32 位；不支持 `ee` / FakeTLS。生成命令：

```bash
openssl rand -hex 16
```

在支持 WEB Proxy 的 Telegram 客户端打开：

```text
https://t.me/webproxy?server=你的域名&secret=你的PROXY_SECRET
```

`server` 不含协议或路径，密钥与部署变量一致。不要公开密钥、会话 Token 或完整 Bridge URL。

## 自定义域名

- **Pages**：项目 → Custom domains → Set up a domain。保留指向本项目 `*.pages.dev` 的 CNAME，不要直接替换为第三方优选域名。
- **Workers**：Settings → Domains & Routes → Add → Custom Domain。

本项目没有自动 DNS 优选功能，也没有已验证的 Pages 优选配置教程。

## 可选 KWS

Pages、Workers 均可在生产环境添加普通变量：

```text
RELAY_TRANSPORT=kws
```

重新部署，在 Telegram 关闭再开启代理。**域名、DNS 和密钥不变。** 回退时改为 `tcp` 并重新部署。

KWS 使用 Telegram 官方 WebSocket 作为 CF 出站，不是入口优选，不保证更快；默认仍为 TCP。

## 配置与检查

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PROXY_SECRET` | 必填（加密变量） | 代理密钥 |
| `RELAY_TRANSPORT` | `tcp` | 可选 `kws` 官方 WebSocket |
| `PUBLIC_HOSTNAME` | 空 | 限制单个入口域名 |
| `ALLOWED_HOSTNAMES` | 空 | 逗号分隔的域名白名单；与上一项同设时取交集 |
| `MAX_STREAMS` | `64` | 每会话最大逻辑连接数 |
| `SESSION_TTL_SECONDS` | `300` | Bootstrap 凭证有效期，不是连接时长 |
| `DIAGNOSTICS` | 关闭 | `1` 开启诊断日志 |

访问 `/healthz` 或 `/health`：TCP 的 `relay` 为 `direct-telegram-dc`，KWS 为 `telegram-kws`。密钥或出站配置无效返回 500。

健康检查不连接 Telegram，仍需实际测试消息和媒体。根路径显示 Welcome 属正常情况。更新后在 CF **Deployments** 核对部署结果，再重新连接代理。

## 文件

```text
worker.js        Workers 完整代码
page.js          Pages 完整代码
pages/           Pages Git 部署所需的最小配置
wrangler.toml    Workers 绑定与迁移配置
package*.json    Workers 部署工具及依赖锁定
```

后续直接修改对应 JS，无需合并源码。免费套餐受 Cloudflare 配额限制，不承诺固定延迟或大文件永不断流。

本项目参考 Telegram 官方 [tproxy-server](https://github.com/telegramdesktop/tproxy-server) 协议独立实现，不是官方 Cloudflare 部署方案。

[MIT License](./LICENSE)
