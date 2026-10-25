# 本地千问朗读（WSL 原生 Q8 / CUDA / ROCm）

桌宠沿用现有“朗读”“自动朗读”、原生 IPC 和 Web Audio。Python 只作 127.0.0.1:18765 安全桥与进程编排，在独立 spawn 子进程中通过 ctypes 调用 C ABI 6 原生库，使用 **Q8 GGUF + CUDA / ROCm GPU**。自动选择优先 CUDA0，再尝试 ROCm0；不回退 CPU。没有 PyTorch/MIOpen 推理，也没有 Windows 原生 Python 或系统音色生产回退。

自动朗读仍默认关闭，与音量一起保存在原生语音设置中，设置页和桌宠右键菜单即时同步。旧 `dsh-assistant:qwen-auto-read` 仅在原生偏好尚未初始化时迁移一次，不继承旧系统语音开关；只读显式启用后新完成的短回复，不补读历史。本文是源码开发接入说明，**不是 Windows 桌宠全链路验收或新安装包已构建的声明**。

## 分步安装与使用

打开“设置 → 桌面宠物 → 本地千问语音”，按页面的三个步骤操作：

1. **检查系统环境**：自动只读检查当前 WSL、Python、系统构建工具和 GPU 桥接。缺少系统依赖时，Ubuntu/Debian 提供可复制的安装命令；在当前 WSL 终端执行后点击“重新检查”。驱动或平台问题按缺失项提示处理，不由程序执行管理员命令。
2. **安装语音组件**：环境就绪后点击“安装语音组件与模型”，自动准备独立 Python 环境、匹配显卡的用户级依赖并编译固定版本语音引擎。
3. **下载并校验模型**：组件安装后自动继续，下载语音生成模型和配套音频编解码模型，执行真实 GPU/ABI 与模型校验，通过后自动保存配置。无需选择路径或单独保存。

- 首次安装需要联网下载模型和依赖。两份模型约 **2.21 GiB**，SDK、源码和编译产物还需要额外磁盘空间。界面显示当前阶段与模型下载字节，支持取消及失败重试。
- 离开设置分类不会中断安装，回来继续查看；退出应用会取消所属安装任务。已完成资源可能保留，重试复用通过校验的资源；失败不把未通过检测的配置设为有效配置。
- 打开设置和刷新状态只读，不安装。安装完成不自动加载模型，也不开启自动朗读。随后点击“启动并加载模型”，再“试听固定文本”；“停止并释放显存”仅停止本应用托管的语音服务。
- 自动朗读默认关闭，音量与桌宠右键菜单同步。设置页试听权限不等于桌宠已解锁播放，桌宠首次使用仍可能需要点击“朗读”。
- 安装器面向 x86_64 WSL2、Python ≥ 3.10 和可用的 `/dev/dxg` GPU 桥接。系统需有 Git、Bash、Make、C/C++ 编译器及 realpath；缺少 pip 时会自动准备固定版本 pip。ROCm 固定为 10.1.0 / gfx1201；CUDA 固定为 12.8.1，要求驱动与 GPU 架构兼容。
- 不自动安装 WSL、系统 Python、系统显卡驱动或执行管理员命令。缺少系统前置工具时引导安装；不支持的硬件会明确提示，不回退 CPU、不假称安装完成。NVIDIA 实机验收仍待完成。
- 固定 profile `pet-airhead-v1`，使用已批准的 8.4 秒合成声音：[参考音频](<services/qwen_tts/voice/reference.wav>)与[台词、SHA256 和来源](<services/qwen_tts/voice/profile.json>)共同用于 ICL，不调用 VoiceDesign、不混入其他声纹。

## 默认数据目录

语音数据统一放在当前 WSL 用户的家目录，不放在源码仓库或 Windows 安装目录：

~~~text
~/.dsh-wsl-desktop/speech/
├── models/qwen3-tts-q8/  # 固定模型目录
├── runtime/venv/       # 默认 Python 与用户级依赖
├── native/install-*/   # 隔离的固定版本源码与原生构建
├── cuda-12.8.1/        # NVIDIA 路径使用的用户级 toolkit
├── config.json         # 旧初始化流程的兼容记录，可能不存在，不含凭据
└── service/            # 版本隔离的服务与私有运行记录
~~~

