import { expect, test } from 'vitest'
import { createOrdersWorkspaceRevalidator } from '../services/ordersWorkspaceRevalidation'

test('concurrent changes share one read and at most one trailing read using newest query', async () => {
  let query = 'first'
  const seen: string[] = []
  let release!: () => void
  const first = new Promise<void>((resolve) => { release = resolve })
  const loader = createOrdersWorkspaceRevalidator(async () => {
    seen.push(query)
    if (seen.length === 1) await first
  })
  const run = loader.request()
  await Promise.resolve()
  query = 'latest'
  for (let i = 0; i < 20; i += 1) expect(loader.request()).toBe(run)
  release()
  await run
  expect(seen).toEqual(['first', 'latest'])
})

test('same-turn notifications coalesce; a later independent commit can refresh again', async () => {
  let reads = 0
  const loader = createOrdersWorkspaceRevalidator(async () => { reads += 1 })
  await Promise.all(Array.from({ length: 20 }, () => loader.request()))
  expect(reads).toBe(1)
  await loader.request()
  expect(reads).toBe(2)
})

test('a commit while a completed read promise is settling is not lost', async () => {
  let reads = 0
  let trailing: Promise<void> | undefined
  const loader = createOrdersWorkspaceRevalidator(async () => {
    reads += 1
    if (reads === 1) queueMicrotask(() => queueMicrotask(() => { trailing = loader.request() }))
  })
  await loader.request()
  await trailing
  expect(reads).toBe(2)
})

test('a rejected DB read releases the scheduler for the next explicit read', async () => {
  let reads = 0
  const loader = createOrdersWorkspaceRevalidator(async () => { reads += 1; if (reads === 1) throw Error('synthetic DB error') })
  await expect(loader.request()).rejects.toThrow('synthetic DB error')
  await loader.request()
  expect(reads).toBe(2)
})
