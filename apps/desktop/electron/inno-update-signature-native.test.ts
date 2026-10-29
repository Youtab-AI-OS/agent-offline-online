import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  INNO_UPDATE_FEED,
  type InnoUpdateTrustRoot,
  validateInnoUpdateTrustRoot,
  verifyInnoReleaseEnvelope
} from './inno-update-release'

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const header = Buffer.from('4543533120000000', 'hex')
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const now = 2_000_000_000_000

const payload = Buffer.from(JSON.stringify({
  product: 'io.youtab.agent', format: 'inno-full/v1', platform: 'windows', arch: 'x64',
  sequence: 11, buildId: 'b'.repeat(64), sourceSha: 'c'.repeat(40), version: '0.19.2-native-fixture',
  channel: 'pilot', createdAt: now - 1000, expiresAt: now + 60_000, dataSchema: 1,
  installer: { fileName: 'Youtab-Setup.exe', sha256: 'd'.repeat(64), size: 12345 },
  payloadManifestSha256: 'e'.repeat(64)
}), 'utf8')

function trustFromBlob(blob: Buffer): InnoUpdateTrustRoot {
  expect(blob.length).toBe(72)
  expect(blob.subarray(0, 8)).toEqual(header)

  return {
    protocol: 1, keyId: sha256(blob),
    publicKey: { kty: 'EC', crv: 'P-256', x: blob.subarray(8, 40).toString('base64url'), y: blob.subarray(40, 72).toString('base64url') },
    feedBaseUrl: INNO_UPDATE_FEED, sequence: 10, buildId: 'a'.repeat(64)
  }
}

function envelope(keyId: string, bytes: Buffer, signature: Buffer) {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, keyId, payload: bytes.toString('base64url'), signature: signature.toString('base64url') }))
}

interface NativeResult {
  sentinel: 'CNG_NODE_INTEROP_OK'
  isEphemeral: boolean
  publicBlob: string
  keyId: string
  signature: string
  nodeVerified: boolean
  changedPayloadDenied: boolean
  changedSignatureDenied: boolean
}

