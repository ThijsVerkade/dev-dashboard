# "Open on phone" QR code + expanded Tailscale docs

## Problem

The `/m` mobile page is reachable over Tailscale, but typing
`http://<mac>.<tailnet>.ts.net:3000/m` on a phone is fiddly. Make joining
one-tap: show a QR code in the dashboard that opens `/m` on the phone. Also
expand the README into a fuller step-by-step setup.

## Approach

A button in the Agents panel opens a dialog containing a QR code that encodes
the Mac's Tailscale `/m` URL. The desktop browser only knows `localhost`, so
the **server** resolves the real URL: it auto-detects the Mac's MagicDNS name
via the Tailscale CLI, with an explicit `MOBILE_BASE_URL` env override. The QR
image is generated server-side so the client just renders an `<img>`.

## Components

### `lib/mobile-url.ts` (pure, testable)

- `parseTailscaleSelfName(raw: string): string | null` — parse
  `tailscale status --json`, return `Self.DNSName` with the trailing dot
  stripped; `null` if missing or unparseable.
- `buildMobileUrl({ envBase, tailscaleName, port }): string | null` —
  - if `envBase` is set: `${envBase trimmed of trailing slashes}/m`
  - else if `tailscaleName` is set: `http://${tailscaleName}${port?`:${port}`:''}/m`
  - else `null`.

### `GET /api/mobile/url` → `Result<{ url: string; qr: string }>`

- `envBase = process.env.MOBILE_BASE_URL ?? null`.
- `port` from the request `Host` header (default `3000`).
- If no `envBase`, run `execFile('tailscale', ['status','--json'])` (4s
  timeout) and `parseTailscaleSelfName`; on any failure, treat as `null`.
- `url = buildMobileUrl(...)`. If `null` → `unconfigured(...)` with a message
  telling the user to install Tailscale (so `tailscale status` works) or set
  `MOBILE_BASE_URL`.
- Else generate `qr = await QRCode.toDataURL(url, { margin: 1, width: 240 })`
  and return `ok({ url, qr })`; QR failure → `failure(...)`.

### `components/mobile-qr-dialog.tsx` (client)

- `MobileQrDialog`: an "📱 Open on phone" `Button` wrapped in the existing
  shadcn `Dialog`. On open, fetch `/api/mobile/url`. States: loading; error
  (`unconfigured`/`failure` → show `message`); success → render the QR `<img>`
  (data URL), the URL as a link, and a one-line "same Tailscale network" hint.

### Wiring

- `components/agents-panel.tsx`: place `<MobileQrDialog />` in the
  "Send Ticket to Claude" card header (flex row, right-aligned).

### New dependency

- `qrcode` (runtime) + `@types/qrcode` (dev). MIT, used only server-side.

## README

Replace the existing "Trigger agents from your phone (Tailscale)" section with
a fuller step-by-step: install Tailscale on Mac + phone, enable MagicDNS, find
the Mac name (`tailscale status`), set `AGENT_TRIGGER_TOKEN` + `AGENT_REPOS`,
optionally `MOBILE_BASE_URL`, run `npm run dev:lan`, use the **Open on phone**
QR button, scan, enter PIN once. Keep the existing PIN and exposure-caution
subsections.

## Testing

- Unit-test `parseTailscaleSelfName` (extract + strip trailing dot; missing
  field → null; invalid json → null).
- Unit-test `buildMobileUrl` (env base wins + trailing-slash trim; tailscale +
  port build; tailscale without port; neither/blank → null).
- Route and dialog are thin (consistent with the repo's untested route
  handlers / UI components); the CLI call and QR render are exercised manually.

## Out of scope (YAGNI)

- QR on pages other than Agents.
- Auth on `/api/mobile/url` (read-only; sits behind the tailnet like the other
  read endpoints).
- Detecting a non-default scheme/port beyond the request Host header.
