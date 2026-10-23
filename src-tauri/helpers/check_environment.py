"""Bounded environment inspection; never import or execute the management script.

Embedded by Rust as /usr/bin/python3 -I -c SOURCE inspect LAUNCHER CONFIG PORT.
Only the explicit 'save' mode may write, and only CONFIG.repository is changed.
"""
import fcntl
import html.parser
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
from urllib.parse import unquote, urlsplit

MAX_FILE = 1024 * 1024
MAX_OUTPUT = 8192
PROJECT_NAME = '@deepseek-ai/dsh-root'
LABELS = {
    'launcher': 'Linux 管理脚本', 'linux_config': 'Linux 配置',
    'repository': 'DSH 项目目录', 'node': 'Node.js',
    'dependencies': '已安装依赖', 'web_assets': 'Web 构建产物',
}
MESSAGES = {
    'launcher': ('管理脚本可读、语法有效，ss 命令可用。', '管理脚本缺失、不可读、语法无效或缺少 ss 命令。', '请手动检查已有管理脚本及系统 ss 命令；检测不会执行或创建脚本。'),
    'linux_config': ('Linux 配置有效，端口与桌面一致。', 'Linux 配置缺失、格式无效或端口不一致。', '请手动检查 JSON 的 repository、node、state_directory、port。'),
    'repository': ('DSH 项目入口和项目清单有效。', '目录不是有效的 DSH 项目，或入口不可读。', '请选择已有 DSH 项目的 WSL 绝对路径。'),
    'node': ('Node.js 可执行且满足项目版本要求。', '配置指定的 Node.js 不可执行、版本不兼容或版本要求无效。', '请手动检查 Node 路径和项目 engines.node；检测不会安装。'),
    'dependencies': ('已安装的 tsx/esm 入口可解析且可读。', '缺少可用的 tsx/esm 依赖入口。', '请在项目中手动准备依赖；检测不会安装或导入依赖。'),
    'web_assets': ('Web 页面及其本地构建资源可读。', 'Web 构建产物缺失、不完整或不可读。', '请手动构建项目的 Web 产物；检测不会执行构建。'),
}


def safe_path(value):
    if not isinstance(value, str) or not value.startswith('/') or value.startswith('//'):
        return False
    if len(value.encode('utf-8', errors='replace')) > 4096 or '://' in value:
        return False
    if any(unicodedata.category(c).startswith('C') for c in value):
        return False
    return not re.search(r'(?:token|api[_-]?key|secret|password|authorization)\s*[=:]', value, re.I)


def read_file(path):
    # NONBLOCK prevents special files (e.g. FIFOs) from stalling inspection.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
            raise ValueError('invalid file')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            data = source.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            raise ValueError('large file')
        return data
    finally:
        os.close(fd)


def reject_json_constant(_):
    raise ValueError('non-JSON numeric constant')


def read_json(path):
    return json.loads(read_file(path).decode('utf-8-sig'), parse_constant=reject_json_constant)


def valid_config(config, port):
    return (isinstance(config, dict)
            and all(safe_path(config.get(key)) for key in ('repository', 'node', 'state_directory'))
            and type(config.get('port')) is int and 1 <= config['port'] <= 65535
            and config['port'] == port)


def project(path):
    data = read_json(Path(path) / 'package.json')
    if not isinstance(data, dict) or data.get('name') != PROJECT_NAME:
        raise ValueError('not DSH')
    if not read_file(Path(path) / 'apps/cli/src/bin.ts'):
        raise ValueError('empty entry')
    return data


