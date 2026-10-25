#!/bin/sh
#
# Render every example song with two sngrender builds and compare the
# per-frame SID register logs and the audio.
#
# Usage: compare.sh new-sngrender ref-sngrender examples-dir out-dir

NEW=$1
REF=$2
EXAMPLES=$3
OUT=$4
LENGTH=${RENDER_SECONDS:-120}

mkdir -p "$OUT"
fail=0

for song in "$EXAMPLES"/*.sng; do
  name=$(basename "$song" .sng)
  "$NEW" "$song" -s "$LENGTH" -r "$OUT/$name.new.txt" -o "$OUT/$name.new.wav" 2>/dev/null
  "$REF" "$song" -s "$LENGTH" -r "$OUT/$name.ref.txt" -o "$OUT/$name.ref.wav" 2>/dev/null
  if cmp -s "$OUT/$name.new.txt" "$OUT/$name.ref.txt" && cmp -s "$OUT/$name.new.wav" "$OUT/$name.ref.wav"; then
    printf "  ok    %-20s %6d frames\n" "$name" "$(wc -l < "$OUT/$name.new.txt")"
  else
    printf "  FAIL  %-20s first differing frame: %s\n" "$name" \
      "$(cmp "$OUT/$name.new.txt" "$OUT/$name.ref.txt" | sed 's/.*line //')"
    fail=1
  fi
done

exit $fail
