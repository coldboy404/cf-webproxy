# Pages 部署

这是与 Workers 版共用协议、加密及 Telegram DC 转发代码的 **独立 Pages 版本**。不需要额外 Worker、Durable Object、KV、D1 或管理面板；只需配置 `PROXY_SECRET`。

## 1. 连接 GitHub

在 Cloudflare 控制台进入 **Workers & Pages → 创建应用 → Pages → 连接 Git / 导入现有 Git 存储库**，选择本仓库（或你的 Fork）。界面名称可能有所不同，确认创建的是 **Pages 项目**。

**首次创建主要填写下面两项：**

| 配置 | 值 |
|---|---|
| 根目录 / Root directory | `pages` |
| 构建命令 / Build command | `npm run build` |

其余设置：

- 生产分支确认是 `main`，框架预设保持 `None`（无）。
- 输出目录已在 `wrangler.toml` 中设为 `dist`；**如果创建页面仍要求填写，就填 `dist`**，不要填 `pages/dist`。
- Node 版本由仓库的 `.node-version` 指定，**不用再添加 `NODE_VERSION`**。若之前手动设置过旧版本，请删除该覆盖项，或改为 `22`。
- 不需要 Deploy command，也不要使用 `wrangler deploy`。如果页面要求 Workers 的部署命令，请切换到 Pages 创建流程。

这些是首次设置，不是每次更新都要重填。当前仓库同时支持 Workers 和 Pages，**根目录与构建命令不能全部留空**。

构建时会自动安装依赖，生成 `_worker.js`、路由配置和静态占位页。无须把生成的 `dist` 提交到 GitHub。构建需要仓库内的 `src`，不要只复制 `pages` 文件夹到另一个仓库。

## 2. 设置密钥

打开 **Pages 项目 → Settings → Variables and Secrets**，选择 **Production（生产）** 环境，添加 **Secret / 加密变量**：

| 名称 | 值 |
|---|---|
| `PROXY_SECRET` | 你自己的代理密钥 |

格式：**32 位小写十六进制字符（0–9、a–f）**，也支持 `dd` 前缀加 32 位（共 34 位），不支持 `ee` / FakeTLS。不要照抄他人的密钥。

**变量保存后，需要重新部署才能生效**：进入 **Deployments**，重新部署 / 重试生产部署，或者向 `main` 推送一次新提交。若创建项目时已设置密钥并部署成功，则无需再部署一次。

无需配置 `SESSION_SIGNING_KEY` 或任何资源绑定。Preview（预览）环境与生产环境分开配置；不需要预览部署时可关闭，不建议将生产密钥复制到预览环境。

## 3. 添加到 Telegram

使用部署成功后的 `项目名.pages.dev` 或自定义域名：

```text
https://t.me/webproxy?server=你的域名&secret=你的PROXY_SECRET
```

`server` 不含 `https://` 或路径；`secret` 必须与变量完全一致，包括可选的 `dd` 前缀。在支持 WEB Proxy 的 Telegram Android 客户端打开链接，测试消息收发和媒体加载。

**自定义域名**：在 **Pages 项目 → Custom domains → Set up a custom domain** 中添加域名，按提示完成 DNS 配置，等待域名和证书生效。不要只在 DNS 中手动 CNAME 而不在 Pages 添加域名。通常不需要设置 `PUBLIC_HOSTNAME`。

## 4. 更新与排障

- 生产分支 `main` 的新提交会触发 Pages Git 部署；Fork 用户需要先同步仓库。在 Pages 的 **Deployments** 中核对提交 ID 和成功状态，不要仅凭 GitHub 推送成功判断已更新。
- 若设置了构建监听路径，务必包含 `pages/*` 和 `src/*`；初次部署建议保留默认监听所有文件。
- 密钥、代码或域名更新后，在 Telegram 中关闭再开启代理，重新建立会话。
- 访问 `https://你的域名/healthz` 应返回 `{"ok":true,"carrier":"websocket","relay":"direct-telegram-dc"}`。`/health` 等价；KWS 模式的 `relay` 为 `telegram-kws`。密钥或出站配置无效返回 500。这只证明配置及 HTTP 入口可用，**不代表会话鉴权或 Telegram 链路正常**。
- 根路径只显示 Welcome，没有管理面板是正常的。排障可临时设置 `DIAGNOSTICS=1`，重新部署后查看 Pages Functions 实时日志；完成后关闭。
- 不要公开真实密钥、会话 Token 或完整 Bridge URL。

可选运行时变量：

| 名称 | 默认值 | 用途 |
|---|---|---|
| `PUBLIC_HOSTNAME` | 空 | 限制入口域名，不含协议或路径；为空时使用请求域名。 |
| `ALLOWED_HOSTNAMES` | 空 | 可选多入口白名单，逗号分隔；与 `PUBLIC_HOSTNAME` 同设时取交集。 |
| `RELAY_TRANSPORT` | `tcp` | 可选 `kws` Telegram 官方 KWS 出站（实验性），见 [完整指南](../docs/preferred-domains.md)。 |
| `MAX_STREAMS` | `64` | 每个 WebSocket 会话的最大逻辑连接数。 |
| `SESSION_TTL_SECONDS` | `300` | Bootstrap 凭证有效期，不是 WebSocket 接入票据或已建立连接的时长。 |
| `DIAGNOSTICS` | 关闭 | 设为 `1` 开启诊断日志。 |

## 与 Workers 版的区别

| 项目 | Pages 版 | Workers + Durable Objects 版 |
|---|---|---|
| 转发及加密 | 共用同一套实现，直连 Telegram DC | 同左 |
| 会话状态 | 保存在本次 WebSocket 请求内 | 由 Durable Object 统一管理 |
| WebSocket 首次接入 | 签名票据 60 秒内有效；过期需重新创建会话 | 创建后 10 分钟内首次接入 |
| 接入票据重复使用 | 60 秒内可建立多个独立连接，没有全局单次使用保证 | 同一会话同时只允许一个连接 |
| HTTP DELETE 撤销 | 不支持，已鉴权请求返回 405；内置 Bridge 会先关闭 WebSocket | 支持跨请求关闭会话 |

60 秒是接入窗口，**不会在第 60 秒断开已建立的连接**。每次 WebSocket 关闭后都会清理其 TCP 连接；断线或重新部署后需要新会话，不能恢复旧连接。Pages 版不保证延迟一定比 Workers 版低。

Pages Functions 仍运行在 Workers 运行时，受相应配额、TCP 出站限制及账号服务状态影响。**Pages 构建可用不代表 Functions 一定可运行，也不会解除账号已有的服务限制。**

## 本地检查（可选）

在仓库根目录执行：

```bash
npm ci
npm test
npm ci --prefix pages
npm run test:pages
```

`test:pages` 会构建并用 Wrangler 附带的本地 workerd 验证 HTTP、鉴权、WebSocket 和断线清理，不连接真实 Telegram DC，不能替代真机测试。

本地启动 Pages（先构建，在 `pages` 下准备未提交的 `.dev.vars`，写入测试用 `PROXY_SECRET`）：

```bash
cd pages
node ../node_modules/wrangler/bin/wrangler.js pages dev dist
```

Windows PowerShell 若提示禁止运行脚本，使用 `npm.cmd` 替代 `npm`，无需修改执行策略。不要提交 `.dev.vars`。

参考 Cloudflare 官方文档：[高级模式](https://developers.cloudflare.com/pages/functions/advanced-mode/)、[构建配置](https://developers.cloudflare.com/pages/configuration/build-configuration/)、[环境变量](https://developers.cloudflare.com/pages/functions/bindings/#environment-variables)。
