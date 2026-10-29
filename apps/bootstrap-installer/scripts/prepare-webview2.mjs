import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { lstat, mkdir, rename, unlink } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

// Build-machine prerequisite for the Windows app-target EXE. This is never
// downloaded or requested from a customer during Youtab Setup.
if (process.platform === 'win32') {
  const source = 'https://go.microsoft.com/fwlink/?linkid=2124701'
  const sha256 = '1c401b327fbc7bb9731b4e350a2194f083cbc3ede46508d52e1cae6610a39bea'
  const size = 214884560
  const thumbprint = '4028CAD637509D4744B17EC5B42AED8D7A31E6AF'
  const deadline = AbortSignal.timeout(15 * 60 * 1000)
  const target = fileURLToPath(new URL('../src-tauri/assets/MicrosoftEdgeWebView2RuntimeInstallerX64.exe', import.meta.url))

  async function verify(file) {
    const metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== size) {
      throw new Error('Pinned WebView2 standalone is not a bounded regular file')
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    if (hash.digest('hex') !== sha256) throw new Error('Pinned WebView2 standalone hash mismatch')
    const command = '$s = Get-AuthenticodeSignature -LiteralPath $env:YOUTAB_WEBVIEW_FILE; if ($s.Status -eq "Valid" -and $s.SignerCertificate.Thumbprint -eq $env:YOUTAB_WEBVIEW_SIGNER -and $s.SignerCertificate.Subject -match "CN=Microsoft Corporation") { exit 0 }; exit 1'
    const environment = { ...process.env, YOUTAB_WEBVIEW_FILE: file, YOUTAB_WEBVIEW_SIGNER: thumbprint }
    // A PowerShell 7 parent can pass a module path incompatible with Windows PowerShell 5.
    delete environment.PSModulePath
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: environment,
      windowsHide: true, timeout: 30000, stdio: 'pipe'
    })
    if (result.error || result.status !== 0) throw new Error('Pinned WebView2 standalone Microsoft signature invalid')
  }

  async function download(url, file, redirects = 0) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || (!parsed.hostname.endsWith('.microsoft.com') && parsed.hostname !== 'go.microsoft.com')
      || parsed.port || parsed.username || parsed.password || redirects > 5) {
      throw new Error('WebView2 source left approved Microsoft HTTPS host')
    }
    const response = await new Promise((resolve, reject) => {
      const request = https.get(parsed, { timeout: 30000, signal: deadline }, resolve)
      request.on('timeout', () => request.destroy(new Error('WebView2 download timed out')))
      request.on('error', reject)
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const next = response.headers.location
      response.resume()
      if (!next) throw new Error('WebView2 redirect lacks location')
      return download(new URL(next, parsed).toString(), file, redirects + 1)
    }
    if (response.statusCode !== 200) {
      response.resume()
      throw new Error(`WebView2 download HTTP ${response.statusCode}`)
    }
    let bytes = 0
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length
      callback(bytes > size ? new Error('WebView2 download exceeds pinned size') : null, chunk)
    } })
    await pipeline(response, limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }))
    if (bytes !== size) throw new Error('WebView2 download is incomplete')
  }

  if (existsSync(target)) {
    await verify(target)
  } else {
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.download`
    try {
      await download(source, temporary)
      await verify(temporary)
      await rename(temporary, target)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
  console.log('Verified pinned Microsoft WebView2 standalone prerequisite for Youtab Setup')
}
