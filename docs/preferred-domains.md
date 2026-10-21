# 自定义域名与 KWS

## 自定义域名

- **Pages**：项目 → Custom domains → Set up a domain。按提示完成绑定，保留指向本项目 `*.pages.dev` 的 CNAME。
- **Workers**：Settings → Domains & Routes → Add → Custom Domain。

等待证书生效后，在 Telegram 链接中使用自己的域名。通常无需设置 `PUBLIC_HOSTNAME`。

**不要直接将 Pages 的 CNAME 改为第三方优选域名。** 本项目没有已验证的 Pages DNS 优选配置，Workers 的 SaaS / fallback / Route 步骤也不能直接用于 Pages。

对照项目 CF-Workers-TGProxy 仅建议 CNAME / SaaS 优选，未提供具体优选目标或完整教程。自定义域名不等于线路优选；本项目不自动测速或修改 DNS。

## KWS：不改 DNS 的可选出站

```text
客户端 → Cloudflare → Telegram
                     ↑ tcp / kws
```

Pages 和 Workers 均支持。在项目生产环境设置普通变量：

```text
RELAY_TRANSPORT=kws
```

重新部署，再在 Telegram 关闭并开启代理。域名和密钥不变，不需要 `BOOT`。恢复时改为 `RELAY_TRANSPORT=tcp` 并重新部署。

- `tcp`（默认）：直连 Telegram DC:443。
- `kws`（实验性）：连接 Telegram 官方 `kws{1..5}[-1].web.telegram.org/apiws`；打开连接失败时尝试同 DC 备用入口，不重放已发送的数据。

KWS 只改变 CF 到 Telegram 的出站方式，不是客户端到 CF 的入口优选，也不保证更快。内层 MTProto 载荷仍由客户端加密；Workers 版仍使用 DO，Pages 版无需 DO。

## 可选入口白名单

```text
ALLOWED_HOSTNAMES=proxy.example.com,backup.example.com
```

仅填写逗号分隔的精确域名，不含协议、端口或路径。它只限制访问，不创建 DNS 或证书；与单域名限制 `PUBLIC_HOSTNAME` 同设时取交集。切换入口需重新建立会话。

## 验证

访问 `/healthz` 或 `/health`，KWS 的 `relay` 应为 `telegram-kws`。健康检查不连接 Telegram，仍需测试消息、媒体和断线重连。免费套餐受 Cloudflare 配额限制，不承诺固定延迟或持续传输不中断。

参考：[Pages 域名](https://developers.cloudflare.com/pages/configuration/custom-domains/) · [Workers 域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
