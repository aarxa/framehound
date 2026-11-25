#!/bin/bash
# Smoke test for the Vulkan layer: capture from the test scene in each of its modes under the Khronos validation layer,
# and fail if the layer keeps no broken frames or adds a validation error the scene doesn't have on its own.
#
#   native/check.sh [build folder]      (default native/build)
set -euo pipefail
build=${1:-native/build}
out=$(mktemp -d)
if [ "$(uname)" = Darwin ]; then
  export DYLD_LIBRARY_PATH=${DYLD_LIBRARY_PATH:-/opt/homebrew/lib}  # where Homebrew's validation layer lives
fi
vuids() { grep -o "VUID-[A-Za-z0-9_-]*" | sort -u || true; }
# no errors only means something if the validation layer is really there
loaded=$(VK_LOADER_DEBUG=layer VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation "$build/fh_scene" --frames 1 2>&1 || true)
if ! grep -q 'Insert instance layer "VK_LAYER_KHRONOS_validation"' <<< "$loaded"; then
  echo "the Khronos validation layer didn't load"
  exit 1
fi
status=0
for mode in default --indirect --secondary --submit2 --timeline; do
  flag=$([ "$mode" = default ] && echo "" || echo "$mode")
  alone=$(VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation "$build/fh_scene" --frames 40 $flag 2>&1 | vuids)
  with=$(VK_ADD_LAYER_PATH="$build" VK_INSTANCE_LAYERS=VK_LAYER_FRAMEHOUND_glitch:VK_LAYER_KHRONOS_validation \
    FRAMEHOUND_OUT="$out/$mode" FRAMEHOUND_START=10 FRAMEHOUND_EVERY=20 FRAMEHOUND_CAPTURES=2 \
    "$build/fh_scene" --frames 40 $flag 2>&1 | vuids)
  added=$(comm -13 <(echo "$alone") <(echo "$with") | tr '\n' ' ')
  kept=$(wc -l < "$out/$mode/manifest.jsonl" 2>/dev/null | tr -d " " || echo 0)
  echo "$mode: $kept broken frames kept; validation errors added by the layer: ${added:-none}"
  if [ -n "${added// /}" ] || [ "$kept" -eq 0 ]; then status=1; fi
done
echo "output in $out"
exit $status
