# cf-webproxy

轻量的 Telegram WEB Proxy，支持 **独立 Pages** 和 **Workers + Durable Objects** 部署。无需 VPS 或后端 MTProxy，支持 TCP / KWS 两种出站方式。

> 仅供交流学习，禁止搭建公共代理滥用 Cloudflare 资源。请遵守相关法律与服务条款，账号限制或封禁风险自行承担。

## 单文件部署

- **Workers：[`worker.js`](./worker.js)**，已合并全部代理代码；仍需配置 `PROXY_SECRET`、`SESSIONS` Durable Object 绑定及 `WebProxySession` 迁移，仓库 `wrangler.toml` 已包含绑定和迁移。不能只粘贴 JS、遗漏 DO 配置。
- **Pages：[`pages/_worker.js`](./pages/_worker.js)**，无需 DO。Git 部署继续使用下方配置；也可将此文件以 `_worker.js` 为名放在部署目录根部，添加 `index.html` 占位文件，再用 `npx wrangler pages deploy 目录 --project-name 你的项目名` 上传（不要使用 Workers 的在线编辑器）。

两个文件均无本地源码依赖，仅使用 Cloudflare 内置 API。维护源码和校验保留在仓库；修改源码后运行 `npm ci --prefix pages && npm run bundle` 更新单文件，不要直接编辑生成文件。Pages Git 构建会自动重新生成。

## 1. 部署

### Pages

在 Cloudflare 创建 **Pages** 项目，连接本仓库或 Fork：

- 生产分支：`main`
- 框架：`None`
- 根目录：`pages`
- 构建命令：`npm run build`
- 输出目录：`dist`（配置文件已指定）

进入 **Settings → Variables and Secrets → Production**，添加加密变量 `PROXY_SECRET`，然后重新部署。

**不需要部署命令、额外 Worker 或 Durable Object；Node 版本已在仓库指定。** [Pages 详细说明](./pages/README.md)

### Workers

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/coldboy404/cf-webproxy)

点击按钮并按提示部署，添加加密变量 `PROXY_SECRET`。若未提示填写，在 **Settings → Variables and Secrets** 中添加并重新部署。

命令行部署（Node.js 22.15+）：

```bash
npm ci
npx wrangler login
npx wrangler secret put PROXY_SECRET
npx wrangler deploy
```

以上按钮和命令仅用于 Workers，不用于 Pages。

### 密钥格式

`PROXY_SECRET` 为 **32 位小写十六进制字符（0–9、a–f）**，也支持 `dd` 前缀加 32 位，不支持 `ee` / FakeTLS。可生成：

```bash
openssl rand -hex 16
```

不要公开密钥或提交到仓库，无需配置 `BOOT` 或 `SESSION_SIGNING_KEY`。

## 2. 添加到 Telegram

在支持 WEB Proxy 的 Telegram 客户端中打开：

```text
https://t.me/webproxy?server=你的域名&secret=你的PROXY_SECRET
```

`server` 不含协议或路径；`secret` 与部署变量完全一致。添加后测试消息和媒体加载。

### 自定义域名

- **Pages**：项目 → Custom domains → Set up a domain，按提示绑定并等待生效。**保留指向本项目 `*.pages.dev` 的 CNAME，不要直接替换为第三方优选域名。**
- **Workers**：Settings → Domains & Routes → Add → Custom Domain。

本项目不提供自动 DNS 优选；Workers 的 SaaS 路由步骤不能直接用于 Pages。域名绑定不等于线路优选。

## 3. 可选 KWS 模式

KWS 将 **Cloudflare → Telegram** 的出站从 TCP 改为 Telegram 官方 WebSocket；**Pages、Workers 均支持，与 DNS 无关，不保证更快。**

1. 在项目生产环境添加普通变量 `RELAY_TRANSPORT=kws`。
2. 重新部署，在 Telegram 关闭再开启代理。
3. 域名和密钥不变；回退时改为 `RELAY_TRANSPORT=tcp` 并重新部署。

KWS 为实验性选项，默认仍使用 TCP。[域名与 KWS 说明](./docs/preferred-domains.md)

## 4. 配置与排障

除密钥外均为可选普通环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PROXY_SECRET` | 必填（加密变量） | 代理密钥 |
| `RELAY_TRANSPORT` | `tcp` | `tcp` 直连 DC；`kws` 官方 WebSocket |
| `PUBLIC_HOSTNAME` | 空 | 限制单个入口域名，不含协议或路径 |
| `ALLOWED_HOSTNAMES` | 空 | 逗号分隔的多入口白名单；与上一项同设时取交集 |
| `MAX_STREAMS` | `64` | 每会话最大逻辑连接数 |
| `SESSION_TTL_SECONDS` | `300` | Bootstrap 凭证有效期，不是连接时长 |
| `DIAGNOSTICS` | 关闭 | 设为 `1` 开启诊断日志 |

访问 `https://你的域名/healthz`（或 `/health`）：

- TCP：`relay` 为 `direct-telegram-dc`。
- KWS：`relay` 为 `telegram-kws`。
- 密钥或出站配置无效：返回 `500`。

**健康检查不拨号 Telegram，不能替代实际收发测试。** 根路径显示 Welcome 属正常情况。

无法连接时先检查客户端支持、密钥及部署状态；需要日志时临时开启 `DIAGNOSTICS=1`。不要公开会话 Token 或完整 Bridge URL。

## 目录

```text
worker.js     Workers 单文件部署入口
src/          可维护源码（不需要逐个上传）
  pages/      Pages 专用入口、鉴权与会话适配
pages/        Pages 单文件 _worker.js、构建与配置
  dist/       构建输出（不提交）
checks/       自动校验（*.check.js）
docs/         域名与 KWS 说明
wrangler.toml Workers 部署配置
```

## 更新与开发

Fork 用户先同步上游；已连接 Git 的生产分支更新会触发部署。在 Cloudflare **Deployments** 核对提交与部署结果，成功后重新连接 Telegram。

```bash
npm ci
npm ci --prefix pages
npm run check
npm run check:pages
npm run build:worker
```

构建成功不代表生产链路可用；免费套餐仍受 Cloudflare 配额限制，不承诺固定延迟或大文件永不断流。

本项目参考 Telegram 官方 [tproxy-server](https://github.com/telegramdesktop/tproxy-server) 协议独立实现，不是官方 Cloudflare 部署方案。

[MIT License](./LICENSE)
