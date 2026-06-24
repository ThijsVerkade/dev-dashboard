import { NextRequest, NextResponse } from 'next/server'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import QRCode from 'qrcode'
import { parseTailscaleSelfName, buildMobileUrl } from '@/lib/mobile-url'
import { ok, failure, unconfigured } from '@/lib/result'

export const dynamic = 'force-dynamic'

const run = promisify(execFile)

async function detectTailscaleName(): Promise<string | null> {
  try {
    const { stdout } = await run('tailscale', ['status', '--json'], { timeout: 4000 })
    return parseTailscaleSelfName(stdout)
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const envBase = process.env.MOBILE_BASE_URL ?? null
  const port = req.headers.get('host')?.split(':')[1] ?? '3000'
  const tailscaleName = envBase ? null : await detectTailscaleName()
  const url = buildMobileUrl({ envBase, tailscaleName, port })

  if (!url)
    return NextResponse.json(
      unconfigured(
        'Could not determine the phone URL. Install Tailscale so `tailscale status` works, or set MOBILE_BASE_URL (e.g. http://your-mac.tailnet.ts.net:3000) in .env.local.',
      ),
    )

  try {
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 240 })
    return NextResponse.json(ok({ url, qr }))
  } catch (e) {
    return NextResponse.json(failure(e instanceof Error ? e.message : 'Failed to render QR code'))
  }
}
