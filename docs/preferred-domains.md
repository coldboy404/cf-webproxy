# 自定义域名、优选入口与 KWS 出站

## 先分清两段线路

```text
Telegram → 你的入口域名 → Cloudflare 边缘 → Telegram
           DNS/TLS/路由优选                 tcp 或 kws
```

入口优选只影响第一段；`RELAY_TRANSPORT=kws` 改的是最后一段。它们可以同时使用，但都不保证提速。不实现自动扫描、第三方优选订阅或自动 DNS 改写，也不需要为此增加定时任务。

### 普通自定义域名（推荐起点）

- Workers：Settings → Domains & Routes → Add → Custom Domain。
- Pages：Custom domains → Set up a custom domain。
- 等待域名、证书就绪，再用该域名生成 Telegram 链接。不需要更改代码。
- 不要只 CNAME 到 `workers.dev` / `pages.dev` 而不绑定域名；DNS 解析成功不代表 TLS 和应用路由有效。
- Workers Custom Domain 的 DNS 由 Cloudflare 管理；不要为了优选直接覆盖它。如果需要控制解析目标，请先完成专用的 Routes / SaaS 架构。

### SaaS 自定义主机名 / 优选（进阶，仅说明条件）

CF-Workers-TGProxy README 所说的 CNAME / SaaS 优选属于 Cloudflare 基础设施配置，不是脚本里的优选算法。它的代码同样使用请求域名生成 Bridge、同源 API 和 WebSocket。

1. 在你可管理的 SaaS zone 启用 Cloudflare for SaaS，创建 fallback origin。
2. 按官方 Workers-as-origin 文档将流量路由到本 Worker；**仅绑定 Worker Custom Domain 不等于已接管 SaaS 自定义主机名**。
3. 在 SaaS 配置中添加最终入口，例如 `tg.example.net`，完成域名所有权和证书验证，确认 hostname 和 SSL 状态均就绪。
4. 先按 SaaS 指定的 CNAME target 建立基线并验证。若你另有可用优选解析方案，再在其支持范围内调整 DNS；第三方优选目标必须能将该 hostname/SNI 的流量送到正确的 SaaS zone。
5. Telegram `server` 始终填 **你已验证的最终入口 `tg.example.net`**，不是 SaaS 的 CNAME target，也不是第三方优选域名。

Cloudflare 官方 Worker-as-origin 示例的 `*/*` route 会接管整个 zone 的流量。不要盲目在承载其他服务的主 zone 上使用；优先专用 zone 或限制路由作用域。Pages 普通自定义域名按 Pages 控制台绑定即可，本文不保证 Pages 原生支持上述 Workers-as-origin SaaS 接法。

任意 CF IP / 第三方域名并不天然支持你的服务。CNAME 不能改变客户端发送的 SNI 和 Host；证书不匹配、路由未命中、跨账号配置不支持等仍可能导致 403 / 1034 / TLS 错误。不要通过跨域重定向、关闭证书校验或信任 `X-Forwarded-Host` 来绕过。

## 入口配置：简单 Key-Value

正常无需设置；同一部署有多个入口且想限制访问时，添加普通环境变量：

```text
ALLOWED_HOSTNAMES=tg.example.net,tg-backup.example.net
```

- 逗号分隔的精确 DNS hostname，不支持通配符、协议、端口或路径。
- Bridge / WebSocket 使用当前请求入口，凭证不能跨域名重复使用；切换入口后重新添加链接并建立会话。
- 留空允许所有已路由到该部署的入口，依然需要正确的密钥。
- 旧 `PUBLIC_HOSTNAME` 仍为严格单域名限制；同时设置时取交集。想启用多个入口，删除旧的单域名限制。
- 变量不会替你创建 DNS、证书、Custom Domain 或 SaaS 资源。

## 可选 KWS 出站（实验性，先测后切换）

```text
RELAY_TRANSPORT=kws
```

默认 `tcp` 保持原有直连 DC:443 路径。`kws` 改用固定的 Telegram 官方 `kws{1..5}[-1].web.telegram.org/apiws`，使用 `binary` WebSocket 子协议；媒体连接优先 `-1`，握手失败尝试同 DC 的另一入口。不会连任意自定义出站域名，也不会把一个已发送数据的连接迁移到其他入口。

沿用本项目原有 MTProto transport obfuscation 重签和客户端载体，不额外增加 BOOT。Telegram 内层 MTProto 消息仍由客户端加密。Workers 版保留 Durable Object；Pages 版仍无需 DO。**没有把上游的 websocket-lanes / isolate 内 lease 方案移植过来**，避免把多个 isolate 的 Map 误认为全局状态。

修改变量后重新部署，在 Telegram 关闭再开启代理，分别测试消息、图片、视频、大文件和断网重连。KWS 属于可选新路径，单元测试或构建通过不代表当地网络和实际客户端已经验证。出现问题只需改回 `RELAY_TRANSPORT=tcp` 并重新部署，不必换密钥。

## 健康检查与验收

`GET /healthz` 和 `GET /health` 等价。正常 KWS 配置返回：

```json
{"ok":true,"carrier":"websocket","relay":"telegram-kws"}
```

TCP 的 `relay` 仍为 `direct-telegram-dc`。密钥缺失/格式错误或出站配置无效返回 500，且不会回显密钥。域名不在允许范围返回 404。

该接口检查配置和 HTTP 入口，**不拨号 Telegram、不证明数据面可用**。完整验收必须包括 Telegram 实际收发和媒体传输。免费套餐仍受请求、CPU、内存等 Cloudflare 配额约束，不能承诺“大文件永不断流”或“固定提升数倍”。

## 参考与边界

- [对照项目 README 的访问优化说明](https://github.com/ToiCF/CF-Workers-TGProxy#访问优化cname--saas-优选)
- [Cloudflare Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Workers as SaaS fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)
- [Pages Custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)

对照项目为 GPL-3.0，本项目保持 MIT；这里是基于既有代码独立实现的可选出站与入口配置，不复制其单文件实现。宣传文案中的“32 位小写字母和数字”不够准确：SECRET 是十六进制，普通 32 位只允许 `0-9a-f`；本项目继续使用 `PROXY_SECRET`，不改成 SECRET/BOOT。
