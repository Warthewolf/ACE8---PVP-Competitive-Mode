#!/bin/sh
# run.sh : builds and runs tests/rt_test.c (offline checks of rvng_rt.c; no game, no UE4SS). Needs LLVM like build.sh.
set -e
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
OUT=../build/native/test
mkdir -p "$OUT"
[ -n "$LLVM_BIN" ] && PATH="$LLVM_BIN:$PATH"
# every Log format string uses only what vfmt.h supports (%s %d %u %x %p): anything else crashes the game (fmtcheck.py)
python -I ../tools/re/fmtcheck.py .
for lib in kernel32 ucrtheap; do
    llvm-dlltool -m i386:x86-64 -d $lib.def -l "$OUT/$lib.lib"
done
clang --target=x86_64-pc-windows-msvc -O1 -ffreestanding -fno-builtin -nostdlibinc \
      -fno-stack-protector -funwind-tables -Wall -Wextra -Werror -Wno-unused-function \
      -c tests/rt_test.c -o "$OUT/rt_test.obj"
lld-link /nodefaultlib /entry:TestMain /subsystem:console /out:"$OUT/rt_test.exe" \
         "$OUT/rt_test.obj" "$OUT/kernel32.lib" "$OUT/ucrtheap.lib"
"$OUT/rt_test.exe"
