# Workers SaaS 优选域名教程

[返回主 README](../README.md)

基本就是普通网站的 SaaS 优选配置，区别是：**源站换成 Worker，并额外添加一条 Worker 路由，不需要 VPS、源站证书或反向代理。** 本教程适用于 Workers 版，不适用于 Pages。

## 准备

先[部署本项目](../README.md)，设置 `PROXY_SECRET`。准备两个已接入 Cloudflare 的自有域名，以及一个第三方优选域名。

以下只是示意名称，**全部换成自己的，不要直接使用**：

- 访问入口：`t.a.com`
- 回退源站：`t.b.com`
- 中间域名：`yx.b.com`
- 第三方优选域名：使用你选定的提供方域名。

Worker 与 `b.com` 建议位于同一 Cloudflare 账户。

## 一、配置 b.com

### 绑定 Worker 域名

进入 `cf-webproxy` Worker → **Settings → Domains & Routes → Add → Custom Domain**，添加：

```text
t.b.com
```

保留 Cloudflare 自动管理的 DNS 记录。打开 `https://t.b.com/healthz`，确认返回 `"ok":true`。

### 添加优选中间域名

进入 **b.com → DNS**，添加：

```text
类型：CNAME
名称：yx
目标：你的第三方优选域名
代理：仅 DNS（灰云）
```

目标只填域名，不带 `https://`、端口或路径。

## 二、配置 SaaS

进入 **b.com → SSL/TLS → 自定义主机名（Custom Hostnames）**：

1. 开通 Cloudflare for SaaS；如果要求绑卡，先确认费用和配额。
2. 添加回退源站 **`t.b.com`**，等待状态为 Active / 有效。
3. 添加自定义主机名 **`t.a.com`**，选择 TXT 验证（若界面提供）。
4. 按页面给出的内容，到 **a.com → DNS** 添加所有权与证书验证记录；名称和值照抄，不要自己编。

验证记录不要删，后面检查主机名与证书状态均为 Active / 有效。

## 三、配置访问入口

进入 **a.com → DNS**，添加或修改现有记录：

```text
类型：CNAME
名称：t
目标：yx.b.com
代理：仅 DNS（灰云）
```

不要给同一个名称叠加两条 CNAME。若 `t.a.com` 原来直接绑定为 Worker Custom Domain，先准备好备用入口，再处理旧绑定管理的记录。

最终 DNS 链：

```text
t.a.com → yx.b.com → 第三方优选域名 → 优选 IP
```

**不要省略 `yx.b.com` 直接指向第三方**，否则 SaaS 可能显示 `Moved / custom hostname does not CNAME to this zone`。中间域名只是 DNS 别名，不会额外增加一台转发服务器。

## 四、添加 Worker 路由（关键）

进入 **b.com → Workers 路由 → 添加路由**：

```text
路由：t.a.com/*
Worker：cf-webproxy
```

**在 b.com 的服务区添加，但路由填访问入口 `t.a.com/*`。** 不要填 `t.b.com/*` 或 `yx.b.com/*`，也不必用接管整个服务区的 `*/*`。

只绑定回退源站的 Worker 域名，不等于 SaaS 请求也会执行 Worker。漏掉这一步，可能出现回退源站正常、访问入口报 **522**。

## 五、测试使用

确认 SaaS 主机名与证书都为 **Active / 有效**，再访问：

```text
https://t.a.com/healthz
```

返回 `"ok":true` 后，在支持 WEB Proxy 的 Telegram 客户端打开：

```text
https://t.me/webproxy?server=t.a.com&secret=你的PROXY_SECRET
```

再实测消息、图片和视频；健康检查成功不代表全部代理功能已验证。若设置了 `PUBLIC_HOSTNAME` / `ALLOWED_HOSTNAMES`，确保它们允许 `t.a.com`。

## 简单排错

- **522**：先检查 b.com 中是否添加了 `t.a.com/* → cf-webproxy` 路由，再检查 SaaS 状态和优选线路。
- **Moved**：核对两层 CNAME，保留验证记录，不要忽略该状态。
- **证书错误**：检查 SaaS SSL 状态和验证记录，不要关闭证书验证。
- **优选后不通**：将 `t.a.com` 的同一条灰云 CNAME 临时改回 `t.b.com`，保留 SaaS 和 Worker 路由，先恢复普通接入。

第三方优选不保证提速或长期可用，应在实际使用网络测试，并关注证书续期。SaaS 只影响入口，`RELAY_TRANSPORT=kws` 是独立的 Telegram 出站选项，两者不要混淆。

[Cloudflare 官方：Worker 作为 SaaS 回退源站](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)
