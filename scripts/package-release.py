#!/usr/bin/env python3
"""Build reproducible, allowlisted extension and companion-server ZIPs."""
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parent.parent
manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
version = manifest['version']
assert re.fullmatch(r'\d+\.\d+\.\d+', version), 'Invalid release version'
assert manifest['manifest_version'] == 3
assert json.loads((ROOT / 'package.json').read_text())['version'] == version
lock = json.loads((ROOT / 'package-lock.json').read_text())
assert lock['version'] == lock['packages']['']['version'] == version
EXT = ['manifest.json', 'background.js', 'api.js', 'extract.js', 'capture.js', 'picker.js', 'popup.js', 'popup.html']
EXT += [f'icons/icon-{size}.png' for size in [16, 32, 48, 128]]
for ref in [manifest['background']['service_worker'], manifest['action']['default_popup'], *manifest['icons'].values(), *manifest['action']['default_icon'].values()]:
    assert ref in EXT, f'Missing manifest resource: {ref}'
for name in EXT:
    source = ROOT / 'extension' / name
    assert source.is_file() and not source.is_symlink(), f'Invalid file: {source}'
    if name.endswith(('.js', '.html')):
        for ref in re.findall(r'''(?:from\s+|src=)["']([^"']+)["']''', source.read_text()):
            assert ref.removeprefix('./') in EXT, f'Unpackaged dependency: {ref}'
SERVER = ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'SECURITY.md', 'server.js', 'runner.js',
          'auth.js', 'browser-session.js', 'export-cookies.js', 'store.js', 'capture.js', 'mcp.js', 'dashboard.html',
          'scripts/package-release.py', 'scripts/package-release.js', 'distribution/INSTALL.md',
          'distribution/PRIVACY.md', 'distribution/PUBLISHING.md']
SERVER += ['tests/' + name for name in ['fixture.html', 'adversarial.test.js', 'capture.test.js', 'picker.test.js',
           'scraper.test.js', 'session.test.js', 'session-api.test.js', 'workflow-popup.test.js',
           'export-cookies.test.js', 'session-setup-close.test.js']]
SERVER += ['extension/' + name for name in EXT]
OUT = ROOT / 'dist'
OUT.mkdir(exist_ok=True)

def build(name, entries):
    target = OUT / name
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for dest, src in sorted(entries.items()):
            path = ROOT / src
            assert path.is_file() and not path.is_symlink(), f'Invalid release file: {src}'
            info = zipfile.ZipInfo(dest, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    with zipfile.ZipFile(target) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(entries)
    print(f'{target.name}: {len(entries)} files, {target.stat().st_size} bytes')
    return f'{hashlib.sha256(target.read_bytes()).hexdigest()}  {target.name}\n'

ext = {name: 'extension/' + name for name in EXT}
ext['PRIVACY.md'] = 'distribution/PRIVACY.md'
ext['SECURITY.md'] = 'SECURITY.md'
ext['LICENSE'] = 'LICENSE'
checksums = build(f'pocket-scraper-extension-{version}.zip', ext)
checksums += build(f'pocket-scraper-server-{version}.zip', {name: name for name in SERVER})
(OUT / 'SHA256SUMS.txt').write_text(checksums)
for name in ['INSTALL.md', 'PRIVACY.md', 'PUBLISHING.md']:
    (OUT / name).write_bytes((ROOT / 'distribution' / name).read_bytes())
