import importlib.util
import json
from pathlib import Path
import shlex
import unittest
import sys
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('pet_configure', Path(__file__).resolve().parents[1] / 'configure.py')
configure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure)


def binding(distribution='Ubuntu', user='yangzhe', workspace='workspace-pet'):
    return {'backend': {'distribution': distribution, 'user': user, 'origin': 'http://127.0.0.1:3080'}, 'workspace_id': workspace}


class ConfigureTests(unittest.TestCase):
    def test_fixed_node_and_rust_compatible_vectors(self):
        self.assertEqual(configure.scope(binding()), '69d24e878cdcbcd59352c4a7e270d7479eca0d95b674c599ce87e11de84d476c')
        self.assertEqual(configure.scope(binding('Ubuntu 中文', '用户', 'workspace-花茶')), 'a548e98d583ac7e33edab9f86136ff91937e9686de9bcf611957304879534fca')

    def test_shell_exports_cannot_execute_workspace_or_path(self):
        malicious = binding(workspace="workspace'; echo BAD; $(touch /tmp/never) 中文")
        helper = Path("/tmp/project's pet/$(touch never).py")
        lines = configure.exports(malicious, helper).splitlines()
        for line in lines:
            parts = shlex.split(line)
            self.assertEqual(len(parts), 2)
            self.assertEqual(parts[0], 'export')
        self.assertEqual(shlex.split(lines[1])[1], 'DSH_PET_MEMORY_WORKSPACE=' + malicious['workspace_id'])
        self.assertEqual(shlex.split(lines[2])[1], 'DSH_PET_MEMORY_HELPER=' + str(helper))

    def test_no_session_or_path_in_identity_and_reject_controls(self):
        first = binding()
        second = {**first, 'session_id': 'different', 'workspace_path': '/other'}
        self.assertEqual(configure.scope(first), configure.scope(second))
        with self.assertRaises(ValueError):
            configure.scope(binding(workspace='workspace\nexport BAD=1'))


if __name__ == '__main__':
    unittest.main()
