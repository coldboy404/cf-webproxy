# cf-webproxy

Cloudflare Workers-only implementation of Telegram Android's official **WEB Proxy** carrier. It does **not** need a VPS, stock MTProxy process, or any other backend.

```text
Telegram Android
  -> HTTPS / WebSocket WEB carrier
  -> Cloudflare Worker + Durable Object
  -> terminates MTProxy obfuscation per logical stream
  -> cloudflare:sockets directly to the selected Telegram DC:443
```

## What is implemented

- Official WEB Proxy bridge page (`TelegramWebProxy` Android bridge)
- Binary carrier frames and WebSocket multiplexing
- Per-session Durable Object
- MTProxy 64-byte obfuscated handshake termination
- Stateful AES-256-CTR transcoding in both directions
- Direct routing to Telegram DC 1-5 (hardcoded Telegram addresses only)
- `abridged`, `intermediate`, and `secure intermediate` transport tags
- Plain 16-byte secrets and `dd` secrets
- Stream/window limits, handshake validation, short-lived signed bootstrap tokens

FakeTLS (`ee...`) secrets are not supported by WEB Proxy mode.

## Deploy

Requirements: Node.js 20+ and a Cloudflare account with Workers enabled.

```bash
npm install
npx wrangler login
```

Create a secret (16 random bytes represented as 32 lowercase hex characters):

```bash
openssl rand -hex 16
npx wrangler secret put PROXY_SECRET
```

You may prefix it with `dd` when entering it if you want the `dd` secret form. Set an independent signing key:

```bash
openssl rand -hex 32
npx wrangler secret put SESSION_SIGNING_KEY
```

Deploy:

```bash
npm test
npm run deploy
```

For production, attach a custom domain in Cloudflare. If desired, put that hostname in `PUBLIC_HOSTNAME` in `wrangler.toml`; otherwise the Worker accepts the request hostname.

## Generate the Telegram link

The WEB Proxy URL is:

```text
https://t.me/webproxy?server=YOUR_HOSTNAME&secret=YOUR_SECRET
```

Example:

```text
https://t.me/webproxy?server=proxy.example.com&secret=dd0123456789abcdef0123456789abcdef
```

Do not include `https://` in `server`.

The hidden bridge capability is derived by the client and Worker as:

```text
base64url(HMAC-SHA256(secret_bytes,
  "tdesktop-web-proxy-bridge-v1\n" + lowercase_hostname))
```

## Configuration

| Name | Type | Purpose |
|---|---|---|
| `PROXY_SECRET` | Worker secret | Required. 32 hex chars, optionally `dd` + 32 hex chars. |
| `SESSION_SIGNING_KEY` | Worker secret | Required/recommended independent bootstrap signing key. |
| `PUBLIC_HOSTNAME` | Variable | Optional custom hostname, without scheme. |
| `MAX_STREAMS` | Variable | Maximum logical streams per session; default 64. |
| `SESSION_TTL_SECONDS` | Variable | Bootstrap validity; default 300 seconds. |

There are deliberately no arbitrary upstream host settings. A validated stream can connect only to Telegram's fixed DC table on TCP port 443.

## Development

```bash
npm test
npx wrangler deploy --dry-run
npx wrangler dev
```

`GET /healthz` returns the carrier and relay mode. Other unauthenticated paths return a camouflage page.

## Security notes

- Never commit `.dev.vars`, secret values, session tokens, or bridge URLs.
- Use a dedicated random `SESSION_SIGNING_KEY`.
- Cloudflare Workers TCP egress availability and limits depend on your Cloudflare plan and region.
- This project validates protocol structure but cannot guarantee availability where Cloudflare or Telegram traffic is restricted.

## License

MIT
