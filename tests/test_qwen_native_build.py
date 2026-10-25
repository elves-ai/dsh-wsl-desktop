"""Offline shell fixtures: no real Git checkout, compiler, GPU or network needed."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "services/qwen_tts/build_native.sh"
SOURCE_COMMIT = "5916bf7c79dbb4e66fc059cdc507a79a23a28bb4"
GGML_COMMIT = "cc5df49a6b878db2b68b9a7b45976e279594627d"


class NativeBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source ; $(touch unsafe)"
        (self.source / "ggml").mkdir(parents=True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "calls.jsonl"
        self.cuda = self.root / "CUDA toolkit"
        (self.cuda / "include").mkdir(parents=True)
        (self.cuda / "include/cuda_runtime.h").touch()
        self.rocm = self.root / "ROCm sdk"
        (self.rocm / "lib/cmake/hip-lang").mkdir(parents=True)
        (self.rocm / "lib/cmake/hip-lang/hip-lang-config.cmake").touch()
        self.executable(self.rocm / "lib/llvm/bin/clang++", "raise AssertionError('compiler must not run')")
        self.executable(self.cuda / "bin/nvcc", "raise AssertionError('nvcc must not run')")
        self.executable(self.bin / "rocm-sdk", "raise AssertionError('rocm-sdk must not run')")
        self.executable(self.bin / "cmake", "import json,os,sys\nwith open(os.environ['CALL_LOG'],'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')")
        self.executable(self.bin / "git", f"""import os,sys
args=sys.argv[3:]
root=sys.argv[2]
mode=os.environ.get('GIT_FIXTURE','')
ggml=root.endswith('/ggml')
if args == ['rev-parse','--show-toplevel']:
 print(os.path.dirname(root) if ggml and mode == 'missing-submodule' else root)
elif args == ['rev-parse','HEAD']:
 print('bad' if mode == ('ggml-revision' if ggml else 'source-revision') else ('{GGML_COMMIT}' if ggml else '{SOURCE_COMMIT}'))
elif args == ['ls-tree','HEAD','--','ggml']:
 print('160000 commit ' + ('bad' if mode == 'gitlink' else '{GGML_COMMIT}') + '\\tggml')
elif args == ['submodule','status','--recursive']:
 print(('+' if mode == 'nested-submodule' else ' ') + '{GGML_COMMIT} ggml')
elif args[0] == 'diff':
 sys.exit(1 if mode == ('ggml-dirty' if ggml else 'source-dirty') else 0)
else:
 raise AssertionError(args)