def run_node(node, args, cwd):
    # No inherited NODE_OPTIONS, NODE_PATH, preload hooks, or shell execution.
    env = {'PATH': str(Path(node).parent) + ':/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    process = subprocess.Popen([node, *args], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    output = bytearray()
    deadline = time.monotonic() + 4
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError('timeout')
                for key, _ in selector.select(min(remaining, 0.1)):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        if process.wait(timeout=max(0.01, deadline - time.monotonic())) != 0:
                            raise ValueError('node failed')
                        return bytes(output)
                    output.extend(chunk)
                    if len(output) > MAX_OUTPUT:
                        raise ValueError('large output')
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


def version_tuple(value):
    match = re.fullmatch(r'v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value.strip())
    if not match:
        raise ValueError('invalid version')
    return tuple(map(int, match.groups()))


def partial_version(value):
    parts = value.split('.')
    if len(parts) > 3:
        raise ValueError('invalid range')
    numbers = []
    wildcard = False
    for part in parts:
        if part in ('x', 'X', '*'):
            wildcard = True
        elif not wildcard and re.fullmatch(r'0|[1-9]\d*', part):
            numbers.append(int(part))
        else:
            raise ValueError('invalid range')
    return tuple(numbers + [0] * (3 - len(numbers))), len(numbers)


def next_partial(low, count):
    position = max(0, count - 1)
    return low[:position] + (low[position] + 1,) + (0,) * (2 - position)


def comparator(version, token):
    match = re.fullmatch(r'(>=|<=|>|<|=|\^|~)?v?([0-9xX*]+(?:\.[0-9xX*]+){0,2})', token)
    if not match:
        raise ValueError('unsupported range')
    operator, text = match.groups()
    low, count = partial_version(text)
    if count == 0:
        if operator not in (None, '='):
            raise ValueError('unsupported wildcard')
        return True
    if operator == '^':
        position = next((i for i, part in enumerate(low) if part != 0), max(0, count - 1))
        high = low[:position] + (low[position] + 1,) + (0,) * (2 - position)
        return low <= version < high
    if operator == '~':
        return low <= version < next_partial(low, min(2, count))
    if operator in (None, '='):
        return version == low if count == 3 else low <= version < next_partial(low, count)
    if operator == '>=':
        return version >= low
    if operator == '<':
        return version < low
    if operator == '>':
        return version > low if count == 3 else version >= next_partial(low, count)
    return version <= low if count == 3 else version < next_partial(low, count)


def satisfies(version, requirement):
    # Pure-data npm range subset, covering DSH's ^22.19.0 || >=24.0.0.
    # Unknown syntax fails closed instead of invoking any project/package code.
    if not isinstance(requirement, str) or not requirement.strip() or len(requirement) > 512:
        return False
    try:
        alternatives = []
        for alternative in requirement.split('||'):
            alternative = alternative.strip()
            hyphen = re.fullmatch(r'(\S+)\s+-\s+(\S+)', alternative)
            if hyphen:
                low, _ = partial_version(hyphen[1])
                high, count = partial_version(hyphen[2])
                alternatives.append(version >= low and (version <= high if count == 3 else version < next_partial(high, count)))
            else:
                alternative = re.sub(r'(>=|<=|>|<|=|\^|~)\s+', r'\1', alternative)
                tokens = alternative.split()
                results = [comparator(version, token) for token in tokens]
                alternatives.append(bool(results) and all(results))
        return any(alternatives)
    except (ValueError, IndexError):
        return False


DEPENDENCY_PROBE = """
import { statSync, accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
try {
  const path = fileURLToPath(import.meta.resolve('tsx/esm'));
  accessSync(path, constants.R_OK);
  process.stdout.write(statSync(path).isFile() ? 'dsh-dependency-ok' : 'missing');
} catch { process.exitCode = 1; }
"""


class AssetParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = []

    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        if tag == 'script' and data.get('src'):
            self.assets.append(data['src'])
        if tag == 'link' and data.get('rel') in ('stylesheet', 'modulepreload') and data.get('href'):
            self.assets.append(data['href'])


def web_assets(repository):
    dist = (Path(repository) / 'apps/web/dist').resolve()
    parser = AssetParser()
    parser.feed(read_file(dist / 'index.html').decode('utf-8'))
    local = 0
    for asset in parser.assets:
        url = urlsplit(asset)
        if url.scheme or url.netloc:
            continue
        target = (dist / unquote(url.path).lstrip('/')).resolve()
        if not target.is_relative_to(dist):
            raise ValueError('invalid asset')
        fd = os.open(target, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode) or not os.read(fd, 1):
                raise ValueError('unreadable asset')
        finally:
            os.close(fd)
        local += 1
    if not local:
        raise ValueError('no built assets')


def item(key, status):
    passed, failed, hint = MESSAGES[key]
    return {'id': key, 'label': LABELS[key], 'status': status,
            'message': passed if status == 'passed' else failed if status == 'error' else '上游检查未通过，暂不检测。',
            'hint': hint if status == 'error' else ''}


def ss_available():
    return shutil.which('ss', path='/usr/sbin:/usr/bin:/sbin:/bin') is not None


def inspect(launcher, config_path, port, runner=run_node):
    checks = {key: item(key, 'skipped') for key in LABELS}
    repository = None
    try:
        compile(read_file(launcher), '<management-script>', 'exec', dont_inherit=True)
        if not ss_available():
            raise ValueError('missing ss')
        checks['launcher'] = item('launcher', 'passed')
    except Exception:
        checks['launcher'] = item('launcher', 'error')
    try:
        config = read_json(config_path)
    except Exception:
        checks['linux_config'] = item('linux_config', 'error')
        return {'checks': list(checks.values()), 'repository': repository}
    result = inspect_values(config, port, runner)
    for check in result['checks']:
        if check['id'] != 'launcher':
            checks[check['id']] = check
    return {'checks': list(checks.values()), 'repository': result['repository']}


def inspect_values(config, port, runner=run_node):
    """The same read-only checks for a not-yet-persisted first-run config."""
    checks = {key: item(key, 'skipped') for key in LABELS}
    repository = None
    try:
        if isinstance(config, dict) and safe_path(config.get('repository')):
            repository = config['repository']
        if not valid_config(config, port):
            raise ValueError('invalid config')
        checks['linux_config'] = item('linux_config', 'passed')
    except Exception:
        checks['linux_config'] = item('linux_config', 'error')
        return {'checks': list(checks.values()), 'repository': repository}
    try:
        manifest = project(repository)
        checks['repository'] = item('repository', 'passed')
    except Exception:
        checks['repository'] = item('repository', 'error')
        return {'checks': list(checks.values()), 'repository': repository}
    try:
        node = config['node']
        if not Path(node).is_file() or not os.access(node, os.X_OK):
            raise ValueError('node not executable')
        version = version_tuple(runner(node, ['--version'], repository).decode('ascii'))
        engines = manifest.get('engines')
        if not isinstance(engines, dict) or not satisfies(version, engines.get('node')):
            raise ValueError('engine mismatch')
        checks['node'] = item('node', 'passed')
    except Exception:
        checks['node'] = item('node', 'error')
    if checks['node']['status'] == 'passed':
        try:
            reply = runner(node, ['--input-type=module', '--eval', DEPENDENCY_PROBE], repository)
            if reply != b'dsh-dependency-ok':
                raise ValueError('dependency missing')
            checks['dependencies'] = item('dependencies', 'passed')
        except Exception:
            checks['dependencies'] = item('dependencies', 'error')
    # Web files do not depend on Node being executable or dependencies being installed.
    try:
        web_assets(repository)
        checks['web_assets'] = item('web_assets', 'passed')
    except Exception:
        checks['web_assets'] = item('web_assets', 'error')
    return {'checks': list(checks.values()), 'repository': repository}


def port_is_idle(port):
    # Only explicit connection refusal proves there is no IPv4 loopback listener.
    # Never issue HTTP/RPC requests or stop any process. Ambiguity fails closed.
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.25):
            return False
    except ConnectionRefusedError:
        return True
    except OSError:
        return False


def acquire_idle_server_lock(state_directory):
    """Read-only existing lock; never create state directories or lock files."""
    if not safe_path(state_directory):
        raise ValueError('unknown state directory')
    try:
        fd = os.open(Path(state_directory) / 'server.lock',
                     os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('invalid lock file')
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        return fd
    except Exception:
        os.close(fd)
        raise


def save_repository(config_path, repository):
    """Explicit user action only; reject invalid inputs before creating a temp file."""
    if not safe_path(repository):
        return False
    temporary = None
    lock_fd = None
    try:
        project(repository)
        path = Path(config_path)
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            return False
        original = read_file(path)
        config = json.loads(original.decode('utf-8-sig'), parse_constant=reject_json_constant)
        if (not isinstance(config, dict) or type(config.get('port')) is not int
                or not 1 <= config['port'] <= 65535):
            return False
        lock_fd = acquire_idle_server_lock(config.get('state_directory'))
        if not port_is_idle(config['port']):
            return False
        config['repository'] = repository
        content = (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        if len(content) > MAX_FILE:
            return False
        fd, temporary = tempfile.mkstemp(prefix='.dsh-config-', dir=path.parent)
        with os.fdopen(fd, 'wb') as target:
            if (before.st_uid, before.st_gid) != (os.geteuid(), os.getegid()):
                os.fchown(target.fileno(), before.st_uid, before.st_gid)
            os.fchmod(target.fileno(), stat.S_IMODE(before.st_mode))
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        # If no lock existed initially, detect one created while preparing the save.
        if lock_fd is None:
            lock_fd = acquire_idle_server_lock(config.get('state_directory'))
        current = path.lstat()
        if ((current.st_dev, current.st_ino, current.st_mtime_ns, current.st_size)
                != (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_size)
                or read_file(path) != original or not port_is_idle(config['port'])):
            return False
        os.replace(temporary, path)
        temporary = None
        return True
    except Exception:
        return False
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def main(argv):
    try:
        if len(argv) == 4 and argv[0] == 'inspect':
            result = inspect(argv[1], argv[2], int(argv[3]))
        elif len(argv) == 3 and argv[0] == 'save':
            result = {'saved': save_repository(argv[1], argv[2])}
        else:
            result = {'error': True}
    except Exception:
        result = {'error': True}
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    main(sys.argv[1:])
