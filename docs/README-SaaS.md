# Workers SaaS 优选域名教程

[返回主 README](../README.md)

适用于本项目 **Workers 版**：用 Cloudflare for SaaS 自定义主机名接入 Worker，再通过中间 CNAME 获取第三方优选 IP。不是 Pages 优选教程，也不是自动测速工具。

> 本方案优化的是「客户端 → Cloudflare」入口，不改变「Worker → Telegram」出站。第三方线路不保证速度、可达性或长期稳定；遵守 Cloudflare 使用条款，不要搭建公共代理。

## 1. 准备域名

需要两个自己控制的 Cloudflare 域名服务区，以及一个第三方优选域名。建议 Worker 和 SaaS 服务区在同一账户。

以下全部使用保留示例域名 `example.com` / `example.net`，仅用于说明结构，并非可用服务；**部署时请替换为你自己控制的域名**：

| 角色 | 示例 | 用途 |
|---|---|---|
| 访问域名 | `t.example.com` | Telegram 客户端填写的入口 |
| 回退源站域名 | `t.example.net` | 已绑定 `cf-webproxy` Worker Custom Domain |
| 中间优选域名 | `tg.example.net` | 属于 SaaS 服务区，CNAME 到第三方优选域名 |
| 第三方优选域名 | `优选提供方给出的域名` | 提供候选 Cloudflare IP；需自行验证 |

这里访问域名所属服务区为 `example.com`，SaaS 服务区为管理 `example.net` 的那个 Cloudflare Zone。以 Dashboard 实际服务区为准，不要只按域名层级猜测。

最终 DNS 链：

```text
t.example.com → tg.example.net → 第三方优选域名 → 优选 IP
```

实际请求路径：

```text
客户端（SNI / Host: t.example.com）
  → Cloudflare 优选入口
  → SaaS 自定义主机名 + Worker Route
  → cf-webproxy
  → Telegram（TCP 或 KWS）
```

CNAME 只参与 DNS 解析，不代表请求依次经过两个网站或多一台转发服务器。

## 2. 先验证 Worker 原始入口

先按[主 README](../README.md)部署 Workers，设置加密变量 `PROXY_SECRET`。

在 Worker 的 **Settings → Domains & Routes → Add → Custom Domain** 绑定：

```text
t.example.net
```

让 Cloudflare 管理对应记录，不要把它改成第三方优选 CNAME。访问：

```text
https://t.example.net/healthz
```

应返回 HTTP 200 和 `"ok":true`。先确认原始入口可用，再配置 SaaS；不要一开始就删除已有可用入口。

## 3. 配置 SaaS 回退源站和证书

进入 **SaaS 服务区（管理 example.net 的 Zone）→ SSL/TLS → Custom Hostnames / 自定义主机名**：

1. 启用 Cloudflare for SaaS。若要求支付方式或套餐确认，先核对页面费用和配额。
2. 将 **Fallback Origin / 回退源站** 设置为 `t.example.net`，等待 Active。
3. 添加自定义主机名 **`t.example.com`**，选择 TXT 验证（若界面提供）。
4. 按页面实际给出的名称和值，到 `example.com` 的 DNS 添加所有权验证和证书验证记录；不要自行拼接 TXT 值。
5. 保留验证记录，并检查主机名状态、SSL 证书状态均为 **Active**。验证或刷新可能需要等待，不能只看其中一项。

首次接入可先将访问域名设置为 **灰云 CNAME → `t.example.net`**，验证普通 SaaS 链路，确认正常后再切到第 5 节的优选中间域名。

如果 `t.example.com` 原来直接绑定为 Worker Custom Domain，不能同时照搬两种管理方式；先准备并验证备用入口，再处理旧绑定及其管理的 DNS，避免切换中断。

## 4. 添加 Worker Route：不要漏掉

进入 **SaaS 服务区 → Workers Routes / Workers 路由 → 添加路由**：

```text
路由：t.example.com/*
Worker：cf-webproxy
```

**这里填访问域名，不是回退源站域名或中间优选域名。** 虽然访问域名不属于这个 Zone 的名称后缀，但它是此 SaaS 服务区的自定义主机名；应在 SaaS 服务区添加此路由。

仅将 `t.example.net` 绑定为 Worker Custom Domain，不等于 `t.example.com` 的 SaaS 流量会执行同一个 Worker。实际排查中曾出现原始入口 200、访问入口 522，添加对应路由后恢复 200。

