export function canonicalHost(value) {
  return String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "").replace(/\.$/, "").toLowerCase();
}

export function configuredHosts(env) {
  const values = [env.PUBLIC_HOSTNAME, env.PREFERRED_HOSTNAMES]
    .flatMap((value) => String(value || "").split(","))
    .map(canonicalHost)
    .filter(Boolean);
  return new Set(values);
}
