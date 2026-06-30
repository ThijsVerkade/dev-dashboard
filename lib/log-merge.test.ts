import { expect, test } from 'vitest'
import { mergeLine, type LogLine } from './log-merge'

const line = (service: string, timestamp: number, id: string): LogLine => ({ service, timestamp, message: `${service}-${id}`, id })

test('inserts in timestamp order across services', () => {
  let buf: LogLine[] = []
  buf = mergeLine(buf, line('api', 30, 'a'), 100)
  buf = mergeLine(buf, line('bff', 10, 'b'), 100)
  buf = mergeLine(buf, line('fe', 20, 'c'), 100)
  expect(buf.map((l) => l.id)).toEqual(['b', 'c', 'a'])
})

test('dedupes on service + id', () => {
  let buf: LogLine[] = []
  buf = mergeLine(buf, line('api', 10, 'a'), 100)
  buf = mergeLine(buf, line('api', 10, 'a'), 100)
  expect(buf).toHaveLength(1)
})

test('same id from different services is kept', () => {
  let buf: LogLine[] = []
  buf = mergeLine(buf, line('api', 10, 'x'), 100)
  buf = mergeLine(buf, line('bff', 10, 'x'), 100)
  expect(buf).toHaveLength(2)
})

test('caps to the most recent N lines', () => {
  let buf: LogLine[] = []
  buf = mergeLine(buf, line('api', 1, 'a'), 2)
  buf = mergeLine(buf, line('api', 2, 'b'), 2)
  buf = mergeLine(buf, line('api', 3, 'c'), 2)
  expect(buf.map((l) => l.id)).toEqual(['b', 'c'])
})
