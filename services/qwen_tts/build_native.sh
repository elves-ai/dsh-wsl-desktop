#!/usr/bin/env bash
# Explicit, non-installing build of the pinned external WSL GPU runtime.
set -euo pipefail
fail() { printf 'Qwen native build: %s\n' "$*" >&2; exit 2; }
usage() { printf '%s\n' \
 'Usage: bash build_native.sh --source-dir PATH [--backend rocm|cuda] [--build-dir PATH] [--cmake EXECUTABLE] [--jobs 1..8]' \
 'ROCm (default): [--sdk-root PATH]' \
 'CUDA: [--cuda-root PATH] [--nvcc EXECUTABLE] [--cuda-architectures native|all|all-major|LIST]' \
 'Clone the documented pinned qwentts.cpp source yourself; this script downloads nothing, installs nothing, and never deletes a build directory.'; }
source_dir= build_dir= sdk_root= cuda_root= nvcc_bin= cuda_arch= backend=rocm cmake_bin=cmake jobs=2
while (($#)); do
 case "$1" in
  --help|-h) usage; exit 0 ;;
  --source-dir|--build-dir|--sdk-root|--cuda-root|--nvcc|--cuda-architectures|--backend|--cmake|--jobs)
   (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || fail "missing value for $1"
   case "$1" in
    --source-dir) source_dir=$2;; --build-dir) build_dir=$2;;
    --sdk-root) sdk_root=$2;; --cuda-root) cuda_root=$2;; --nvcc) nvcc_bin=$2;;
    --cuda-architectures) cuda_arch=$2;; --backend) backend=$2;;
    --cmake) cmake_bin=$2;; --jobs) jobs=$2;;
   esac
   shift 2 ;;
  *) fail "unknown option: $1" ;;
 esac
done
[[ "$backend" == rocm || "$backend" == cuda ]] || fail '--backend must be cuda or rocm'
[[ -n "$source_dir" && -d "$source_dir" ]] || fail '--source-dir must name the external pinned source checkout'
[[ "$jobs" =~ ^[1-8]$ ]] || fail '--jobs must be 1..8 (default 2 limits build memory)'
if [[ "$backend" == cuda ]]; then
 [[ -z "$sdk_root" ]] || fail '--sdk-root is ROCm-only; use --cuda-root'
 cuda_arch=${cuda_arch:-native}
 [[ "$cuda_arch" =~ ^(native|all|all-major|[0-9]+(-real|-virtual)?(;[0-9]+(-real|-virtual)?)*)$ ]] || fail 'invalid --cuda-architectures'
else
 [[ -z "$cuda_root$nvcc_bin$cuda_arch" ]] || fail 'CUDA options require --backend cuda'
fi
source_dir=$(realpath -e -- "$source_dir")
[[ $(git -C "$source_dir" rev-parse --show-toplevel) == "$source_dir" ]] || fail 'source must be a checkout root'
[[ $(git -C "$source_dir" rev-parse HEAD) == 5916bf7c79dbb4e66fc059cdc507a79a23a28bb4 ]] || fail 'qwentts.cpp revision does not match the supported ABI6 build'
[[ -d "$source_dir/ggml" && $(git -C "$source_dir/ggml" rev-parse --show-toplevel) == "$source_dir/ggml" ]] || fail 'ggml submodule is not initialized'
[[ $(git -C "$source_dir" ls-tree HEAD -- ggml) == $'160000 commit cc5df49a6b878db2b68b9a7b45976e279594627d	ggml' ]] || fail 'pinned ggml gitlink does not match'
[[ $(git -C "$source_dir/ggml" rev-parse HEAD) == cc5df49a6b878db2b68b9a7b45976e279594627d ]] || fail 'ggml submodule revision does not match'
submodules=$(git -C "$source_dir" submodule status --recursive)
while IFS= read -r line; do
 [[ -z "$line" || "$line" == ' '* ]] || fail 'submodule is uninitialized, conflicted or at an unpinned revision'
done <<< "$submodules"
git -C "$source_dir" diff --quiet && git -C "$source_dir" diff --cached --quiet || fail 'native source checkout has tracked modifications'
git -C "$source_dir/ggml" diff --quiet && git -C "$source_dir/ggml" diff --cached --quiet || fail 'ggml checkout has tracked modifications'
backend_args=()
if [[ "$backend" == rocm ]]; then
 if [[ -z "$sdk_root" ]]; then sdk_root=$(rocm-sdk path --root); fi
 sdk_root=$(realpath -e -- "$sdk_root")
 [[ -x "$sdk_root/lib/llvm/bin/clang++" && -f "$sdk_root/lib/cmake/hip-lang/hip-lang-config.cmake" ]] || fail 'SDK development tree is not initialized; install matching rocm[devel] and run rocm-sdk init'
 [[ -n "$build_dir" ]] || build_dir="$source_dir/build-dsh-rocm-gfx1201"
 export ROCM_PATH="$sdk_root" HIP_PATH="$sdk_root"
 export LD_LIBRARY_PATH="$sdk_root/lib:/usr/lib/wsl/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
 backend_args=(-DGGML_HIP=ON -DGGML_CUDA=OFF
  "-DCMAKE_HIP_COMPILER=$sdk_root/lib/llvm/bin/clang++" "-DCMAKE_HIP_COMPILER_ROCM_ROOT=$sdk_root"
  -DCMAKE_HIP_PLATFORM=amd -DCMAKE_HIP_ARCHITECTURES=gfx1201
  "-DCMAKE_PREFIX_PATH=$sdk_root;$sdk_root/lib/cmake"
  -DGGML_HIP_GRAPHS=OFF -DGGML_HIP_NO_VMM=ON -DGGML_HIP_RCCL=OFF)
