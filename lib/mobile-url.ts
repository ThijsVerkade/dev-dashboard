/** Extract the device's MagicDNS name from `tailscale status --json`,
 *  stripping the trailing dot. Returns null if absent or unparseable. */
export function parseTailscaleSelfName(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { Self?: { DNSName?: unknown } }
    const name = data?.Self?.DNSName
    if (typeof name !== 'string' || !name.trim()) return null
    return name.trim().replace(/\.$/, '')
  } catch {
    return null
  }
}

/** Build the phone URL to encode in the QR. Prefers an explicit env base;
 *  otherwise builds from the Tailscale name (+ optional port). Null if neither. */
export function buildMobileUrl(opts: {
  envBase?: string | null
  tailscaleName?: string | null
  port?: string | number | null
}): string | null {
  const envBase = opts.envBase?.trim()
  if (envBase) return `${envBase.replace(/\/+$/, '')}/m`

  const name = opts.tailscaleName?.trim()
  if (name) {
    const port = opts.port == null || opts.port === '' ? '' : `:${opts.port}`
    return `http://${name}${port}/m`
  }
  return null
}