Python 固定使用 `runtime/venv/bin/python`，旧外部解释器不会执行。目录由程序管理，不提供选择或手输入口；不搬迁旧外部环境。检测通过后的有效路径与偏好由 Windows Tauri 用户配置目录保存；不会覆盖旧初始化流程留下的 `speech/config.json`。外部手动服务不接管，安装前须先停止冲突的语音服务。更新代码不会改变已安装的 Windows 应用，需要重新构建并更新桌面应用。

## 安装前提示“语音服务无响应”

这个错误可能发生在组件安装器运行之前：安装流程须先确认没有运行中的语音服务，状态检查失败就不会修改依赖或下载模型。“检查系统环境已就绪”并不等于组件已安装。Windows 对未监听的本地端口返回连接拒绝可能需要略多于 2 秒；旧版的 2 秒连接期限会将正常的“服务未启动”误判为超时。源码已将连接期限调整为 5 秒、单次状态请求期限调整为 6 秒，但仍拒绝把真正的超时当作已停止。此修复需重新构建并更新 Windows 应用后生效；源码测试不代表已完成桌面端首次安装及 GPU 朗读验收。

## ROCm 开发依赖安装失败

若旧安装器在“安装语音组件”阶段提示 AMD ROCm 10.1 开发依赖失败，不要先认定是 Ubuntu 或 Python 版本不兼容。[AMD 官方索引](https://stable.repo.amd.com/rocm/core/whl-next/rocm/)的 `rocm==10.1.0` 元包有意只提供源码包，旧安装命令的 `--only-binary=:all:` 会将它排除，pip 因而报 `No matching distribution found for rocm==10.1.0`。

安装器现只为 `rocm` 添加 `--no-binary=rocm` 例外，SDK 核心、库、开发组件和 gfx1201 设备包仍限定官方 wheel、固定 10.1.0。构建元包前从 PyPI 单独安装固定 `setuptools==80.9.0`，再使用 `--no-build-isolation`，避免隔离构建自行选取变化的构建工具；不会混用 SDK 包索引或安装系统驱动。此源码修复需要重新构建并更新 Windows 应用；对尚未补齐依赖的环境，仅反复点击旧版“重试安装”不会改变其安装命令。

可用装有 pip 的测试 Python 运行 `python -m unittest discover -s tests -p test_speech_rocm_packaging.py -v`。该离线测试用本地假包验证旧命令失败、修正命令成功，以及 SDK 源码包仍被拒绝，不联网也不安装真实 GPU 包；没有 pip 时显式跳过，不代表完成实际安装。

2026-10-25 已在本机 Ubuntu 26.04 / Python 3.14.4 的默认托管环境实际执行修正后的安装器：ROCm 依赖安装、gfx1201 原生库编译、两份模型 SHA256 校验全部通过；生产检测器确认 RX 9070 XT 的 GPU 真算、原生 ABI、模型检查均通过（`environment_ok=true`、`models_ok=true`）。此次通过 WSL 直接调用安装器，没有保存 Windows 应用配置或验收 Tauri 页面、声音播放；应用内仍需通过安装流程完成检测保存。

## 已核实的硬件与实验结果

2026-10-24 的独立原生试听环境：RX 9070 XT（gfx1201）、Ubuntu 26.04.1 / WSL 2、内核 6.18.54.1、未改动的 Windows 驱动 32.0.32015.7029、ROCm 10.1.0 WSL Technical Preview。这不是其他显卡/驱动/发行版的兼容性承诺。

WSL 使用 `/dev/dxg` 和自动加载的 librocdxg，没有 `/dev/kfd` 是正常情况，不代表不支持 ROCm。参照 [AMD WSL 指南](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/wsl/howto_wsl.html)与 [ROCm 安装说明](https://rocm.docs.amd.com/en/latest/install/rocm.html)核对组合，不要为了旧 SDK 提示盲目更换主机驱动。

| 同台词实验 | 生成耗时 | 音频长度 |
| --- | ---: | ---: |
| 原生 GPU Q8，预热后试听 1 | 1.30 秒 | 2.96 秒 |
| 原生 GPU Q8，预热后试听 2 | 2.41 秒 | 5.28 秒 |
| 先前 CPU Q8 对照 1 | 10.37 秒 | 2.88 秒 |
| 先前 CPU Q8 对照 2 | 14.24 秒 | 4.72 秒 |

这是独立试听，不包含冷启动、安全服务和 Windows 桌宠完整链路。采样音频长度不同，不能当作严格基准或产品实时性保证；CPU 仅为历史对照，不是正式回退路径。

## 开发参考：默认 Python / GPU 环境

以下命令用于开发和排障，不是普通用户的安装步骤。设置页的安装流程负责自动编排依赖、原生构建与模型准备；手动命令不会由打开设置或刷新触发。

### ROCm（保留原有 gfx1201 路径）

在固定的默认虚拟环境中准备 ROCm 依赖；外部开发环境不能作为桌宠解释器，也不要直接移动虚拟环境。ROCm 10.x 的 `rocm_sdk` 模块由 `rocm-sdk-core` 包提供；一键安装末尾及后续“检测环境与模型”均执行实际 GPU/ABI 校验。

手动开发前先备好 Python、系统 C/C++ 编译工具、Git 和 curl，从本项目根目录开始：

~~~bash
export QWEN_RUNTIME="$HOME/.dsh-wsl-desktop/speech/runtime"
mkdir -p "$QWEN_RUNTIME"
python3.12 -m venv "$QWEN_RUNTIME/venv"
source "$QWEN_RUNTIME/venv/bin/activate"
python -m pip install -r services/qwen_tts/requirements.txt
rocm-sdk init
export ROCM_PATH="$(rocm-sdk path --root)"
export HIP_PATH="$ROCM_PATH"
export LD_LIBRARY_PATH="$ROCM_PATH/lib:/usr/lib/wsl/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
~~~

[运行依赖](<services/qwen_tts/requirements.txt>)使用 AMD 官方 pip 索引的 `rocm[libraries,device-gfx1201]==10.1.0`，只运行已有原生库不需要 devel。SDK 聚合包可能带入未用于本路径的库，包括 MIOpen；这不代表采用 MIOpen 推理。

构建原生库才额外安装同版本开发组件；CMake 3.31.6 放在独立工具 venv，也可使用已有用户级 CMake：

~~~bash
python -m pip install --index-url https://stable.repo.amd.com/rocm/whl-next/ \
  'rocm[libraries,devel,device-gfx1201]==10.1.0'
rocm-sdk init
export ROCM_PATH="$(rocm-sdk path --root)"
export HIP_PATH="$ROCM_PATH"
python3.12 -m venv "$QWEN_RUNTIME/build-tools"
"$QWEN_RUNTIME/build-tools/bin/python" -m pip install \
  --index-url https://pypi.org/simple 'cmake==3.31.6'
export CMAKE="$QWEN_RUNTIME/build-tools/bin/cmake"
~~~

真实 HIP 编译器在 `$ROCM_PATH/lib/llvm/bin/clang++`，CMake 配置在 `$ROCM_PATH/lib/cmake`；不能只看 PATH 中的包装器。初始化后的 SDK 根目录必须保留，运行时仍依赖它。

### CUDA（NVIDIA，尚无实机验收）

CUDA 路径使用 ctypes 调用系统 NVIDIA driver API 和 cuBLAS，不需要 Torch、Qwen Python SDK 或 MIOpen。WSL 的 `libcuda.so.1` 来自 Windows NVIDIA 驱动；不要安装 Linux 显卡驱动或用 toolkit 的 stubs 目录充当运行库。一键安装从 NVIDIA 官方 redistrib 获取固定版本的用户级 CUDA toolkit（nvcc、头文件和开发库），无需选择 toolkit 目录；手动构建时须自己准备完整工具链，Python runtime wheels 不能替代编译器。

以下为 CUDA 依赖的手动排障命令；打开设置不会执行，只有显式安装才联网准备依赖：

~~~bash
export QWEN_RUNTIME="$HOME/.dsh-wsl-desktop/speech/runtime"
# 桌面语音只使用固定默认虚拟环境。
source "$QWEN_RUNTIME/venv/bin/activate"
python -m pip install -r services/qwen_tts/requirements-cuda.txt
export CUDA_HOME=/usr/local/cuda
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:$CUDA_HOME/targets/x86_64-linux/lib:/usr/lib/wsl/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
~~~

[CUDA 可选依赖](<services/qwen_tts/requirements-cuda.txt>)固定 CUDA 12 runtime 和 cuBLAS wheels；实际 native 库需使用与构建 toolkit 相容的库。使用 wheels 时须保留当前 venv 的 `site-packages/nvidia/cuda_runtime/lib` 和 `site-packages/nvidia/cublas/lib`；若动态链接器尚未配置它们，需显式加入 `LD_LIBRARY_PATH`（不能只安装包便认为外部 libqwen 的依赖一定可解析）。驱动版本、GPU 架构、toolkit 和外部原生库仍须完整验证。

一键安装中自动识别后端并准备匹配依赖，保存前和启动前执行真实 GPU、原生库和模型校验。运行时自动后端优先 CUDA0，再尝试 ROCm0；双 GPU 时原生库必须匹配实际选择的后端，不回退 CPU。

## 2. 固定版本原生库

上游 [ServeurpersoCom/qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp) 固定为 `5916bf7c79dbb4e66fc059cdc507a79a23a28bb4`，ggml 子模块 `cc5df49a6b878db2b68b9a7b45976e279594627d`，要求 C ABI 6。下列克隆也是显式联网操作，不获取模型：

~~~bash
export QWEN_SOURCE="$QWEN_RUNTIME/qwentts.cpp"
export QWEN_BUILD="$QWEN_RUNTIME/build-gfx1201"
git clone https://github.com/ServeurpersoCom/qwentts.cpp "$QWEN_SOURCE"
git -C "$QWEN_SOURCE" checkout --detach 5916bf7c79dbb4e66fc059cdc507a79a23a28bb4
git -C "$QWEN_SOURCE" submodule update --init --recursive
bash services/qwen_tts/build_native.sh \
  --source-dir "$QWEN_SOURCE" --build-dir "$QWEN_BUILD" \
  --backend rocm --sdk-root "$ROCM_PATH" --cmake "$CMAKE" --jobs 2
~~~

[构建辅助器](<services/qwen_tts/build_native.sh>)检查源码/子模块版本，不安装、不下载、不删除构建目录。等价手动命令如下，不要复用 CPU 构建缓存：

~~~bash
"$CMAKE" -S "$QWEN_SOURCE" -B "$QWEN_BUILD" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=/usr/bin/cc -DCMAKE_CXX_COMPILER=/usr/bin/c++ \
  -DCMAKE_HIP_COMPILER="$ROCM_PATH/lib/llvm/bin/clang++" \
  -DCMAKE_HIP_COMPILER_ROCM_ROOT="$ROCM_PATH" -DCMAKE_HIP_PLATFORM=amd \
  -DCMAKE_HIP_ARCHITECTURES=gfx1201 \
  -DCMAKE_PREFIX_PATH="$ROCM_PATH;$ROCM_PATH/lib/cmake" \
  -DCMAKE_INSTALL_PREFIX="$QWEN_BUILD/staging" \
  -DQWEN_SHARED=ON -DGGML_HIP=ON -DGGML_CUDA=OFF -DGGML_VULKAN=OFF \
  -DGGML_METAL=OFF -DGGML_SYCL=OFF -DGGML_BLAS=OFF -DGGML_STATIC=OFF \
  -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=OFF -DGGML_HIP_GRAPHS=OFF \
  -DGGML_HIP_NO_VMM=ON -DGGML_HIP_RCCL=OFF -DGGML_CUDA_FA=ON
"$CMAKE" --build "$QWEN_BUILD" --target qwen -j 2
~~~

HIP graphs 和 VMM 关闭。虽编译 FA 内核，运行时 `use_fa=False`，不启用 FlashAttention。产物 `$QWEN_BUILD/libqwen.so` 必须保留同目录 `libggml*.so` 及对应 SDK 树。**不能只复制一个 SO 就称为可移植运行时**；构建 RPATH 可能引用原目录，移动后需重建或重新验证动态库解析。

### CUDA 原生构建

复用上文相同的固定源码与 ggml 子模块，不复用 ROCm/CPU 构建目录：

~~~bash
export QWEN_BUILD="$QWEN_RUNTIME/build-cuda"
bash services/qwen_tts/build_native.sh \
  --backend cuda --source-dir "$QWEN_SOURCE" --build-dir "$QWEN_BUILD" \
  --cuda-root "$CUDA_HOME" --nvcc "$CUDA_HOME/bin/nvcc" \
  --cuda-architectures native --cmake "$CMAKE" --jobs 2
~~~

CUDA 设置为 `GGML_CUDA=ON`、`GGML_HIP=OFF`，不调用 rocm-sdk。toolkit 可由 `--cuda-root` 或 `CUDAToolkit_ROOT` / `CUDA_HOME` / `CUDA_PATH` 指定，nvcc 可由 `--nvcc` / `CUDACXX` / PATH 指定。`--cuda-architectures` 默认 `native`，需要可见 NVIDIA GPU；离线交叉构建时请显式填写目标工具链支持的架构列表（如 `'86;89'`，不是通用显卡兼容性承诺）。没有 NVIDIA 机器时不得以 AMD 的 gfx1201 作为 CUDA 架构。

省略构建目录时，CUDA 使用源码旁 `build-dsh-cuda`，ROCm 保留 `build-dsh-rocm-gfx1201`。脚本拒绝切换后端复用 CMake 缓存，不删除已有文件；仍严格检查固定 commit、ggml gitlink/子模块及 tracked 改动，且不开启下载。CUDA 产物同样须保留相邻 `libggml*.so`、toolkit/运行库目录，不能只复制一个 SO。

**本次仅完成离线参数/CMake 选项、元数据与安全边界测试；没有 NVIDIA 实机 CUDA 编译、分配/计算或 Q8 合成验收，不声称 Windows 桌宠全链路通过。**

## 3. 显式下载两个 Q8 GGUF 文件

模型来自 [Serveurperso/Qwen3-TTS-GGUF 固定版本](https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/tree/b7ee2e8c7459c3bea99da23e3d178125a7d1713c)，revision `b7ee2e8c7459c3bea99da23e3d178125a7d1713c`；不使用旧 Python/PyTorch 权重目录。先自行核对许可与磁盘空间，再主动下载：

~~~bash
export DSH_QWEN_MODEL_DIR="$HOME/.dsh-wsl-desktop/speech/models/qwen3-tts-q8"
mkdir -p "$DSH_QWEN_MODEL_DIR"
export QWEN_MODEL_URL=https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/resolve/b7ee2e8c7459c3bea99da23e3d178125a7d1713c
curl -fL "$QWEN_MODEL_URL/qwen-talker-1.7b-base-Q8_0.gguf" \
  -o "$DSH_QWEN_MODEL_DIR/qwen-talker-1.7b-base-Q8_0.gguf"
curl -fL "$QWEN_MODEL_URL/qwen-tokenizer-12hz-Q8_0.gguf" \
  -o "$DSH_QWEN_MODEL_DIR/qwen-tokenizer-12hz-Q8_0.gguf"
(cd "$DSH_QWEN_MODEL_DIR" && printf '%s\n' \
  '4b9a33a236908dd9435a42f7a396e38038329d053b704342a6413c08544c4fda  qwen-talker-1.7b-base-Q8_0.gguf' \
  '1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94  qwen-tokenizer-12hz-Q8_0.gguf' \
  | sha256sum --check)
~~~

文件分别为 2,079,448,256 与 291,150,624 字节，合计约 **2.21 GiB 磁盘权重**，不是 RAM/VRAM 需求。一键安装下载到固定默认目录并校验 SHA256；已存在的匹配文件可复用。打开页面和普通语音服务不会隐式下载。

## 4. 设置与桌宠使用

在“设置 → 桌面宠物 → 本地千问语音”中：

1. 沿用启动器配置的 WSL 发行版和用户，点击“一键安装”。环境与目录由程序管理，无需选择模型或原生库。音色固定，自动后端优先 CUDA0、其次 ROCm0。
2. 安装末尾自动检查真实 CUDA driver / cuBLAS 或 HIP / hipBLAS 计算、固定原生 ABI 和两份模型 SHA256，通过才保存配置，无需另点保存。后续可单独“检测环境与模型”；环境未通过时不会将模型标为文件损坏。
3. “启动语音”启动本应用托管的安全桥并加载模型和完整参考；状态分别显示环境、文件、服务、模型与归属。健康检查成功不冒充模型已就绪。启动早期和模型加载期间也可停止。
4. 点击“试听”播放固定短句。最近试听只在真实播放自然结束后显示完成，取消和失败分别显示；本页播放权限不等于桌宠 WebView 已解锁，桌宠首次播放仍可能需要点击“朗读”。
5. “停止并释放显存”先作废本应用的播放与排队，再结束所托管的服务和模型进程。外部手动服务只读显示，不接管、不按端口猜 PID 强杀。更改运行时/模型路径前先停止服务；自动朗读和音量仍可单独调整。

界面可见时只做轻量状态刷新，离开后停止轮询并取消本页检测/试听。自动朗读默认关闭，音量只影响本应用。应用只将小型桥接脚本及已批准参考音频部署到当前 WSL 用户的私有缓存，不部署 SDK 或模型权重。托管进程通过私有 stdin 生命周期与启动器绑定，正常退出或控制通道断开时释放所属进程组，不影响 DSH。

### 手动服务兼容方式

以下 CLI 保留给已有外部环境。外部服务若未提供新状态协议，只能确认服务身份，模型状态保持未知，不能据此显示就绪。

同一 WSL 环境、项目根目录中：

~~~bash
export DSH_QWEN_NATIVE_LIB="$QWEN_BUILD/libqwen.so"
python services/qwen_tts/server.py \
  --model-dir "$DSH_QWEN_MODEL_DIR" \
  --native-lib "$DSH_QWEN_NATIVE_LIB" --device ROCm0 --port 18765
~~~

也可在 `--model-dir <GGUF目录> --native-lib <外部构建目录/libqwen.so>` 填绝对路径，或用 `DSH_QWEN_MODEL_DIR` / `DSH_QWEN_NATIVE_LIB` 环境变量。没有仓库临时目录默认值。CLI 不提供 `--threads`，当前 C ABI 不能设置线程数。默认自动选择 CUDA0 优先、ROCm0 次之；可显式使用 `--device CUDA0` 或 `--device ROCm0`，配置失败不回退 CPU 或旧 Windows Python。上例固定 ROCm0，NVIDIA 环境应改用 CUDA0。

1. 确认服务监听 `http://127.0.0.1:18765`；Windows 还须能访问 WSL localhost 转发。WSL 内 health 成功不等于 Windows 可达或模型/播放成功。
2. 用当前源码构建并运行桌面应用；旧安装版本不会随源码更新。本文不声称已有新 Windows 安装包。
3. 回复气泡点击“朗读”，生成时可点“停止朗读”；自动朗读在原右键菜单，仍默认关闭，不新增播放器或设置项。
4. 首次播放须点击“朗读”或主动开启自动朗读以解锁 Web Audio。仅有上次保存开关而没有本次播放权限时，先提示手动点击，不提前合成。

服务未启动、库/模型不匹配或 GPU 不可用时，错误只在气泡内显示，正文和聊天发送仍可用，不悄悄换系统声。跨台词声线一致性仍须持续试听，文件校验不能替代听感验收。

## 停止、取消与安全

- 停止立即断开音频源并作废结果；原生按唯一请求 ID 取消，迟到结果不能重新播放。隐藏、切换会话、新问题/审批及生命周期销毁沿用现有 guard；不取消 DSH 任务。
- 安全服务与模型进程隔离，原生推理通过 C ABI 协作取消。加载或不可协作阶段超过宽限仍可终止子进程，下次重新加载；取消接口应答快不代表 GPU 同时完全停止。
- 单请求含排队最长 180 秒，最多一个生成、一个排队。前端每段不超过 60 个 Unicode 字符，逐段生成播放，不预取全文；服务每次不超过 80 字符。
- WAV 为 PCM16 单声道 24 kHz，不超过 30 秒 / 2 MiB；token 上限截断须失败，不冒充完整回复。正文超过 400 字不自动读，仍可手动逐段读。
- 服务只绑定 127.0.0.1:18765，拒绝 Origin、意外 Host、非 JSON、超长/未知字段和分块请求。浏览器不直连，只有已验证桌宠 WebView 获得两个专用 IPC 权限；原生 HTTP 禁用代理、拒绝重定向，校验服务身份、固定 profile 与 WAV 边界。
- 不记录朗读文字；数据会进入进程/GPU 内存，不承诺安全擦除或 OS 网络沙箱。外部原生库是可执行代码，只配置可信来源。见[隐私说明](<PRIVACY.md>)。
- 退出桌面应用会取消本应用语音并停止自己托管的语音服务；不会代为关闭外部手动服务。外部模式仍由原终端 Ctrl+C 退出。托管身份凭随机 secret、实例标识、用户、启动时间及进程组校验，不仅凭端口或 PID。

## 验证边界与待验收项

~~~bash
node --test tests/assistant-ui.test.mjs tests/pet-qwen-speech.test.mjs
python3 -m unittest discover -s tests -p 'test_qwen*.py' -v
python3 -m unittest discover -s tests -p 'test_speech_resources.py' -v
# test_qwen*.py 包含离线 native 构建参数/CMake fixture；不会实际编译 CUDA。
npm test
npm run build
~~~

假引擎、ctypes 替身与浏览器模拟 IPC 只验证协议/状态；另已完成本机真实 Q8/ROCm 安全桥联调：

- 原生 Rust 传输 → `127.0.0.1:18765` 安全服务 → ctypes/C ABI → RX 9070 XT，完整参考 ICL 合成通过；5.28 秒音频的冷请求约 11.99 秒、模型常驻后约 2.43 秒。
- 实际 GPU 工作线程的协作取消约 24 毫秒返回 409，无半截音频；保留同一上下文后成功重试。生产 HTTP 生成中取消和后续恢复也通过，不能把 HTTP 应答时间当成 GPU 停止时间。
- Windows 宿主通过 localhost 转发取得了真实 WAV；这里只运行 HTTP 客户端，模型仍在 WSL。这仍不等于 Tauri 窗口点击和声卡播放验收。
- 当前版本前端 690 项、Rust 离线 277 项、Python 225 项通过；默认忽略的真实 GPU 原生传输测试已显式执行 1 项通过。生产前端构建、Windows MSVC 目标 `cargo check --tests` 与格式检查通过，后者不是完整 Windows 安装包构建。

可选真实传输测试只在已经启动独立服务时显式运行，普通测试不会加载模型：

~~~bash
DSH_QWEN_LIVE_TEST=1 cargo test --manifest-path src-tauri/Cargo.toml --lib \
  assistant_speech::tests::live_wsl_rocm_transport_synthesizes_and_cancels \
  -- --ignored --exact --nocapture
~~~

以上是本机单次集成结果，不承诺所有驱动组合或长文本耗时。首次校验与加载两份权重、参考提取不属于热生成时间。

迁移前基线记录前端 690 项、Rust 277 项、Python 172 项（含 29 项旧服务测试）通过；旧 Python/PyTorch 服务生成与取消恢复、Windows 到 WSL health、Chromium 隔离页 Web Audio 分别验证。页面模拟 IPC 回包，**不是 Windows Tauri 桌宠验收**；旧服务耗时和历史测试数量不代表当前 Q8/ROCm 版本结果。

发布前仍须验证 Windows Tauri 一键安装、取消重试、真实手动/自动朗读与播放权限、退出与恢复、跨台词音色，以及全桥接延迟与资源占用。安装流程管理用户级依赖、原生构建与模型；自动安装 WSL、系统驱动、多音色、克隆面板及语速音调等功能不在当前范围。
