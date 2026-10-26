# cf-webproxy

Telegram WEB Proxy，支持 TCP / KWS 出站，无需 VPS 或后端 MTProxy。

> 仅供学习交流，禁止搭建公共代理滥用 Cloudflare 资源。请自行评估账号限制、封禁及免费套餐配额风险。

- [`worker.js`](./worker.js)：Workers 独立版，需要 Durable Object。
- [`page.js`](./page.js)：Pages 独立版，无需 Durable Object。
- **[Workers SaaS 优选域名教程](./docs/README-SaaS.md)**：双域名、中间 CNAME、证书、Worker 路由及排错。

## Workers 部署（默认）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/coldboy404/cf-webproxy)

按提示部署并设置加密变量 `PROXY_SECRET`。根目录 `wrangler.toml` 已包含 `SESSIONS` 绑定与 `WebProxySession` 迁移；手动粘贴 JS 时也必须配置这些资源。

### GitHub Actions 自动更新

在仓库 **Settings → Secrets and variables → Actions → Secrets** 添加：

- `CLOUDFLARE_API_TOKEN`：目标账户的 **Workers Scripts → Edit** 权限；涉及其他资源时按需补充权限。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账户 ID，不是 Zone ID。

在 Cloudflare 目标 Worker 设置 `PROXY_SECRET`，再运行 **Actions → Deploy to Cloudflare → Run workflow**。以后推送到 `main` 自动部署到 `cf-webproxy`，不需要填写 Pages 项目名。

[工作流](./.github/workflows/deploy-cloudflare.yml)缺少凭据时仅验证构建，部署显示 **Skipped**，不代表已上线。使用 Actions 后关闭 Cloudflare 侧重复的 Git 自动构建；Dashboard 自定义变量仍需核对本地 Wrangler 同名配置，Secrets 不写入仓库。

<details>
<summary>命令行部署（Node.js 22.15+）</summary>

```bash
npm ci
npx wrangler login
npx wrangler secret put PROXY_SECRET
npx wrangler deploy
```

</details>

## Pages 部署（可选）

Cloudflare Pages 连接仓库，设置：

```text
生产分支：main
框架：None
根目录：pages
构建命令：npm run build
输出目录：dist
```

在 **Variables and Secrets → Production** 设置 `PROXY_SECRET` 后重新部署。构建将 `page.js` 复制为 `dist/_worker.js`；手动部署也须使用这个文件名，不要粘贴到 Workers 编辑器。

若改用 Actions，在仓库 Variables 设置 `CLOUDFLARE_DEPLOY_TARGET=pages`、`CLOUDFLARE_PAGES_PROJECT_NAME=已有项目名称`，API Token 使用 **Cloudflare Pages → Edit** 权限。工作流不会自动创建 Pages 项目。

## 密钥与连接

`PROXY_SECRET` 为 **32 位小写十六进制**，也支持 `dd` 加 32 位；不支持 `ee` / FakeTLS。

```bash
openssl rand -hex 16
```

在支持 WEB Proxy 的 Telegram 客户端打开：

```text
https://t.me/webproxy?server=你的域名&secret=你的PROXY_SECRET
```

`server` 不带协议或路径。不要公开密钥、会话 Token 或完整 Bridge URL。

## 域名与配置

- **Workers 普通域名**：Settings → Domains & Routes → Add → Custom Domain。
- **Workers SaaS 优选**：见[独立教程](./docs/README-SaaS.md)，不能只改入口 CNAME 而漏掉 Worker Route。
- **Pages 域名**：Custom domains → Set up a domain，保留指向本项目 `*.pages.dev` 的 CNAME。本教程未验证 Pages 优选。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PROXY_SECRET` | 必填，加密变量 | 代理密钥 |
| `RELAY_TRANSPORT` | `tcp` | 设置 `kws` 使用 Telegram 官方 WebSocket 出站 |
| `PUBLIC_HOSTNAME` | 空 | 限制单个入口域名 |
| `ALLOWED_HOSTNAMES` | 空 | 逗号分隔白名单；与上一项同设时取交集 |
| `MAX_STREAMS` | `64` | 每会话最大逻辑连接数 |
| `SESSION_TTL_SECONDS` | `300` | Bootstrap 凭证有效期，不是连接时长 |
| `DIAGNOSTICS` | 关闭 | `1` 开启诊断日志 |

修改运行变量后重新部署，在 Telegram 关闭再开启代理。KWS 优化的是出站路径，不等于 DNS 入口优选，也不保证更快；回退时改为 `tcp`。

## 检查

访问 `/healthz` 或 `/health`：正常返回 `ok: true`，TCP 的 `relay` 为 `direct-telegram-dc`，KWS 为 `telegram-kws`；密钥或出站配置无效返回 500。根路径显示 Welcome 属正常情况。

健康检查不连接 Telegram，仍需实测消息和媒体。更新后核对 Cloudflare **Deployments** 与入口状态，不承诺固定延迟或大文件永不断流。

参考 Telegram 官方 [tproxy-server](https://github.com/telegramdesktop/tproxy-server) 协议独立实现，非官方 Cloudflare 部署方案。后续直接修改对应 JS，无需合并源码。

[MIT License](./LICENSE)
