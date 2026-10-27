import { describe, expect, it } from 'vitest'

import { flushDesktopLogBatch, recoverDesktopLog } from './desktop-log-recovery'

describe('failed desktop log append', () => {
  it('restores a failed batch before the next queued batch takes newer records', async () => {
    let pending = 'A\n'
    let release!: () => void
    const writing = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const firstStarted = new Promise<void>(resolve => { started = resolve })
    const written: string[] = []
    const take = () => { const chunk = pending; pending = ''; return chunk }
    const restore = (chunk: string) => { pending = recoverDesktopLog(chunk, pending, 1024) }
    const first = flushDesktopLogBatch(take, async () => { started(); await writing; throw new Error('disk unavailable') }, restore)
    await firstStarted
    pending += 'B\n'
    const second = first.then(() => flushDesktopLogBatch(take, async chunk => { written.push(chunk) }, restore))
    pending += 'C\n'
    release()
    await second
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('A\nB\nC\n')
    expect(pending).toBe('')
  })
  it('retains failed and newly arriving diagnostics in order', () => {
    expect(recoverDesktopLog('first\n', 'second\n', 1024)).toContain('first\nsecond\n')
  })

  it('bounds repeated failures and marks truncation while retaining newest records', () => {
    let buffer = 'old'.repeat(1000)
    for (let attempt = 0; attempt < 10; attempt++) {
      buffer = recoverDesktopLog(buffer, `new-${attempt}\n`, 256)
      expect(buffer.length).toBeLessThanOrEqual(256)
    }
    expect(buffer).toContain('Previous log append failed')
    expect(buffer).toContain('new-9\n')
  })
})
