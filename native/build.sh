#!/bin/sh
# build.sh : builds RVNG's native runtime (a UE4SS C++ mod) with LLVM only: no Windows SDK, no C runtime.
# Output: build/native/main.dll, which goes to <game>/Game/Binaries/Win64/ue4ss/Mods/ProjectRVNG/dlls/main.dll.
# LLVM: set LLVM_BIN to LLVM's bin folder (clang, lld-link, llvm-dlltool), or put LLVM on PATH.
set -e
export MSYS_NO_PATHCONV=1   # Git Bash would turn /dll etc. into paths
cd "$(dirname "$0")"
OUT=../build/native
mkdir -p "$OUT"
[ -n "$LLVM_BIN" ] && PATH="$LLVM_BIN:$PATH"
command -v clang >/dev/null || { echo "clang not found: set LLVM_BIN to LLVM's bin folder" >&2; exit 1; }

for lib in kernel32 ue4ss ucrtheap; do
    llvm-dlltool -m i386:x86-64 -d $lib.def -l "$OUT/$lib.lib"
done

clang --target=x86_64-pc-windows-msvc -O2 -ffreestanding -fno-builtin -nostdlibinc \
      -fno-stack-protector -funwind-tables -Wall -Wextra -Werror \
      -c rvng_rt.c -o "$OUT/rvng_rt.obj"

VER=$(sed -n 's/^#define RT_VERSION_A *"\([^"]*\)".*/\1/p' rvng_rt.c)
lld-link /dll /nodefaultlib /entry:DllMain /subsystem:windows \
         /out:"$OUT/main.dll" /implib:"$OUT/main_exports.lib" /map:"$OUT/main_${VER:-unknown}.map" \
         "$OUT/rvng_rt.obj" "$OUT/kernel32.lib" "$OUT/ue4ss.lib" "$OUT/ucrtheap.lib"
echo "built $OUT/main.dll ($VER)"
