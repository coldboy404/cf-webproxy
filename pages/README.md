# Pages 部署

独立 Pages 版本，无需额外 Worker、Durable Object、KV 或 D1。支持 TCP 与可选 KWS 出站。

单文件入口：[`_worker.js`](./_worker.js)，无本地源码依赖。下面的 Git 部署流程无需改变，构建会自动生成该文件并复制到 `dist`。维护源码仍保留在 `src/`，校验仍保留在 `checks/`。

## 1. 创建项目

Cloudflare → **Workers & Pages → 创建应用 → Pages → 连接 Git**，选择本仓库或 Fork：

- 生产分支：`main`
- 框架：`None`
- 根目录：`pages`
- 构建命令：`npm run build`
- 输出目录：`dist`（配置文件已指定）

Node 版本已在仓库指定，无需添加 `NODE_VERSION`。不填写部署命令；若要求 `wrangler deploy`，说明进入了 Workers 创建流程。

构建需要仓库内的 `src`，不要只复制 `pages` 文件夹。构建监听路径如有设置，需包含 `src/*` 和 `pages/*`。

## 2. 设置密钥

进入 **Settings → Variables and Secrets → Production**，添加加密变量：

```text
PROXY_SECRET=你自己的密钥
```

格式为 **32 位小写十六进制（0–9、a–f）**，或 `dd` 加 32 位；不支持 `ee` / FakeTLS。可用 `openssl rand -hex 16` 生成。

保存后重新部署。无需 `BOOT`、`SESSION_SIGNING_KEY` 或其他资源绑定。生产与预览环境的变量分别配置。

## 3. 域名与 Telegram

可直接使用 `项目名.pages.dev`。绑定自己的域名时：

1. 项目 → **Custom domains → Set up a domain**。
2. 按提示完成 DNS，等待域名和证书生效。
3. **保留指向本项目 `*.pages.dev` 的 CNAME，不要直接换成第三方优选域名。**

不要只添加 DNS 而不在 Pages 绑定域名，也不需要 Worker 路由或 SaaS fallback 配置。本项目没有已验证的 Pages DNS 优选教程。

在支持 WEB Proxy 的 Telegram 客户端打开：

```text
https://t.me/webproxy?server=你的域名&secret=你的PROXY_SECRET
```

`server` 不含协议或路径。密钥须与变量完全一致，添加后实际测试消息和媒体。

## 4. 可选 KWS

在生产环境添加普通变量：

```text
RELAY_TRANSPORT=kws
```

重新部署，在 Telegram 关闭再开启代理。**域名、DNS 和密钥均不变。** 回退时改为 `tcp` 并重新部署。

KWS 使用 Telegram 官方 WebSocket 出站，不是入口优选，不保证提速；默认 TCP。[其他可选变量](../README.md#4-配置与排障)

## 5. 更新与检查

- Fork 用户先同步仓库，在 **Deployments** 核对生产提交和部署成功状态。
- `/healthz` 或 `/health` 的 `relay`：TCP 为 `direct-telegram-dc`，KWS 为 `telegram-kws`。密钥或出站配置无效返回 500。
- 健康检查只验证配置和 HTTP 入口，不证明 Telegram 链路正常。
- 根路径显示 Welcome 属正常情况；排障可临时设置 `DIAGNOSTICS=1`。
- 不要公开密钥、会话 Token 或 Bridge URL。

Pages 接入票据有效期为 60 秒，**不会因此中断已建立连接**；票据没有全局单次使用保证，HTTP DELETE 不支持跨请求撤销。Workers 版使用 Durable Object 管理会话，两者均受 Cloudflare 配额限制。

本地检查（仓库根目录，Node.js 22.15+）：

```bash
npm ci
npm ci --prefix pages
npm run check
npm run check:pages
```

构建只生成部署文件，不能替代 Telegram 实际收发验证。Windows PowerShell 如拦截脚本，使用 `npm.cmd`。
