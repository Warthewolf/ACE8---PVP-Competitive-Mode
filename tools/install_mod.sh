#!/bin/sh
# install_mod.sh : copies the RVNG mod (its Lua scripts and build/native/main.dll) into the game's UE4SS Mods folder.
#   AC8_DIR=<ACE COMBAT 8's install folder> sh tools/install_mod.sh
#   PROBE=1 also turns the in-game test logger on in the installed rvng_test.ini (docs/IN_GAME_TESTS.md).
# An rvng_test.ini already in the installed mod is kept, so a tester's settings survive a reinstall.
# To uninstall, delete <game>/Game/Binaries/Win64/ue4ss/Mods/ProjectRVNG.
set -e
cd "$(dirname "$0")/.."
[ -n "$AC8_DIR" ] || { echo "set AC8_DIR to ACE COMBAT 8's install folder" >&2; exit 1; }
MODS="$AC8_DIR/Game/Binaries/Win64/ue4ss/Mods"
[ -d "$MODS" ] || { echo "no UE4SS Mods folder at $MODS" >&2; exit 1; }
[ -f build/native/main.dll ] || { echo "build the DLL first: sh native/build.sh" >&2; exit 1; }
DST="$MODS/ProjectRVNG"
mkdir -p "$DST/Scripts" "$DST/dlls"
cp mod/ProjectRVNG/Scripts/*.lua "$DST/Scripts/"
cp mod/ProjectRVNG/enabled.txt "$DST/"
cp build/native/main.dll "$DST/dlls/main.dll"
[ -f "$DST/rvng_test.ini" ] || cp mod/ProjectRVNG/rvng_test.ini "$DST/"
if [ "$PROBE" = 1 ]; then sed -i 's/^probe=.*/probe=1/' "$DST/rvng_test.ini"; fi
echo "installed to $DST ($(sed -n 's/^probe=//p' "$DST/rvng_test.ini" | head -1 | sed 's/^1$/test logger on/; s/^0$/test logger off/'))"
