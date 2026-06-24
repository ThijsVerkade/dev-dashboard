'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { Result } from '@/lib/result'

type MobileUrl = { url: string; qr: string }

export function MobileQrDialog() {
  const [data, setData] = useState<Result<MobileUrl> | null>(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    setData(null)
    try {
      const res = await fetch('/api/mobile/url')
      setData((await res.json()) as Result<MobileUrl>)
    } catch (e) {
      setData({ ok: false, reason: 'error', message: e instanceof Error ? e.message : 'Request failed' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog onOpenChange={(open) => { if (open) load() }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-none font-mono text-xs">
          📱 Open on phone
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono text-sm tracking-tight">Open on your phone</DialogTitle>
        </DialogHeader>

        {loading && <p className="font-mono text-xs text-muted-foreground">resolving address…</p>}

        {data && !data.ok && <p className="font-mono text-xs text-amber-500">{data.message}</p>}

        {data?.ok && (
          <div className="flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URL QR, next/image adds no value */}
            <img
              src={data.data.qr}
              alt="QR code that opens the dashboard on your phone"
              width={240}
              height={240}
              className="rounded bg-white p-2"
            />
            <a
              href={data.data.url}
              className="break-all text-center font-mono text-xs text-primary underline underline-offset-2"
            >
              {data.data.url}
            </a>
            <p className="font-mono text-[11px] text-muted-foreground">
              Scan with your phone&apos;s camera — the phone must be on the same Tailscale network.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
