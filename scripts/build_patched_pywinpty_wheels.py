"""Build guarded prototype ABI wheels from exact official wheels; no installation."""
import argparse
import base64
import csv
import hashlib
import io
import json
from pathlib import Path
import zipfile

PINS = {
    'cp311': '9a6bcec2df2707aaa9d08b86071970ee32c5026e10bcc3cc5f6f391d85baf7ca',
    'cp312': '83a8f20b430bbc5d8957249f875341a60219a4e971580f2ba694fbfb54a45ebc',
    'cp313': 'ab5920877dd632c124b4ed17bc6dd6ef3b9f86cd492b963ffdb1a67b85b0f408',
}
PATCH_SHA = '85607b6521367483b5975b281246be3afa168c9b94c8686d20bdeaf6be44a79d'
ORIGINAL_SOURCE_SHA = '388ad6ce2a59679cd94aa73b93ffe67a0099f725a47a94b300fd380eed06d87e'
LICENSE_SHA = 'f878d4767f9ad2e43d3083efa00201b000ce937d9ee8626e00ba5c72aac951e2'

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def build(input_dir: Path, abi: str, patch: bytes) -> tuple[bytes, str]:
    original = input_dir / f'pywinpty-2.0.15-{abi}-{abi}-win_amd64.whl'
    data = original.read_bytes()
    if sha(data) != PINS[abi]:
        raise ValueError(f'{abi}: official wheel checksum mismatch')
    old_info = 'pywinpty-2.0.15.dist-info'
    new_info = 'pywinpty-2.0.15+youtab.1.dist-info'
    items = {}
    with zipfile.ZipFile(io.BytesIO(data)) as source:
        if sha(source.read('winpty/ptyprocess.py')) != ORIGINAL_SOURCE_SHA:
            raise ValueError(f'{abi}: unexpected upstream source')
        license_name = next(n for n in source.namelist() if n.endswith('/LICENSE.txt'))
        if sha(source.read(license_name)) != LICENSE_SHA:
            raise ValueError(f'{abi}: license checksum mismatch')
        native_name = f'winpty/winpty.{abi}-win_amd64.pyd'
        native_sha = sha(source.read(native_name))
        for entry in source.namelist():
            if entry.endswith('/') or entry.endswith('/RECORD'):
                continue
            content = source.read(entry)
            if entry == 'winpty/ptyprocess.py':
                content = patch
            elif entry == old_info + '/METADATA':
                content = content.replace(b'Version: 2.0.15\n', b'Version: 2.0.15+youtab.1\n').replace(b'Version: 2.0.15\r\n', b'Version: 2.0.15+youtab.1\r\n')
                if b'Version: 2.0.15+youtab.1' not in content:
                    raise ValueError('Local version substitution failed')
            items[entry.replace(old_info, new_info)] = content
    record = io.StringIO()
    writer = csv.writer(record, lineterminator='\n')
    for entry, content in sorted(items.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b'=').decode()
        writer.writerow([entry, 'sha256=' + digest, len(content)])
    writer.writerow([new_info + '/RECORD', '', ''])
    items[new_info + '/RECORD'] = record.getvalue().encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        for entry, content in sorted(items.items()):
            info = zipfile.ZipInfo(entry, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            output.writestr(info, content, compresslevel=9)
    result = buffer.getvalue()
    with zipfile.ZipFile(io.BytesIO(result)) as output:
        if sha(output.read(native_name)) != native_sha:
            raise ValueError('Native component changed')
    return result, native_sha

def patched_source(original: bytes) -> bytes:
    """Apply the single pinned SDK correction, retaining upstream CRLF bytes."""
    if sha(original) != ORIGINAL_SOURCE_SHA:
        raise ValueError('Unexpected upstream Python source')
    old = ("            # Handle end of file.\r\n"
           "            if pty.iseof():\r\n"
           "                try:\r\n"
           "                    client.send(b'')\r\n"
           "                except socket.error:\r\n"
           "                    pass\r\n"
           "                finally:\r\n"
           "                    break\r\n").encode()
    new = ("            # Native iseof describes the pipe/process, not the unread native\r\n"
           "            # read cache. Drain it until pty.read actually reports EOF.\r\n").encode()
    if original.count(old) != 1:
        raise ValueError('SDK patch anchor is not unique')
    result = original.replace(old, new, 1)
    if sha(result) != PATCH_SHA:
        raise ValueError('Patched source checksum mismatch')
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', type=Path, required=True,
                        help='Directory containing the three exact official wheels')
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--patch-file', type=Path, required=True)
    parser.add_argument('--license-file', type=Path, required=True)
    args = parser.parse_args()
    if sha(args.patch_file.read_bytes()) != '290e216c2c4bac48d2e94fa31711bbe448066403854e585193261d838fc38589':
        raise ValueError('SDK patch provenance checksum mismatch')
    if sha(args.license_file.read_bytes()) != LICENSE_SHA:
        raise ValueError('Upstream license checksum mismatch')
    first = args.input_dir / 'pywinpty-2.0.15-cp311-cp311-win_amd64.whl'
    first_data = first.read_bytes()
    if sha(first_data) != PINS['cp311']:
        raise ValueError('cp311: official wheel checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(first_data)) as source:
        patch = patched_source(source.read('winpty/ptyprocess.py'))
    # Verify every input and generated native identity before any output writes.
    built = {abi: build(args.input_dir, abi, patch) for abi in PINS}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for abi, (data, native_sha) in built.items():
        path = args.output_dir / f'pywinpty-2.0.15+youtab.1-{abi}-{abi}-win_amd64.whl'
        path.write_bytes(data)
        rows.append({'abi': abi, 'path': str(path), 'official_sha256': PINS[abi],
                     'wheel_sha256': sha(data), 'patched_source_sha256': PATCH_SHA,
                     'native_sha256': native_sha, 'license_sha256': LICENSE_SHA})
    (args.output_dir / 'verified-wheel-manifest.json').write_text(json.dumps(rows, indent=2))
    print(json.dumps(rows))


if __name__ == '__main__':
    main()
