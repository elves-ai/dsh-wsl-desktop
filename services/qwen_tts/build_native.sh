#!/usr/bin/env bash
# Explicit, non-installing build of the pinned external WSL ROCm runtime.
set -euo pipefail
fail() { printf 'Qwen native build: %s\n' "$*" >&2; exit 2; }
usage() { printf '%s\n' 'Usage: bash build_native.sh --source-dir PATH [--build-dir PATH] [--sdk-root PATH] [--cmake EXECUTABLE] [--jobs 1..8]' 'Clone the documented pinned qwentts.cpp source yourself; this script downloads nothing, installs nothing, and never deletes a build directory.'; }
source_dir= build_dir= sdk_root= cmake_bin=cmake jobs=2
while (($#)); do
 case "$1" in
  --help|-h) usage; exit 0 ;;
  --source-dir|--build-dir|--sdk-root|--cmake|--jobs)
   (($# >= 2)) || fail "missing value for $1"
   case "$1" in
    --source-dir) source_dir=$2;; --build-dir) build_dir=$2;;
    --sdk-root) sdk_root=$2;; --cmake) cmake_bin=$2;; --jobs) jobs=$2;;
   esac
   shift 2 ;;
  *) fail "unknown option: $1" ;;
 esac
done
[[ -n "$source_dir" && -d "$source_dir" ]] || fail '--source-dir must name the external pinned source checkout'
[[ "$jobs" =~ ^[1-8]$ ]] || fail '--jobs must be 1..8 (default2 limits build memory)'
source_dir=$(realpath -e -- "$source_dir")
[[ $(git -C "$source_dir" rev-parse HEAD) == 5916bf7c79dbb4e66fc059cdc507a79a23a28bb4 ]] || fail 'qwentts.cpp revision does not match the supported ABI6 build'
[[ $(git -C "$source_dir/ggml" rev-parse HEAD) == cc5df49a6b878db2b68b9a7b45976e279594627d ]] || fail 'ggml submodule revision does not match'
git -C "$source_dir" diff --quiet && git -C "$source_dir" diff --cached --quiet || fail 'native source checkout has tracked modifications'
git -C "$source_dir/ggml" diff --quiet && git -C "$source_dir/ggml" diff --cached --quiet || fail 'ggml checkout has tracked modifications'
if [[ -z "$sdk_root" ]]; then sdk_root=$(rocm-sdk path --root); fi
sdk_root=$(realpath -e -- "$sdk_root")
[[ -x "$sdk_root/lib/llvm/bin/clang++" && -f "$sdk_root/lib/cmake/hip-lang/hip-lang-config.cmake" ]] || fail 'SDK development tree is not initialized; install matching rocm[devel] and run rocm-sdk init'
[[ -n "$build_dir" ]] || build_dir="$source_dir/build-dsh-rocm-gfx1201"
build_dir=$(realpath -m -- "$build_dir")
export ROCM_PATH="$sdk_root" HIP_PATH="$sdk_root"
export LD_LIBRARY_PATH="$sdk_root/lib:/usr/lib/wsl/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
"$cmake_bin" -S "$source_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release \
 -DCMAKE_C_COMPILER=/usr/bin/cc -DCMAKE_CXX_COMPILER=/usr/bin/c++ \
 -DCMAKE_HIP_COMPILER="$sdk_root/lib/llvm/bin/clang++" -DCMAKE_HIP_COMPILER_ROCM_ROOT="$sdk_root" \
 -DCMAKE_HIP_PLATFORM=amd -DCMAKE_HIP_ARCHITECTURES=gfx1201 \
 -DCMAKE_PREFIX_PATH="$sdk_root;$sdk_root/lib/cmake" -DCMAKE_INSTALL_PREFIX="$build_dir/staging" \
 -DFETCHCONTENT_FULLY_DISCONNECTED=ON -DGGML_CCACHE=OFF -DGGML_OPENMP_FETCH=OFF \
 -DQWEN_SHARED=ON -DGGML_HIP=ON -DGGML_CUDA=OFF -DGGML_VULKAN=OFF \
 -DGGML_METAL=OFF -DGGML_SYCL=OFF -DGGML_BLAS=OFF -DGGML_STATIC=OFF \
 -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=OFF -DGGML_HIP_GRAPHS=OFF \
 -DGGML_HIP_NO_VMM=ON -DGGML_HIP_RCCL=OFF -DGGML_CUDA_FA=ON
"$cmake_bin" --build "$build_dir" --target qwen -j "$jobs"
printf 'Native library: %s/libqwen.so\nKeep adjacent libggml*.so and the matching external SDK tree. No model weights were downloaded.\n' "$build_dir"
