from plugins.platforms.photon import sidecar_paths


def test_readonly_mirror_refreshes_log_helper_without_removing_dependencies(tmp_path, monkeypatch):
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'index.mjs').write_text('import "./log-framing.mjs";\n', encoding='utf-8')
    (source / 'log-framing.mjs').write_text('export const version = 1;\n', encoding='utf-8')
    home = tmp_path / 'home'
    monkeypatch.setenv('YOUTAB_AGENT_HOME', str(home))
    monkeypatch.delenv('PHOTON_SIDECAR_DIR', raising=False)
    monkeypatch.setattr(sidecar_paths, '_dir_writable', lambda _: False)
    mirror = sidecar_paths.resolve_sidecar_dir(source)
    assert (mirror / 'log-framing.mjs').read_bytes() == (source / 'log-framing.mjs').read_bytes()
    dependencies = mirror / 'node_modules'
    dependencies.mkdir()
    sentinel = dependencies / 'retained.txt'
    sentinel.write_text('installed', encoding='utf-8')
    (source / 'log-framing.mjs').write_text('export const version = 2;\n', encoding='utf-8')
    assert sidecar_paths.resolve_sidecar_dir(source) == mirror
    assert (mirror / 'log-framing.mjs').read_bytes() == (source / 'log-framing.mjs').read_bytes()
    assert sentinel.read_text(encoding='utf-8') == 'installed'
