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

# compare name song.sng [sngrender options...]
compare() {
  name=$1
  song=$2
  shift 2
  "$NEW" "$song" -s "$LENGTH" -r "$OUT/$name.new.txt" -o "$OUT/$name.new.wav" "$@" 2>/dev/null
  "$REF" "$song" -s "$LENGTH" -r "$OUT/$name.ref.txt" -o "$OUT/$name.ref.wav" "$@" 2>/dev/null
  if cmp -s "$OUT/$name.new.txt" "$OUT/$name.ref.txt" && cmp -s "$OUT/$name.new.wav" "$OUT/$name.ref.wav"; then
    printf "  ok    %-24s %6d frames\n" "$name" "$(wc -l < "$OUT/$name.new.txt")"
  else
    printf "  FAIL  %-24s first differing frame: %s\n" "$name" \
      "$(cmp "$OUT/$name.new.txt" "$OUT/$name.ref.txt" | sed 's/.*line //')"
    fail=1
  fi
}

for song in "$EXAMPLES"/*.sng; do
  compare "$(basename "$song" .sng)" "$song"
done

# Player options, with the songs that need them
compare 2xtest-speed2 "$EXAMPLES/2xtest.sng" -S 2
compare tempo2test-nopulseopt "$EXAMPLES/tempo2test.sng" -O 0
compare dojo-ntsc "$EXAMPLES/dojo.sng" -N 1
compare dojo-halfspeed-adsr "$EXAMPLES/dojo.sng" -S 0 -A 0000 -R 0

exit $fail