""")
        self.env = {**os.environ, "PATH": str(self.bin) + ":/usr/bin:/bin", "CALL_LOG": str(self.log)}
        for key in ("CUDA_HOME", "CUDA_PATH", "CUDAToolkit_ROOT", "CUDACXX", "ROCM_PATH", "HIP_PATH"):
            self.env.pop(key, None)

    def executable(self, path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!" + sys.executable + "\n" + body + "\n")
        path.chmod(0o755)

    def run_script(self, *args, env=None, ok=True):
        result = subprocess.run(["bash", str(SCRIPT), "--source-dir", str(self.source), *args],
                                env=env or self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0 if ok else 2, result.stdout + result.stderr)
        return result

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_cuda_configures_native_backend_without_rocm_and_keeps_adjacent_libraries(self):
        result = self.run_script("--backend", "cuda", "--cuda-root", str(self.cuda))
        configure, build = self.calls()
        for flag in ("-DGGML_CUDA=ON", "-DGGML_HIP=OFF", "-DCMAKE_CUDA_ARCHITECTURES=native",
                     "-DFETCHCONTENT_FULLY_DISCONNECTED=ON", "-DGGML_OPENMP_FETCH=OFF", "-DGGML_BACKEND_DL=OFF"):
            self.assertIn(flag, configure)
        self.assertIn("-DCMAKE_CUDA_COMPILER=" + str(self.cuda / "bin/nvcc"), configure)
        self.assertIn("-DCUDAToolkit_ROOT=" + str(self.cuda), configure)
        self.assertFalse(any("gfx1201" in flag or "CMAKE_HIP" in flag for flag in configure))
        self.assertEqual(build, ["--build", str(self.source / "build-dsh-cuda"), "--target", "qwen", "-j", "2"])
        self.assertIn("adjacent libggml*.so", result.stdout)
        self.assertFalse((self.root / "unsafe").exists())

    def test_rocm_remains_default_with_original_flags_and_distinct_directory(self):
        self.run_script("--sdk-root", str(self.rocm))
        configure, build = self.calls()
        self.assertIn("-DGGML_HIP=ON", configure)
        self.assertIn("-DGGML_CUDA=OFF", configure)
        self.assertIn("-DCMAKE_HIP_ARCHITECTURES=gfx1201", configure)
        self.assertEqual(build[1], str(self.source / "build-dsh-rocm-gfx1201"))

    def test_cuda_architectures_nvcc_toolkit_and_jobs_are_configurable(self):
        output = self.root / "separate build"
        self.run_script("--backend", "cuda", "--nvcc", str(self.cuda / "bin/nvcc"),
                        "--cuda-architectures", "86-real;89;90-virtual", "--build-dir", str(output),
                        "--cmake", str(self.bin / "cmake"), "--jobs", "4")
        configure, build = self.calls()
        self.assertIn("-DCMAKE_CUDA_ARCHITECTURES=86-real;89;90-virtual", configure)
        self.assertEqual(build[-1], "4")
        self.assertIn(str(output), configure)

    def test_cuda_toolkit_environment_is_supported(self):
        env = {**self.env, "CUDA_HOME": str(self.cuda)}
        self.run_script("--backend", "cuda", env=env)
        self.assertIn("-DCUDAToolkit_ROOT=" + str(self.cuda), self.calls()[0])

    def test_parameter_errors_do_not_run_cmake(self):
        cases = [("--backend", "cpu"), ("--backend",), ("--jobs", "9"), ("--jobs", "1;touch bad"),
                 ("--unknown", "x"), ("--cmake", ""), ("--nvcc", "anything"),
                 ("--backend", "cuda", "--sdk-root", str(self.rocm)),
                 ("--backend", "cuda", "--cuda-architectures", "native;touch bad")]
        for args in cases:
            with self.subTest(args=args):
                self.run_script(*args, ok=False)
        self.assertEqual(self.calls(), [])

    def test_missing_toolkit_does_not_install_or_run_cmake(self):
        self.run_script("--backend", "cuda", "--cuda-root", str(self.root), ok=False)
        self.assertEqual(self.calls(), [])

    def test_pin_gitlink_submodule_and_tracked_modifications_fail_closed(self):
        for mode in ("source-revision", "ggml-revision", "gitlink", "missing-submodule",
                     "nested-submodule", "source-dirty", "ggml-dirty"):
            with self.subTest(mode=mode):
                self.run_script("--backend", "cuda", "--cuda-root", str(self.cuda),
                                env={**self.env, "GIT_FIXTURE": mode}, ok=False)
        self.assertEqual(self.calls(), [])

    def test_cross_backend_and_cpu_caches_are_refused_without_deletion(self):
        output = self.root / "existing build"
        output.mkdir()
        sentinel = output / "libggml-user.so"
        sentinel.write_text("keep")
        cache = output / "CMakeCache.txt"
        for backend, data in (("cuda", "GGML_HIP:BOOL=ON\nGGML_CUDA:BOOL=OFF\n"),
                              ("rocm", "GGML_CUDA:BOOL=ON\nGGML_HIP:BOOL=OFF\n"),
                              ("cuda", "GGML_CUDA:BOOL=OFF\n"),
                              ("rocm", "GGML_HIP:BOOL=OFF\n"),
                              ("cuda", "CMAKE_HOME_DIRECTORY:INTERNAL=/different/source\n"),
                              ("cuda", "CMAKE_BUILD_TYPE:STRING=Release\n"),
                              ("cuda", "GGML_CUDA:BOOL=ON\nCMAKE_CUDA_COMPILER:FILEPATH=/other/nvcc\n")):
            with self.subTest(backend=backend, data=data):
                cache.write_text(data)
                root_flag, root = ("--cuda-root", self.cuda) if backend == "cuda" else ("--sdk-root", self.rocm)
                self.run_script("--backend", backend, root_flag, str(root), "--build-dir", str(output), ok=False)
                self.assertEqual(cache.read_text(), data)
                self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual(self.calls(), [])

    def test_matching_cache_is_reusable_and_source_build_is_refused(self):
        output = self.root / "build"
        output.mkdir()
        (output / "CMakeCache.txt").write_text("GGML_CUDA:BOOL=ON\nGGML_HIP:BOOL=OFF\n")
        self.run_script("--backend", "cuda", "--cuda-root", str(self.cuda), "--build-dir", str(output))
        self.run_script("--backend", "cuda", "--cuda-root", str(self.cuda), "--build-dir", str(self.source), ok=False)
        self.assertEqual(len(self.calls()), 2)


if __name__ == "__main__":
    unittest.main()
