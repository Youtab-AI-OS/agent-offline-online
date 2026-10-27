import { type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { InnoUpdateControllerDependencies } from './inno-update-controller'
import { type InnoUpdateTrustRoot, validateInnoUpdateTrustRoot } from './inno-update-release'
import { buildInnoUpdateTransactionScript } from './inno-update-transaction'
import { cancelUninstallHelper, type CommonWindowsUninstallPlan, waitForUninstallReady } from './windows-full-uninstall'
import { releaseWindowsMaintenanceHelper, spawnWindowsMaintenanceHelper } from './windows-maintenance-helper'
import type { SetupLease } from './setup-native-lease'

export interface InnoUpdateHandoffHost {
  trust: InnoUpdateTrustRoot
  installation: CommonWindowsUninstallPlan
  tempDirectory: string
  dataContractsSha256: string
  acquireRuntimeLease: (executable: string, sha256: string, size: number) => SetupLease
  reserve: () => () => void
  releaseBackend: () => Promise<{ unlocked: boolean }>
  emitProgress: (value: {stage: string; message: string; percent: null}) => void
  quit: () => void
  log: (message: string) => void
}

/** Only the native coordinator may acknowledge readiness or replace programs. */
export async function handoffInnoUpdate(
  input: Parameters<InnoUpdateControllerDependencies['handoff']>[0], host: InnoUpdateHandoffHost
) {
  const trust = validateInnoUpdateTrustRoot(host.trust)

  if (process.platform !== 'win32' || !/^[0-9a-f]{64}$/.test(host.dataContractsSha256))
    {return {ok: false, error: 'inno-update-host', message: 'The verified Windows update host is unavailable.'}}

  const reserved = host.reserve()
  let released = false

  const releaseReservation = () => { if (!released) {released = true; reserved()} }
  let child: ChildProcess | undefined
  let handoff: {directory: string; token: string} | undefined
  let retain = false

  try {
    const directory = fs.mkdtempSync(path.join(host.tempDirectory, 'youtab-inno-update-'))
    handoff = {directory, token: randomUUID()}

    const publicKeyBlob = Buffer.concat([Buffer.from('4543533120000000', 'hex'),
      Buffer.from(trust.publicKey.x, 'base64url'), Buffer.from(trust.publicKey.y, 'base64url')]).toString('base64')

    const script = buildInnoUpdateTransactionScript({
      installation: host.installation, handoff, installer: input.installer.filePath,
      envelope: Buffer.from(input.envelope).toString('base64'), publicKeyBlob, keyId: trust.keyId,
      payloadSha256: input.release.payloadSha256, dataContractsSha256: host.dataContractsSha256,
      expectedSequence: input.release.payload.sequence, expectedBuildId: input.release.payload.buildId
    })

    child = spawnWindowsMaintenanceHelper({ installRoot: host.installation.installRoot, handoffDirectory: directory, script,
      acquireLease: host.acquireRuntimeLease, removalRoots: [host.installation.userData] })
    child.once('exit', () => { if (retain) {releaseReservation()} })
    child.once('error', () => { if (retain) {releaseReservation()} })
    // Progress is bounded and informational. The token files, not stdout, own ACKs.
    let pending = ''
    child.stdout?.on('data', chunk => {
      pending = (pending + chunk.toString('utf8')).slice(-16384)
      const lines = pending.split(/\r?\n/); pending = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('YOUTAB_INNO_UPDATE:')) {continue}

        try {
          const value = JSON.parse(line.slice('YOUTAB_INNO_UPDATE:'.length))

          if (['prepare','handoff','update','restart','error'].includes(value.stage) && typeof value.message === 'string')
            {host.emitProgress({stage: value.stage, message: value.message.slice(0, 1024), percent: null})}
        } catch { /* Partial or diagnostic lines cannot acknowledge a handoff. */ }
      }
    })
    await waitForUninstallReady(child, handoff, 660000)
    await waitForUninstallReady(child, handoff, 45000, 'stopped')
    const backend = await host.releaseBackend()

    if (!backend.unlocked) {throw new Error('Runtime files are still in use. The update was cancelled before replacement.')}

    const assertLive = () => {
      if (child!.exitCode !== null || child!.signalCode !== null) {throw new Error('The native update helper exited before Desktop handoff.')}

      for (const name of ['ready','stopped'])
        {if (fs.readFileSync(path.join(directory, name), 'utf8') !== handoff!.token) {throw new Error('Native update acknowledgement changed.')}}

      if (fs.existsSync(path.join(directory, 'failure.log'))) {throw new Error('The native update helper reported a recovery failure.')}
    }

    assertLive()
    fs.writeFileSync(path.join(directory, 'proceed'), handoff.token, {flag:'wx', encoding:'utf8'})
    await waitForUninstallReady(child, handoff, 30000, 'armed')
    assertLive()
    await releaseWindowsMaintenanceHelper(child)
    assertLive()
    retain = true
    child.stdout?.destroy()
    child.unref()
    host.log('[updates] signed full Installer admitted; native transaction owns the installation lock')
    host.quit()

    return {ok: true, handedOff: true}
  } catch (error) {
    const restored = !child || !handoff || await cancelUninstallHelper(child, handoff, 15000)

    if (!restored && child) {
      retain = true

      if (child.exitCode !== null || child.signalCode !== null) {releaseReservation()}
    }

    const detail = error instanceof Error ? error.message : 'Update handoff failed.'
    host.emitProgress({stage: 'error', message: detail, percent: null})

    return {ok: false, error: 'inno-update-handoff', message: detail + (restored ? '' : ' Owned recovery is still finishing; retry after it exits.')}
  } finally {
    if (!retain) {releaseReservation()}
  }
}
