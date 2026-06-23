'use client'
import { useEffect, useState } from 'react'
import type { Result } from '@/lib/result'

export function usePoll<T>(url: string, intervalMs: number) {
  const [data, setData] = useState<Result<T> | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    const tick = async () => {
      try {
        const res = await fetch(url)
        const json = (await res.json()) as Result<T>
        if (active) setData(json)
      } finally {
        if (active) setLoading(false)
      }
    }
    tick()
    const id = setInterval(tick, intervalMs)
    return () => { active = false; clearInterval(id) }
  }, [url, intervalMs])
  return { data, loading }
}
