"""Offline installer safety/lifecycle tests. Never downloads GPU packages or models."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
I = module("speech_install", ROOT / "src-tauri/helpers/speech_install.py")
R = module("speech_resources", ROOT / "src-tauri/helpers/speech_resources.py")

def process_stopped(pid):
    # The kernel can reap a process before open (ENOENT) or during read
    # (ESRCH). Both mean stopped; zombies are stopped, live states still fail.
    try:
        state = (Path("/proc") / str(pid) / "stat").read_text()
    except (FileNotFoundError, ProcessLookupError):
        return True
    return state.split()[2] == "Z"


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
    def test_cuda_priority_driver_arch_and_no_ambient_python(self):
        with patch.object(I, "run", return_value='{"version":12080,"arch":89}') as run:
            self.assertEqual(I.select_cuda(lambda:False), "89")
            self.assertEqual(run.call_args.args[0][:4], ["/usr/bin/python3", "-I", "-S", "-c"])
        with patch.object(I, "run", return_value=None):
            self.assertIsNone(I.select_cuda(lambda:False))
        for value, code in [('{"version":12070,"arch":89}', "cuda_driver_old"),
                            ('{"version":12080,"arch":999}', "cuda_arch_unsupported")]:
            with patch.object(I, "run", return_value=value), self.assertRaisesRegex(I.InstallError, code):
                I.select_cuda(lambda:False)
    def test_env_is_not_inherited(self):
        with patch.dict(os.environ, {"PYTHONPATH":"/evil", "PIP_INDEX_URL":"https://evil", "GIT_CONFIG":"/evil", "LD_PRELOAD":"/evil"}):
            env=I.environment(self.root)
        self.assertNotIn("PYTHONPATH",env)
        self.assertNotIn("LD_PRELOAD",env)
        self.assertNotIn("PIP_INDEX_URL",env)
        self.assertEqual(env["GIT_CONFIG_GLOBAL"],os.devnull)
    def test_rocm_build_backend_is_pinned_and_only_metapackage_can_use_source(self):
        env=I.environment(self.root)
        cancelled=lambda:False
        with patch.object(I,"run") as run:
            I.install_rocm_dependencies("/managed/python",cancelled,env)
        self.assertEqual(run.call_count,2)
        build, sdk = run.call_args_list
        self.assertEqual(build.args[0], ["/managed/python", "-I", "-m", "pip", "install",
            "--index-url", I.PYPI, "--only-binary=:all:", "setuptools==80.9.0"])
        self.assertEqual(sdk.args[0], ["/managed/python", "-I", "-m", "pip", "install",
            "--index-url", I.AMD_INDEX, "--only-binary=:all:", "--no-binary=rocm",
            "--no-build-isolation", "rocm[libraries,devel,device-gfx1201]==10.1.0"])
        for call in run.call_args_list:
            self.assertIs(call.args[1],cancelled)
            self.assertIs(call.args[3],env)
            self.assertNotIn("--extra-index-url",call.args[0])
        self.assertEqual(build.args[2],"dependencies_failed")
        self.assertEqual(sdk.args[2],"rocm_dependencies_failed")
    def test_rocm_build_backend_failure_does_not_attempt_sdk(self):
        with patch.object(I,"run",side_effect=I.InstallError("dependencies_failed")) as run:
            with self.assertRaisesRegex(I.InstallError,"dependencies_failed"):
                I.install_rocm_dependencies("/managed/python",lambda:False,I.environment())
        self.assertEqual(run.call_count,1)
    def test_cancel_kills_child_process_group(self):
        pidfile=self.root / "pid"
        code="import os,subprocess,time; p=subprocess.Popen(['sleep','60']);open("+repr(str(pidfile))+",'w').write(str(p.pid));time.sleep(60)"
        cancel=threading.Event()
        errors=[]
        def worker():
            try: I.run([sys.executable,"-c",code], cancel.is_set, "fixture")
            except Exception as e: errors.append(e)
        thread=threading.Thread(target=worker);thread.start()
        for _ in range(100):
            if pidfile.exists(): break
            time.sleep(.02)
        self.assertTrue(pidfile.exists()); pid=int(pidfile.read_text())
        cancel.set();thread.join(3);self.assertFalse(thread.is_alive())
        self.assertEqual(str(errors[0]),"cancelled")
        self.assertTrue(process_stopped(pid))
    def test_process_stop_check_handles_reaped_zombie_and_live_processes(self):
        with patch.object(Path,"exists",side_effect=AssertionError("racy pre-check")):
            for error in [FileNotFoundError, ProcessLookupError]:
                with self.subTest(error=error), patch.object(Path,"read_text",side_effect=error):
                    self.assertTrue(process_stopped(123))
            for state, stopped in [("Z", True), ("S", False), ("R", False)]:
                with self.subTest(state=state), patch.object(Path,"read_text",return_value=f"123 (sleep) {state} 1 1"):
                    self.assertEqual(process_stopped(123),stopped)
    def test_process_stop_check_does_not_hide_permission_errors(self):
        with patch.object(Path,"read_text",side_effect=PermissionError),self.assertRaises(PermissionError):
            process_stopped(123)
    def test_subprocess_timeout_and_no_shell(self):
        with self.assertRaisesRegex(I.InstallError,"fixture_timeout"):
            I.run([sys.executable,"-c","import time;time.sleep(10)"],lambda:False,"fixture",timeout=.01)
        with self.assertRaisesRegex(I.InstallError,"fixture"):
            I.run([sys.executable,"-c","raise SystemExit(1)"],lambda:False,"fixture")
    def archive(self, name, link=None):
        path=self.root / "input.tar.xz"
        with tarfile.open(path,"w:xz") as tar:
            member=tarfile.TarInfo(name)
            if link is not None:
                member.type=tarfile.SYMTYPE;member.linkname=link
                tar.addfile(member)
            else:
                member.size=2;tar.addfile(member,io.BytesIO(b"ok"))
        return path
    def test_sdk_archive_refuses_traversal_and_link_escape(self):
        target=self.root / "target";target.mkdir()
        for name,link in [("root/../../outside",None),("/absolute/file",None),("root/lib/escape","../../outside")]:
            with self.subTest(name=name), self.assertRaisesRegex(I.InstallError,"unsafe_sdk_archive"):
                I.extract_cuda(self.archive(name,link),target,lambda:False)
        self.assertFalse((self.root / "outside").exists())
        I.extract_cuda(self.archive("root/include/test.h"),target,lambda:False)
        self.assertEqual((target / "include/test.h").read_bytes(),b"ok")
    def test_sdk_archive_refuses_existing_symlink_parent(self):
        target=self.root / "target";target.mkdir();(target / "include").symlink_to(self.root)
        with self.assertRaisesRegex(I.InstallError,"unsafe_sdk_archive"):
            I.extract_cuda(self.archive("root/include/outside"),target,lambda:False)
    def test_default_root_symlink_is_rejected(self):
        with patch.object(Path,"home",return_value=self.root),patch.object(I.platform,"machine",return_value="x86_64"),patch.object(I.os.path,"exists",return_value=True):
            (self.root / ".dsh-wsl-desktop").symlink_to(self.root / "outside")
            with self.assertRaisesRegex(R.Refused,"unsafe_initialize_directory"): I.install(R,b"",lambda:False,lambda p:None)
    def test_unsupported_wsl_and_missing_tools_fail_before_writes(self):
        with patch.object(I.os.path,"exists",return_value=False),self.assertRaisesRegex(I.InstallError,"wsl_gpu_unavailable"):
            I.install(R,b"",lambda:False,lambda p:None)
        with patch.object(I.os.path,"exists",return_value=True),patch.object(I.shutil,"which",return_value=None),self.assertRaisesRegex(I.InstallError,"missing_tool_git"):
            I.install(R,b"",lambda:False,lambda p:None)
    def test_bootstrap_fixed_pip_wheel_verifies_sha_and_uses_no_index(self):
        wheel=b"fixture wheel"
        meta={"urls":[{"filename":"pip-25.3-py3-none-any.whl","url":"https://files.pythonhosted.org/pip.whl","digests":{"sha256":hashlib.sha256(wheel).hexdigest()}}]}
        class Client:
            def open(self,url,timeout):
                return io.BytesIO(json.dumps(meta).encode() if url.endswith('/json') else wheel)
        with patch.object(I.urllib.request,"build_opener",return_value=Client()),patch.object(I,"run") as run:
            I.bootstrap_pip("/managed/python",self.root,lambda:False,I.environment())
            command=run.call_args.args[0]
            self.assertEqual(command[:2],["/managed/python","-I"])
            self.assertIn("--no-index",command)
            self.assertIn("--no-deps",command)
        meta["urls"][0]["digests"]["sha256"]="0"*64
        with patch.object(I.urllib.request,"build_opener",return_value=Client()),patch.object(I,"run") as run,self.assertRaisesRegex(I.InstallError,"pip_missing"):
            I.bootstrap_pip("/managed/python",self.root,lambda:False,I.environment())
        run.assert_not_called()
    def test_real_git_separate_ggml_checkout_passes_submodule_status_contract(self):
        env=I.environment();env.update(GIT_AUTHOR_NAME="fixture",GIT_AUTHOR_EMAIL="fixture@example.invalid",GIT_COMMITTER_NAME="fixture",GIT_COMMITTER_EMAIL="fixture@example.invalid")
        def git(path,*args):
            return subprocess.check_output(["git","-C",str(path),*args],env=env,stderr=subprocess.DEVNULL,text=True).strip()
        origin=self.root / "origin";origin.mkdir();git(origin,"init")
        (origin / "file").write_text("fixture");git(origin,"add",".");git(origin,"commit","-m","fixture")
        commit=git(origin,"rev-parse","HEAD")
        source=self.root / "source";source.mkdir();git(source,"init")
        (source / ".gitmodules").write_text('[submodule "ggml"]\n path = ggml\n url = '+str(origin)+'\n')
        git(source,"add",".gitmodules");git(source,"update-index","--add","--cacheinfo","160000,"+commit+",ggml")
        git(source,"commit","-m","fixture")
        I.checkout(source,"ggml",str(origin),commit,lambda:False,env)
        git(source,"submodule","init","--","ggml")
        status=subprocess.check_output(["git","-C",str(source),"submodule","status","--recursive"],env=env,text=True)
        self.assertTrue(status.startswith(" "+commit),status)
        self.assertEqual(git(source / "ggml","rev-parse","--show-toplevel"),str(source / "ggml"))
    def test_default_pipeline_builds_both_backends_without_publishing_config(self):
        for backend in ("cuda", "rocm"):
            with self.subTest(backend=backend):
                home=self.root / backend;home.mkdir(mode=0o700)
                root=home / R.SPEECH_ROOT
                python=str(root / "runtime/venv/bin/python")
                calls=[];stages=[]
                def run(argv,*args,**kwargs):
                    calls.append(argv)
                    if argv[-1] == I.ROCM_PROBE: return "gfx1201"
                    if argv[-2:] == ["path","--root"]: return str(root / "sdk")
                    return "ok"
                def checkout(parent,name,*args):
                    path=parent / name;path.mkdir();return path
                def download(request,emit,cancelled):
                    self.assertEqual(request,{"model_dir":str(root / "models/qwen3-tts-q8")})
                    emit({"downloaded_bytes":100,"total_bytes":100})
                original_exists=os.path.exists
                with patch.object(Path,"home",return_value=home), patch.object(I.os.path,"exists",side_effect=lambda p: True if str(p)=="/dev/dxg" else original_exists(p)), patch.object(R,"initialize_venv",return_value=(python,True)), patch.object(I,"run",side_effect=run), patch.object(I,"select_cuda",return_value="89" if backend=="cuda" else None), patch.object(I,"install_cuda",return_value=root / "sdk") as cuda, patch.object(I,"checkout",side_effect=checkout) as sources, patch.object(R,"download",side_effect=download):
                    result=I.install(R,b"fixed bundled build script",lambda:False,stages.append)
                self.assertEqual(result["python_path"],python)
                self.assertEqual(result["model_dir"],str(root / "models/qwen3-tts-q8"))
                self.assertTrue(result["native_lib"].endswith("build-"+backend+"/libqwen.so"))
                self.assertFalse((root / "config.json").exists())
                self.assertEqual(sources.call_args_list[0].args[3],I.QWEN_COMMIT)
                self.assertEqual(sources.call_args_list[1].args[3],I.GGML_COMMIT)
                build=next(c for c in calls if c[0]=="bash")
                self.assertIn("--backend",build);self.assertIn(backend,build)
                self.assertEqual(Path(build[1]).read_bytes(),b"fixed bundled build script")
                self.assertFalse(any(c[0] in ("sudo","apt","apt-get") for c in calls))
                if backend=="cuda":
                    cuda.assert_called_once()
                    self.assertFalse(any("setuptools==80.9.0" in c or "--no-binary=rocm" in c for c in calls))
                else:
                    cuda.assert_not_called()
                    self.assertTrue(any("rocm[libraries,devel,device-gfx1201]==10.1.0" in c for c in calls))
                self.assertEqual(stages[-1]["downloaded_bytes"],100)
    def test_embedded_payload_and_owner_eof_cancel_without_checkout_import(self):
        source=(ROOT / "src-tauri/helpers/speech_install.py").read_text()
        self.assertNotIn("import speech_resources",source)
        self.assertLess(len(source.encode()),131072)
        payload={"resources":base64.b64encode((ROOT / "src-tauri/helpers/speech_resources.py").read_bytes()).decode(),"build_script":base64.b64encode((ROOT / "services/qwen_tts/build_native.sh").read_bytes()).decode()}
        self.assertLess(len(json.dumps(payload)),262144)
        # Empty malformed request must yield only static code, not raw tracebacks/paths.
        result=subprocess.run([sys.executable,"-I",str(ROOT / "src-tauri/helpers/speech_install.py")],input="{}\n",capture_output=True,text=True,timeout=5)
        self.assertEqual(json.loads(result.stdout),{"ok":False,"error":"invalid_request"})

if __name__ == "__main__": unittest.main()
