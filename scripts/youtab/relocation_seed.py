"""Fresh-target, journal-bound default seeding for common Setup relocation."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

SOUL = "You are Youtab Agent Runtime, an intelligent AI assistant created by Youtab B.V.. You are helpful, knowledgeable, and direct. You assist users with a wide range of tasks including answering questions, writing and editing code, analyzing information, creative work, and executing actions via your tools. You communicate clearly, admit uncertainty when appropriate, and prioritize being genuinely useful over being verbose unless otherwise directed below. Be targeted and efficient in your exploration and investigations."
SKELETON = ('cron', 'sessions', 'logs', 'pairing', 'hooks', 'image_cache', 'audio_cache', 'memories', 'skills')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    info = path.lstat()
    if path.is_symlink() or getattr(info, 'st_file_attributes', 0) & 1024:
        raise RuntimeError('Seeding link refused')
    if not stat.S_ISDIR(info.st_mode) and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
        raise RuntimeError('Seeding nonregular entry refused')
    return info


def relative(value):
    path = Path(value)
    if not value or path.is_absolute() or ':' in value or '..' in path.parts or '.' in path.parts:
        raise RuntimeError('Invalid seed relative path')
    return path


def inspect(root, rel):
    regular(root)
    path = root
    for part in relative(str(rel)).parts:
        path = path / part
        if path.exists() or path.is_symlink():
            regular(path)
    return path


def stage_name(rel):
    return '.relocation-seed-' + digest(str(rel).encode('utf-8')) + '.part'


def packaged_bytes(runtime, rel):
    path = inspect(runtime, relative(rel))
    if not stat.S_ISREG(regular(path).st_mode):
        raise RuntimeError('Packaged seed is not a regular file')
    return path.read_bytes()


def plan(runtime, home):
    # -I -S excludes inherited/user/site startup code. Only the fresh target
    # package and its fresh dependencies are explicit import roots.
    sys.path[:0] = [str(runtime), str(runtime / 'venv/Lib/site-packages')]
    os.environ['YOUTAB_AGENT_HOME'] = str(home)
    os.environ['YOUTAB_AGENT_BUNDLED_SKILLS'] = str(runtime / 'skills')
    import youtab_constants
    youtab_constants.set_youtab_home_override(home)
    spec = importlib.util.spec_from_file_location('relocation_skills_sync', runtime / 'tools/skills_sync.py')
    sync = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sync)
    entries, files = {}, {}

    def directory(rel):
        rel = relative(str(rel))
        if inspect(home, rel).exists():
            if not inspect(home, rel).is_dir():
                raise RuntimeError('Seed directory collision')
            return
        if rel.parent != Path('.'):
            directory(rel.parent)
        entries[str(rel)] = dict(relative=str(rel), directory=True, source_hash=None, sqlite=False, copied_hash=None)

    def file(rel, data, source=None):
        rel = relative(str(rel))
        if rel.parent != Path('.'):
            directory(rel.parent)
        entries[str(rel)] = dict(relative=str(rel), directory=False, source_hash=digest(data), sqlite=False, copied_hash=None)
        files[str(rel)] = dict(source=source, content=None if source else data.decode('utf-8'))

    for name in SKELETON:
        directory(name)
    for name, template in (('.env', '.env.example'), ('config.yaml', 'cli-config.yaml.example')):
        if not inspect(home, Path(name)).exists():
            if inspect(runtime, Path(template)).exists():
                file(name, packaged_bytes(runtime, template), template)
            elif name == '.env':
                file(name, b'')
    if not inspect(home, Path('SOUL.md')).exists():
        file('SOUL.md', SOUL.encode('utf-8'))
    if not inspect(home, Path(sync.NO_BUNDLED_SKILLS_MARKER)).exists():
        bundled = runtime / 'skills'
        manifest = sync._read_manifest()
        suppressed = sync._read_suppressed_names()
        active = sync._index_active_skills()
        external = sync._build_external_skill_index()
        for name, source in sync._discover_bundled_skills(bundled) if bundled.exists() else []:
            dest = sync._compute_relative_dest(source, bundled)
            if (dest.exists() or dest.with_suffix('.bak').exists() or name in manifest or
                    name in active or name in suppressed or name in external):
                continue
            for parent, dirs, names in os.walk(source, followlinks=False):
                for child in dirs + names:
                    path = Path(parent) / child
                    info = regular(path)
                    rel = dest.relative_to(home) / path.relative_to(source)
                    if stat.S_ISDIR(info.st_mode):
                        directory(rel)
                    else:
                        file(rel, path.read_bytes(), str(path.relative_to(runtime)))
            directory(dest.relative_to(home))
            manifest[name] = sync._dir_hash(source)
        # Keep the existing manifest bytes unless actual defaults are added.
        if any(e['relative'].replace('\\', '/').startswith('skills/') and not e['directory'] for e in entries.values()):
            data = ('\n'.join(f'{name}:{value}' for name, value in sorted(manifest.items())) + '\n').encode('utf-8')
            file('skills/.bundled_manifest', data)
    return dict(entries=sorted(entries.values(), key=lambda e: e['relative']), files=files)


def apply(runtime, home, journal):
    packet = json.loads(journal.read_text(encoding='utf-8'))
    if (packet['schema'] != 1 or Path(packet['target']).resolve() != home or
            packet['phase'] != 'data-ready' or not packet.get('seed_intent')):
        raise RuntimeError('Durable seed intent required')
    intent = packet['seed_intent']
    original = {e['relative']: e for e in packet['entries']}
    prepared = []
    # Validate all package bytes and copied user files before the first write.
    for entry in intent['entries']:
        rel = relative(entry['relative'])
        target = inspect(home, rel)
        if entry['directory']:
            if target.exists() and not target.is_dir():
                raise RuntimeError('Seed directory changed')
            continue
        item = intent['files'][entry['relative']]
        data = packaged_bytes(runtime, item['source']) if item['source'] else item['content'].encode('utf-8')
        if digest(data) != entry['source_hash']:
            raise RuntimeError('Packaged seed changed after intent')
        before = original.get(entry['relative'])
        if target.exists():
            actual = digest(target.read_bytes())
            expected_old = before.get('copied_hash') if before else None
            if actual not in {entry['source_hash'], expected_old}:
                raise RuntimeError('Seed target collision; retained for review')
        stage = inspect(home, Path(stage_name(rel)))
        if any(name.casefold() == stage.name.casefold() for name in original):
            raise RuntimeError('Seed stage collides with copied user state')
        if stage.exists() and not data.startswith(stage.read_bytes()):
            raise RuntimeError('Seed staging collision; retained for review')
        prepared.append((target, stage, data))
    for entry in packet['entries']:
        if not entry['directory'] and entry.get('copied_hash'):
            target = inspect(home, relative(entry['relative']))
            allowed = {entry['copied_hash']}
            if entry['relative'] in intent['files']:
                allowed.add(next(e['source_hash'] for e in intent['entries'] if e['relative'] == entry['relative']))
            if digest(target.read_bytes()) not in allowed:
                raise RuntimeError('Copied user bytes changed')
    for entry in sorted(intent['entries'], key=lambda e: len(relative(e['relative']).parts)):
        if entry['directory']:
            inspect(home, relative(entry['relative'])).mkdir(exist_ok=True)
    for target, stage, data in prepared:
        if target.exists() and target.read_bytes() == data:
            if stage.exists():
                stage.unlink()
            continue
        # A partial stage is owned by this durable intent and prefix-validated.
        with stage.open('wb' if stage.exists() else 'xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(stage, target)


if __name__ == '__main__':
    action, root_arg, home_arg = sys.argv[1:4]
    runtime, home = Path(root_arg).resolve(), Path(home_arg).resolve()
    if runtime != home / 'youtab-agent-runtime':
        raise RuntimeError('Fresh target runtime required')
    regular(home); regular(runtime)
    if action == 'plan':
        print(json.dumps(plan(runtime, home), sort_keys=True))
    elif action == 'apply':
        journal = home / '.youtab-home-relocation-v1.json'
        regular(journal)
        apply(runtime, home, journal)
    else:
        raise RuntimeError('Fixed seed action required')