优先使用此精确路由，**不要在有其他业务的服务区直接添加 `*/*`**。Cloudflare 官方也提供通配路由方案，但会匹配该区更多流量，需自行审查影响范围。

## 5. 配置两层优选 CNAME

### SaaS 服务区：中间记录

在管理 `example.net` 的 DNS 中添加：

```text
类型：CNAME
完整名称：tg.example.net
目标：你的第三方优选域名
代理状态：仅 DNS（灰云）
TTL：自动
```

目标只填域名，不带协议、端口或路径。不要填写示例中文占位符。

### 访问域名服务区：入口记录

在 `example.com` 中添加或修改**同一条** `t` 记录：

```text
类型：CNAME
名称：t
目标：tg.example.net
代理状态：仅 DNS（灰云）
TTL：自动
```

同名不能再叠加一条 CNAME；先核对并处理冲突的 A / AAAA / CNAME。灰云使客户端沿 CNAME 获取优选解析，开橙云不能当成相同方案。

### 为什么不能直接 CNAME 到第三方？

本例中，直接将访问域名指向第三方，曾使 SaaS 显示：

```text
Moved / 已移动
custom hostname does not CNAME to this zone
```

中间域名让访问域名先指向自己的 SaaS 服务区，再从后续 CNAME 获取优选 IP。它不是额外的 HTTP 反向代理。以后更换提供方，也只需改中间记录。

这是本例的实际接入方式，**不是任意第三方线路都能用的保证**。必须持续检查主机名状态、证书续期和实际访问；若仍出现 Moved，不要当成无害提示。Cloudflare 文档说明，Moved 持续七天可能转为 Deleted。

## 6. 验证代理

从实际使用 Telegram 的网络执行：

```bash
curl --connect-timeout 5 --max-time 15 https://t.example.com/healthz
```

不应跳过证书验证。使用 KWS 时，正常响应形如：

```json
{"ok":true,"carrier":"websocket","relay":"telegram-kws"}
```

TCP 模式的 `relay` 为 `direct-telegram-dc`，也属于正常配置。SaaS 优选不会自动启用 KWS；需要时在 Worker 中设置 `RELAY_TRANSPORT=kws`，重新部署并重连。

如设置了 `PUBLIC_HOSTNAME` / `ALLOWED_HOSTNAMES`，确保访问域名被允许。两者同时设置时取交集；只添加白名单而保留另一个不匹配的单域名限制，仍可能失败。

在支持 WEB Proxy 的 Telegram 客户端打开：

```text
https://t.me/webproxy?server=t.example.com&secret=你的PROXY_SECRET
```

检查连接、收发消息、图片和视频。**健康接口不连接 Telegram，200 不等于媒体和吞吐验证通过。** 不要公开密钥、会话 Token 或完整 Bridge URL。

测速应来自客户端实际网络。服务器测到的 CF-Ray 机房不代表你的入口，Ping 低也不保证 WebSocket 稳定或下载更快。

## 7. 常见问题与回滚

- **原始入口 200，访问入口 522**：优先检查 SaaS 服务区的 `访问域名/* → cf-webproxy` 路由，再检查 SaaS 状态、优选线路。522 本身不能证明唯一原因。
- **Moved / 不再 CNAME 到此服务区**：检查是否省略了自己服务区内的中间 CNAME，以及该记录是否确实属于正确 SaaS Zone。先改回访问域名 → 回退源站的灰云 CNAME，等待重新验证。
- **证书错误**：检查访问域名的 SaaS SSL 状态、验证记录及 CAA；不要用 `curl -k` 或关闭浏览器验证掩盖问题。
- **403 / 1000 / 1034**：检查第三方解析、域名白名单和 Cloudflare 路由限制。中间域名不是用户入口，直接访问它报错不能代替最终入口测试。
- **健康接口 500**：检查 `PROXY_SECRET` 格式和出站配置。
- **修改 Worker 后路由丢失**：核对 Wrangler / Actions 与 Dashboard 的路由管理是否冲突；保留 SaaS 路由并在每次部署后复查入口，不能只看 Actions 绿色。

回滚优选：将访问域名的同一条灰云 CNAME 从 `tg.example.net` 改回 `t.example.net`。保留 SaaS、验证记录和精确 Worker Route，再验证健康接口及客户端连接。不需要删除整个 Worker 或重新生成代理密钥。

## 参考

- [Cloudflare：Worker 作为 SaaS 回退源站](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)
- [Cloudflare：配置 SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/)
- [Cloudflare：Moved 状态与移除自定义主机名](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/remove-custom-hostnames/)
