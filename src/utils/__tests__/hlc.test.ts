import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The HLC module has module-level mutable state (_wallMs, _seq).
// We use vi.resetModules() in beforeEach so each test gets a clean slate.

describe('hlc', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── generateHLC ────────────────────────────────────────────────────────────

  describe('generateHLC', () => {
    it('produces monotonically increasing values on repeated calls', async () => {
      vi.setSystemTime(1_000_000_000_000)
      const { generateHLC } = await import('@/utils/hlc')
      const timestamps = Array.from({ length: 5 }, () => generateHLC())
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i] > timestamps[i - 1]).toBe(true)
      }
    })

    it('increments sequence counter within the same millisecond', async () => {
      vi.setSystemTime(1_000_000_000_000)
      const { generateHLC } = await import('@/utils/hlc')
      const first  = generateHLC()
      const second = generateHLC()
      const [wallA, seqA] = first.split('-')
      const [wallB, seqB] = second.split('-')
      expect(wallA).toBe(wallB)
      expect(Number(seqB)).toBe(Number(seqA) + 1)
    })

    it('resets sequence to 0 when wall clock advances', async () => {
      vi.setSystemTime(1_000_000_000_000)
      const { generateHLC } = await import('@/utils/hlc')
      generateHLC() // seq=0
      generateHLC() // seq=1
      vi.advanceTimersByTime(1) // advance wall clock by 1 ms
      const third = generateHLC()
      const [, seq] = third.split('-')
      expect(Number(seq)).toBe(0)
    })

    it('format is {wallMs}-{6-digit-seq}', async () => {
      vi.setSystemTime(1_000_000_000_000)
      const { generateHLC } = await import('@/utils/hlc')
      const ts = generateHLC()
      expect(ts).toMatch(/^\d{13}-\d{6}$/)
    })
  })

  // ── compareHLC ─────────────────────────────────────────────────────────────

  describe('compareHLC', () => {
    it('returns negative when a < b', async () => {
      vi.setSystemTime(1_000_000_000_000)
      const { generateHLC, compareHLC } = await import('@/utils/hlc')
      const a = generateHLC()
      const b = generateHLC()
      expect(compareHLC(a, b)).toBeLessThan(0)
    })

    it('returns positive when a > b', async () => {
      vi.setSystemTime(1_000_000_000_000)
      const { generateHLC, compareHLC } = await import('@/utils/hlc')
      const a = generateHLC()
      const b = generateHLC()
      expect(compareHLC(b, a)).toBeGreaterThan(0)
    })

    it('returns 0 for identical timestamps', async () => {
      vi.setSystemTime(1_000_000_000_000)
      const { generateHLC, compareHLC } = await import('@/utils/hlc')
      const a = generateHLC()
      expect(compareHLC(a, a)).toBe(0)
    })

    it('orders by wall time before sequence', async () => {
      const { compareHLC } = await import('@/utils/hlc')
      // earlier wall time with huge seq should still be < later wall time with seq=0
      const earlier = '1000000000000-999999'
      const later   = '1000000000001-000000'
      expect(compareHLC(earlier, later)).toBeLessThan(0)
      expect(compareHLC(later, earlier)).toBeGreaterThan(0)
    })
  })

  // ── advanceHLC ─────────────────────────────────────────────────────────────

  describe('advanceHLC', () => {
    it('advances past a remote HLC that is strictly ahead of local', async () => {
      vi.setSystemTime(1_000_000_000_000)
      const { generateHLC, advanceHLC, compareHLC } = await import('@/utils/hlc')
      const local = generateHLC()
      // remote is 5 seconds in the future, seq=0
      const remoteFuture = `${1_000_000_005_000}-000000`
      const advanced = advanceHLC(remoteFuture)
      expect(compareHLC(advanced, local)).toBeGreaterThan(0)
      // advanced should also be > remoteFuture because seq is bumped (+1)
      expect(compareHLC(advanced, remoteFuture)).toBeGreaterThan(0)
    })

    it('breaks ties by incrementing seq above the remote seq', async () => {
      vi.setSystemTime(1_000_000_000_000)
      const { generateHLC, advanceHLC } = await import('@/utils/hlc')
      generateHLC() // local at 1T, seq=0
      // remote at same wall time, seq=5
      const remoteAtSameWall = `${1_000_000_000_000}-000005`
      const advanced = advanceHLC(remoteAtSameWall)
      const [, seq] = advanced.split('-')
      expect(Number(seq)).toBeGreaterThan(5)
    })

    it('returns a value strictly greater than the input it advanced from', async () => {
      vi.setSystemTime(1_000_000_000_000)
      const { generateHLC, advanceHLC } = await import('@/utils/hlc')
      const ts = generateHLC()
      const advanced = advanceHLC(ts)
      expect(advanced > ts).toBe(true)
    })
  })
})
