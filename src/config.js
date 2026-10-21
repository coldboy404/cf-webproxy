// Entrance selection never changes the TLS hostname or trusts forwarding headers.
export function canonicalHost(value) {
  const host = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || !host.includes(".") || host.split(".").some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("Expected a DNS hostname without scheme, port or path");
  }
  return host;
}

export function entranceHost(env, hostname) {
  const host = canonicalHost(hostname);
  const pinned = env.PUBLIC_HOSTNAME ? canonicalHost(env.PUBLIC_HOSTNAME) : null;
  const list = env.ALLOWED_HOSTNAMES ? String(env.ALLOWED_HOSTNAMES).split(",").map(canonicalHost) : [];
  // PUBLIC_HOSTNAME remains a strict pin, even when an allowlist is configured.
  if (pinned && pinned !== host) return null;
  if (list.length && !list.includes(host)) return null;
  return host;
}

export function validateConfig(env) {
  if (!/^(?:[0-9a-f]{32}|dd[0-9a-f]{32})$/.test(String(env.PROXY_SECRET || ""))) {
    throw new Error("Invalid PROXY_SECRET");
  }
  const transport = env.RELAY_TRANSPORT ?? "tcp";
  if (transport !== "tcp" && transport !== "kws") throw new Error("RELAY_TRANSPORT must be tcp or kws");
  return transport;
}
