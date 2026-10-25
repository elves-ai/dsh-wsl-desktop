"""Read a native binding and print shell-safe exports; never modify a profile."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import shlex
import sys


def identity(binding):
    if not isinstance(binding, dict) or not isinstance(binding.get('backend'), dict):
        raise ValueError('Invalid native binding.')
    backend = binding['backend']
    values = [backend.get(key) for key in ('distribution', 'user', 'origin')] + [binding.get('workspace_id')]
    for value in values:
        if (not isinstance(value, str) or not value.strip() or len(value.encode('utf-8')) > 4096
                or any(ord(char) < 32 or ord(char) == 127 for char in value)):
            raise ValueError('Invalid backend/workspace identity.')
    return values


def scope(binding):
    # Exactly the Rust serde_json array / JavaScript JSON.stringify UTF-8 encoding.
    data = json.dumps(identity(binding), ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(data).hexdigest()


def exports(binding, helper):
    values = {'DSH_PET_MEMORY_SCOPE': scope(binding),
              'DSH_PET_MEMORY_WORKSPACE': binding['workspace_id'],
              'DSH_PET_MEMORY_HELPER': str(helper)}
    return '\n'.join('export ' + key + '=' + shlex.quote(value) for key, value in values.items())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binding', required=True, type=Path, help='Absolute WSL-readable native assistant binding JSON')
    parser.add_argument('--helper-path', type=Path, help='Optional absolute Python helper; default is this desktop source checkout helper')
    args = parser.parse_args(argv)
    try:
        if not args.binding.is_absolute() or not args.binding.is_file() or args.binding.stat().st_size > 65536:
            raise ValueError('Binding must be an absolute regular JSON file, at most 64 KiB.')
        binding = json.loads(args.binding.read_text(encoding='utf-8-sig'))
        distribution, user, _origin, _workspace = identity(binding)
        if user != pwd.getpwuid(os.getuid()).pw_name:
            raise ValueError('Run this command as the WSL user recorded in the binding.')
        if os.environ.get('WSL_DISTRO_NAME') and os.environ['WSL_DISTRO_NAME'] != distribution:
            raise ValueError('Run this command inside the WSL distribution recorded in the binding.')
        helper = args.helper_path or Path(__file__).resolve().parents[2] / 'src-tauri' / 'helpers' / 'pet_memory.py'
        if not helper.is_absolute() or not helper.is_file():
            raise ValueError('Desktop helper not found; supply its absolute source path with --helper-path.')
        print(exports(binding, helper.resolve()))
        return 0
    except (ValueError, OSError, UnicodeError, KeyError, TypeError):
        # Do not leak binding contents, user data or system paths into errors.
        print('Invalid binding/helper or different WSL identity. Check the absolute paths and recorded WSL user/distribution.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
