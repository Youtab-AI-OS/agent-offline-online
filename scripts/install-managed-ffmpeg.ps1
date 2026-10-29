# Online managed dependency for the common Windows installer. No global PATH
# changes and no media-selected path/URL. The committed Python module owns pins.
function Get-YoutabManagedCodecSpec {
    param([Parameter(Mandatory=$true)][string]$RuntimeRoot)
    $python = Join-Path $RuntimeRoot 'venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Managed codec setup requires the staged Runtime interpreter' }
    $code = @'
import importlib.util,json,sys
from pathlib import Path
root=Path(sys.argv[1]).resolve(strict=True)
spec=importlib.util.spec_from_file_location('youtab_codec_install',root/'plugins/platforms/whatsapp/managed_codec.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
print(json.dumps({'version':module.FFMPEG_VERSION,'url':module.FFMPEG_SOURCE_URL,'archive_sha256':module.FFMPEG_ARCHIVE_SHA256,'directory':module.MANAGED_FFMPEG_DIRECTORY,'files':{name:{'size':pin[0],'sha256':pin[1]} for name,pin in module.FFMPEG_FILES.items()}}))
'@
    $output = & $python -I -c $code $RuntimeRoot
    if ($LASTEXITCODE -ne 0) { throw 'Managed codec specification could not be read' }
    return ($output -join "`n" | ConvertFrom-Json)
}

function Receive-YoutabManagedCodecArchive {
    param([Parameter(Mandatory=$true)][string]$Url,[Parameter(Mandatory=$true)][string]$Destination,
          [ValidateRange(1,120000)][int]$DeadlineMs=120000)
    Add-Type -AssemblyName System.Net.Http
    if (-not ('YoutabManagedCodecStreamAbort' -as [type])) {
        Add-Type -TypeDefinition @'
public static class YoutabManagedCodecStreamAbort {
    public static System.Threading.CancellationTokenRegistration Bind(System.IO.Stream stream, System.Threading.CancellationToken token) {
        return token.Register(state => { try { ((System.IO.Stream)state).Dispose(); } catch { } }, stream);
    }
}
'@
    }
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $cancel = New-Object System.Threading.CancellationTokenSource($DeadlineMs)
    $response = $null; $stream = $null; $output = $null
    $abort = $null
    try {
        $response = $client.GetAsync([Uri]$Url,[System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancel.Token).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200) { throw 'Managed codec download failed or attempted a redirect' }
        if ($response.Content.Headers.ContentLength -gt 134217728) { throw 'Managed codec archive exceeds its byte limit' }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        # .NET Framework stream cancellation can be delayed during a pending
        # network read. Closing that exact owned stream enforces the deadline.
        $abort = [YoutabManagedCodecStreamAbort]::Bind($stream,$cancel.Token)
        $output = [IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $buffer = New-Object byte[] 1048576
        [long]$total = 0
        while (($count = $stream.ReadAsync($buffer,0,$buffer.Length,$cancel.Token).GetAwaiter().GetResult()) -gt 0) {
            $total += $count
            if ($total -gt 134217728) { throw 'Managed codec archive exceeds its byte limit' }
            $output.Write($buffer,0,$count)
        }
        $output.Flush($true)
    } finally {
        if ($abort) { $abort.Dispose() }; if ($output) { $output.Dispose() }; if ($stream) { $stream.Dispose() }
        if ($response) { $response.Dispose() }; $cancel.Dispose(); $client.Dispose(); $handler.Dispose()
    }
}

function Test-YoutabManagedCodecFiles {
    param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)]$Spec)
    foreach ($property in $Spec.files.PSObject.Properties) {
        $file = Join-Path $Directory $property.Name
        Assert-YoutabCodecDirectoryPath -RuntimeRoot $Directory -Directory (Split-Path -Parent $file)
        $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $property.Value.size) { throw 'Managed codec component layout does not match its specification' }
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $property.Value.sha256) { throw 'Managed codec component hash does not match its specification' }
    }
}

