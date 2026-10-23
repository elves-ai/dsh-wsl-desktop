"""First-run discovery and explicit deployment. Sources arrive over bounded stdin.

No shell, package installation, build, manager import, service start or signal.
Only 'install' writes, and exclusively under this user's desktop-owned namespace.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import sys
import tempfile

VERSION = '1.0.0'
MAX_INPUT = 256 * 1024
NODE_IDENTITY = "process.stdout.write(JSON.stringify({platform:process.platform,execPath:process.execPath}))"


class SetupError(Exception):
    pass


def account():
    user = pwd.getpwuid(os.geteuid())
    home = Path(user.pw_dir).resolve(strict=True)
    if not home.is_dir() or home.stat().st_uid != os.geteuid():
        raise SetupError('user')
    return user.pw_name, home


def discover_node(home):
    # Do not source user shell rc files or nvm.sh. The chosen executable will be
    # validated against the project's engines.node before any file is created.
    candidates = []
    versions = home / '.nvm/versions/node'
    try:
        entries = []
        for index, path in enumerate(versions.iterdir()):
            if index >= 128:
                break
            match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)', path.name)
            if match:
                entries.append((tuple(map(int, match.groups())), path / 'bin/node'))
        candidates.extend(path for _, path in sorted(entries, reverse=True))
    except OSError:
        pass
    found = shutil.which('node', path='/usr/local/bin:/usr/bin:/bin')
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.resolve())
    return ''


def identity():
    user, home = account()
    return {'linux_user': user, 'home': str(home), 'node': discover_node(home)}


def checker(source):
    namespace = {'__name__': '_dsh_setup_checks'}
    exec(compile(source, '<bundled-environment-checks>', 'exec'), namespace)
    return namespace


def ensure_directory(home, relative):
    current = home
    for part in relative.parts:
        if part in ('', '.', '..'):
            raise SetupError('storage')
        current = current / part
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            pass
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
            raise SetupError('storage')
        # Parent directories (.local/share) can be public; none may be writable
        # by another user. Never follow a symlink in the deployment namespace.
        if info.st_mode & 0o022:
            raise SetupError('storage')
    return current


def read_owned(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_size > MAX_INPUT):
            raise SetupError('conflict')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read(MAX_INPUT + 1)
    finally:
        os.close(fd)


def recover_publication(path):
    # A crash between link() and unlink() can leave a second name for these
    # verified bytes. Remove only installer temp names of THIS exact inode.
    info = path.lstat()
    if info.st_nlink > 1:
        for temporary in path.parent.glob('.setup-*'):
            other = temporary.lstat()
            if (stat.S_ISREG(other.st_mode) and other.st_uid == os.geteuid()
                    and (other.st_dev, other.st_ino) == (info.st_dev, info.st_ino)):
                temporary.unlink()
        if path.lstat().st_nlink != 1:
            raise SetupError('conflict')


def publish_new(path, content):
    """Publish complete bytes without ever truncating/replacing an existing file."""
    try:
        if read_owned(path) != content:
            raise SetupError('conflict')
        recover_publication(path)
        return
    except FileNotFoundError:
        pass
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix='.setup-', dir=path.parent)
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            if read_owned(path) != content:
                raise SetupError('conflict')
    finally:
        if temporary is not None:
            os.unlink(temporary)


def pidfd_available():
    # Check the actual kernel, not only Python's version. This is read-only and
    # never signals even our own process. The manager refuses unsafe PID fallback.
    if not hasattr(signal, 'pidfd_send_signal'):
        return False
    try:
        descriptor = os.pidfd_open(os.getpid(), 0)
        os.close(descriptor)
        return True
    except (AttributeError, OSError):
        return False


def install(payload):
    user, home = account()
    if not pidfd_available():
        raise SetupError('pidfd')
    request = payload['request']
    checks = checker(payload['checks'])
    if request.get('linux_user') != user:
        raise SetupError('user')
    for key in ('repository', 'node'):
        if not checks['safe_path'](request.get(key)):
            raise SetupError(key)
    port = request.get('port')
    if type(port) is not int or not 1 <= port <= 65535:
        raise SetupError('port')
    source = payload['manager'].encode('utf-8')
    compile(source, '<bundled-manager>', 'exec', dont_inherit=True)
    if not checks['ss_available']():
        raise SetupError('launcher')
    # Content-addressed profiles make cross-OS partial commits safely retryable,
    # including retries with different input. Nothing existing is overwritten.
    values = {'port': port}
    for key in ('repository', 'node'):
        try:
            values[key] = str(Path(request[key]).resolve(strict=True))
        except (OSError, RuntimeError):
            raise SetupError(key)
    try:
        checks['project'](values['repository'])
    except Exception:
        raise SetupError('repository')
    try:
        node = json.loads(checks['run_node'](values['node'],
            ['--input-type=module', '--eval', NODE_IDENTITY], values['repository']))
        if node.get('platform') != 'linux' or not checks['safe_path'](node.get('execPath')):
            raise ValueError('not native Linux Node')
        # A user-supplied wrapper can resolve to a different executable. Persist
        # the actual Linux Node, since process ownership verifies that exact argv.
        values['node'] = str(Path(node['execPath']).resolve(strict=True))
    except Exception:
        raise SetupError('node')
    profile = hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()[:24]
    base = home / '.local/share/dsh-wsl-desktop'
    state = home / '.local/state/dsh-wsl-desktop' / profile
    config = dict(values, state_directory=str(state), manager_version=VERSION)
    report = checks['inspect_values'](config, port)
    for check in report['checks']:
        if check['id'] != 'launcher' and check['status'] != 'passed':
            raise SetupError(check['id'])
    if not checks['port_is_idle'](port):
        raise SetupError('port_busy')
    # Validation above is read-only; all persistent writes start here.
    os.umask(0o077)
    ensure_directory(home, Path('.local/share/dsh-wsl-desktop'))
    lock_fd = os.open(base / '.setup.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(lock_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
            raise SetupError('storage')
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ensure_directory(home, Path('.local/state/dsh-wsl-desktop') / profile)
        # No overwrite of an active profile, including a startup before it listens.
        held = checks['acquire_idle_server_lock'](str(state))
        try:
            if not checks['port_is_idle'](port):
                raise SetupError('port_busy')
            directory = ensure_directory(home, Path('.local/share/dsh-wsl-desktop/profiles') / profile)
            launcher = base / ('manager-' + VERSION + '.py')
            linux_config = directory / 'config.json'
            publish_new(launcher, source)
            publish_new(linux_config, (json.dumps(config, sort_keys=True, indent=2) + '\n').encode())
        finally:
            if held is not None:
                os.close(held)
    finally:
        os.close(lock_fd)
    return {'linux_user': user, 'linux_launcher': str(launcher), 'linux_config': str(linux_config),
            'manager_version': VERSION}


def main():
    try:
        if sys.version_info < (3, 9):
            raise SetupError('python')
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            raise SetupError('payload')
        payload = json.loads(data)
        if payload.get('action') == 'identity':
            result = identity()
        elif payload.get('action') == 'install':
            result = install(payload)
        else:
            raise SetupError('payload')
    except SetupError as error:
        result = {'error': str(error)}
    except Exception:
        # Never return exception text, program output, paths or credentials.
        result = {'error': 'setup_failed'}
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    main()