else
 cuda_root=${cuda_root:-${CUDAToolkit_ROOT:-${CUDA_HOME:-${CUDA_PATH:-}}}}
 nvcc_bin=${nvcc_bin:-${CUDACXX:-}}
 if [[ -z "$nvcc_bin" ]]; then
  if [[ -n "$cuda_root" ]]; then nvcc_bin="$cuda_root/bin/nvcc"; else nvcc_bin=$(command -v nvcc) || fail 'nvcc not found; specify --nvcc or --cuda-root'; fi
 fi
 nvcc_bin=$(command -v -- "$nvcc_bin") || fail 'nvcc executable not found'
 nvcc_bin=$(realpath -e -- "$nvcc_bin")
 [[ -x "$nvcc_bin" ]] || fail 'nvcc must be executable'
 [[ -n "$cuda_root" ]] || cuda_root=$(dirname "$(dirname "$nvcc_bin")")
 cuda_root=$(realpath -e -- "$cuda_root")
 [[ -f "$cuda_root/include/cuda_runtime.h" || -f "$cuda_root/targets/x86_64-linux/include/cuda_runtime.h" ]] || fail 'CUDA toolkit development headers not found'
 [[ -n "$build_dir" ]] || build_dir="$source_dir/build-dsh-cuda"
 export LD_LIBRARY_PATH="$cuda_root/lib64:$cuda_root/targets/x86_64-linux/lib:/usr/lib/wsl/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
 backend_args=(-DGGML_CUDA=ON -DGGML_HIP=OFF "-DCMAKE_CUDA_COMPILER=$nvcc_bin"
  "-DCUDAToolkit_ROOT=$cuda_root" "-DCMAKE_CUDA_ARCHITECTURES=$cuda_arch")
fi
build_dir=$(realpath -m -- "$build_dir")
[[ "$build_dir" != / && "$build_dir" != "$source_dir" && "$build_dir" != "$source_dir/ggml" && "$build_dir" != "$source_dir/ggml/"* && "$source_dir" != "$build_dir/"* ]] || fail 'use a separate build directory, not the source or its ancestor'
# Never repurpose another backend's cache, even when --build-dir is explicit.
if [[ -f "$build_dir/CMakeCache.txt" ]]; then
 cache_backend_seen=false
 while IFS= read -r line; do
  case "$line" in
   GGML_HIP:BOOL=ON) [[ "$backend" == rocm ]] || fail 'ROCm cache cannot be reused for CUDA'; cache_backend_seen=true;;
   GGML_CUDA:BOOL=ON) [[ "$backend" == cuda ]] || fail 'CUDA cache cannot be reused for ROCm'; cache_backend_seen=true;;
   GGML_HIP:BOOL=OFF) [[ "$backend" != rocm ]] || fail 'non-ROCm cache; use a fresh build directory';;
   GGML_CUDA:BOOL=OFF) [[ "$backend" != cuda ]] || fail 'non-CUDA cache; use a fresh build directory';;
   CMAKE_HOME_DIRECTORY:INTERNAL=*) [[ ${line#*=} == "$source_dir" ]] || fail 'cache belongs to another source checkout';;
   CMAKE_CUDA_COMPILER:FILEPATH=*) [[ "$backend" != cuda || ${line#*=} == "$nvcc_bin" ]] || fail 'cache belongs to another nvcc';;
  esac
 done < "$build_dir/CMakeCache.txt"
 [[ "$cache_backend_seen" == true ]] || fail 'cache has no matching GPU backend; use a fresh build directory'
fi
"$cmake_bin" -S "$source_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release \
 -DCMAKE_C_COMPILER=/usr/bin/cc -DCMAKE_CXX_COMPILER=/usr/bin/c++ \
 "-DCMAKE_INSTALL_PREFIX=$build_dir/staging" \
 -DFETCHCONTENT_FULLY_DISCONNECTED=ON -DGGML_CCACHE=OFF -DGGML_OPENMP_FETCH=OFF \
 -DQWEN_SHARED=ON -DGGML_VULKAN=OFF -DGGML_METAL=OFF -DGGML_SYCL=OFF \
 -DGGML_BLAS=OFF -DGGML_STATIC=OFF -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=OFF \
 -DGGML_CUDA_FA=ON "${backend_args[@]}"
"$cmake_bin" --build "$build_dir" --target qwen -j "$jobs"
printf 'Native library: %s/libqwen.so\nKeep adjacent libggml*.so and the matching external GPU toolkit/SDK libraries. No model weights were downloaded.\n' "$build_dir"