function Assert-YoutabCodecDirectoryPath {
    param([Parameter(Mandatory=$true)][string]$RuntimeRoot,[Parameter(Mandatory=$true)][string]$Directory)
    $root = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
    $current = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    if (-not ($current + '\').StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Managed codec path escapes the Runtime' }
    while (-not $current.Equals($root,[StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Managed codec directory contains a redirect or non-directory' }
        }
        $current = Split-Path -Parent $current
    }
}

function Install-YoutabManagedCodec {
    param([Parameter(Mandatory=$true)][string]$RuntimeRoot)
    $root = (Resolve-Path -LiteralPath $RuntimeRoot -ErrorAction Stop).Path
    $spec = Get-YoutabManagedCodecSpec -RuntimeRoot $root
    if ($spec.url -cne 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip' -or
        $spec.archive_sha256 -cne '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba' -or
        $spec.version -cne '9.0.2-essentials_build' -or $spec.directory -cne 'native/managed-dependencies/ffmpeg' -or
        @($spec.files.PSObject.Properties.Name).Count -ne 3 -or
        -not $spec.files.'bin/ffmpeg.exe' -or -not $spec.files.LICENSE -or -not $spec.files.'README.txt') { throw 'Managed codec specification is not the approved Windows input contract' }
    $destination = Join-Path $root $spec.directory
    Assert-YoutabCodecDirectoryPath -RuntimeRoot $root -Directory $destination
    if (Test-Path -LiteralPath $destination) {
        $resolved = (Resolve-Path -LiteralPath $destination).Path
        if (-not ($resolved + '\').StartsWith($root.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Managed codec directory escapes the Runtime' }
        Test-YoutabManagedCodecFiles -Directory $destination -Spec $spec
        return
    }
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Assert-YoutabCodecDirectoryPath -RuntimeRoot $root -Directory $parent
    $work = Join-Path $parent ('.ffmpeg-acquire-' + [Guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $work) { throw 'Managed codec work directory already exists' }
    New-Item -ItemType Directory -Path $work | Out-Null
    $ownedWork = Get-Item -LiteralPath $work -Force
    $ownedWorkCreation = $ownedWork.CreationTimeUtc.Ticks
    $archivePath = Join-Path $work 'producer.zip'
    $prepared = Join-Path $work 'prepared'
    New-Item -ItemType Directory -Path $prepared | Out-Null
    try {
        Receive-YoutabManagedCodecArchive -Url $spec.url -Destination $archivePath
        if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $spec.archive_sha256) { throw 'Managed codec archive integrity check failed' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            foreach ($property in $spec.files.PSObject.Properties) {
                $entryName = 'ffmpeg-9.0.2-essentials_build/' + $property.Name
                $entries = @($archive.Entries | Where-Object { $_.FullName -ceq $entryName })
                if ($entries.Count -ne 1 -or $entries[0].Length -ne $property.Value.size -or (($entries[0].ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Managed codec archive has an invalid required entry' }
                $target = Join-Path $prepared $property.Name
                New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
                $input = $entries[0].Open(); $output = $null
                try {
                    $output = [IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
                    $buffer = New-Object byte[] 1048576
                    [long]$total = 0
                    while (($count = $input.Read($buffer,0,$buffer.Length)) -gt 0) {
                        $total += $count
                        if ($total -gt $property.Value.size) { throw 'Managed codec entry exceeds its pinned size' }
                        $output.Write($buffer,0,$count)
                    }
                    if ($total -ne $property.Value.size) { throw 'Managed codec entry length is inconsistent' }
                    $output.Flush($true)
                } finally { if ($output) { $output.Dispose() }; $input.Dispose() }
            }
        } finally { $archive.Dispose() }
        Test-YoutabManagedCodecFiles -Directory $prepared -Spec $spec
        [IO.Directory]::Move($prepared,$destination)
    } finally {
        # Only the directory created by this invocation; never the destination,
        # caller caches or user files. Reject redirects before recursive cleanup.
        if (Test-Path -LiteralPath $work) {
            $item = Get-Item -LiteralPath $work -Force
            $resolved = [IO.Path]::GetFullPath($item.FullName)
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.CreationTimeUtc.Ticks -ne $ownedWorkCreation -or -not $resolved.StartsWith($parent.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Managed codec cleanup lost its owned directory' }
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