/** Sends only public bytes, a synthetic payload and signature to PS5; neither private key leaves memory. */
function nativeSignAndVerify(nodePublicBlob: Buffer, nodeSignature: Buffer): NativeResult {
  const request = Buffer.from(JSON.stringify({
    payload: payload.toString('base64'), publicBlob: nodePublicBlob.toString('base64'), signature: nodeSignature.toString('base64')
  })).toString('base64')

  const source = String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
if($PSVersionTable.PSVersion.Major -ne 5){throw 'This fixture requires the production Windows PowerShell 5 runtime.'}
$request=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${request}')))|ConvertFrom-Json
$payload=[Convert]::FromBase64String($request.payload)
$nodeBlob=[Convert]::FromBase64String($request.publicBlob)
$nodeSignature=[Convert]::FromBase64String($request.signature)
if($nodeBlob.Length -ne 72 -or [BitConverter]::ToUInt32($nodeBlob,0) -ne 0x31534345 -or [BitConverter]::ToUInt32($nodeBlob,4) -ne 32){throw 'Not an ECS1 P256 public root.'}
$nodeKey=[Security.Cryptography.CngKey]::Import($nodeBlob,[Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
$nodeVerifier=New-Object Security.Cryptography.ECDsaCng($nodeKey)
try {
  $nodeVerifier.HashAlgorithm=[Security.Cryptography.CngAlgorithm]::Sha256
  $valid=$nodeVerifier.VerifyData($payload,$nodeSignature)
  [byte[]]$changedPayload=$payload.Clone();$changedPayload[0]=$changedPayload[0] -bxor 1
  [byte[]]$changedSignature=$nodeSignature.Clone();$changedSignature[31]=$changedSignature[31] -bxor 1
  $changedPayloadDenied=-not $nodeVerifier.VerifyData($changedPayload,$nodeSignature)
  $changedSignatureDenied=-not $nodeVerifier.VerifyData($payload,$changedSignature)
  if(-not $valid -or -not $changedPayloadDenied -or -not $changedSignatureDenied){throw 'CNG accepted altered data or rejected valid Node P1363 signature.'}
} finally {$nodeVerifier.Dispose();$nodeKey.Dispose()}
$key=[Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::ECDsaP256)
try {
  if(-not $key.IsEphemeral){throw 'The fixture must never create a persisted publisher key.'}
  $publicBlob=$key.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
  $signer=New-Object Security.Cryptography.ECDsaCng($key)
  try {$signer.HashAlgorithm=[Security.Cryptography.CngAlgorithm]::Sha256;$signature=$signer.SignData($payload)} finally {$signer.Dispose()}
  if($signature.Length -ne 64){throw 'CNG did not return the 64-byte P1363 signature contract.'}
  $hash=[Security.Cryptography.SHA256]::Create()
  try {$keyId=([BitConverter]::ToString($hash.ComputeHash($publicBlob))).Replace('-','').ToLowerInvariant()} finally {$hash.Dispose()}
  [pscustomobject]@{sentinel='CNG_NODE_INTEROP_OK';isEphemeral=$key.IsEphemeral;publicBlob=[Convert]::ToBase64String($publicBlob);keyId=$keyId;signature=[Convert]::ToBase64String($signature);nodeVerified=$valid;changedPayloadDenied=$changedPayloadDenied;changedSignatureDenied=$changedSignatureDenied}|ConvertTo-Json -Compress
} finally {$key.Dispose()}
`

  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    input: `& {\ntry {\n${source}\n} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }\n}\n\n`,
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024
  })

  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(0)
  const decoded = JSON.parse(result.stdout.trim()) as NativeResult
  expect(decoded.sentinel).toBe('CNG_NODE_INTEROP_OK')

  return decoded
}

describe.runIf(process.platform === 'win32')('Windows PS5 CNG / Node update signature interoperability (ephemeral keys only)', () => {
  it('verifies both signing directions and production envelope admission, denying payload/signature/root substitutions', () => {
    // Node private key is held only in this process; only the JWK public coordinates cross into PS.
    const nodePair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const nodePublic = nodePair.publicKey.export({ format: 'jwk' })
    const nodeBlob = Buffer.concat([header, Buffer.from(nodePublic.x!, 'base64url'), Buffer.from(nodePublic.y!, 'base64url')])
    const nodeTrust = trustFromBlob(nodeBlob)
    expect(validateInnoUpdateTrustRoot(nodeTrust)).toBe(nodeTrust)
    const nodeSignature = sign('sha256', payload, { key: nodePair.privateKey, dsaEncoding: 'ieee-p1363' })
    expect(nodeSignature.length).toBe(64)
    const native = nativeSignAndVerify(nodeBlob, nodeSignature)
    expect(native.isEphemeral).toBe(true)
    expect(native.nodeVerified).toBe(true)
    expect(native.changedPayloadDenied).toBe(true)
    expect(native.changedSignatureDenied).toBe(true)

    const cngBlob = Buffer.from(native.publicBlob, 'base64')
    const cngTrust = trustFromBlob(cngBlob)
    expect(native.keyId).toBe(cngTrust.keyId)
    expect(validateInnoUpdateTrustRoot(cngTrust)).toBe(cngTrust)
    const cngPublic = createPublicKey({ key: cngTrust.publicKey, format: 'jwk' })
    const cngSignature = Buffer.from(native.signature, 'base64')
    expect(cngSignature.length).toBe(64)
    expect(verify('sha256', payload, { key: cngPublic, dsaEncoding: 'ieee-p1363' }, cngSignature)).toBe(true)
    expect(verifyInnoReleaseEnvelope(envelope(cngTrust.keyId, payload, cngSignature), cngTrust, { channel: 'pilot', now }).payload.buildId).toBe('b'.repeat(64))
    expect(verifyInnoReleaseEnvelope(envelope(nodeTrust.keyId, payload, nodeSignature), nodeTrust, { channel: 'pilot', now }).payload.sequence).toBe(11)

    const changedPayload = Buffer.from(payload); changedPayload[0] ^= 1
    const changedSignature = Buffer.from(cngSignature); changedSignature[31] ^= 1
    expect(verify('sha256', changedPayload, { key: cngPublic, dsaEncoding: 'ieee-p1363' }, cngSignature)).toBe(false)
    expect(verify('sha256', payload, { key: cngPublic, dsaEncoding: 'ieee-p1363' }, changedSignature)).toBe(false)
    expect(() => verifyInnoReleaseEnvelope(envelope(cngTrust.keyId, changedPayload, cngSignature), cngTrust, { channel: 'pilot', now })).toThrow('inno-update:signature')
    expect(() => verifyInnoReleaseEnvelope(envelope(cngTrust.keyId, payload, changedSignature), cngTrust, { channel: 'pilot', now })).toThrow('inno-update:signature')
    expect(() => verifyInnoReleaseEnvelope(envelope(nodeTrust.keyId, payload, cngSignature), nodeTrust, { channel: 'pilot', now })).toThrow('inno-update:signature')
    expect(() => validateInnoUpdateTrustRoot({ ...cngTrust, keyId: nodeTrust.keyId })).toThrow('inno-update:trust-key-id')
  }, 35_000)
})
