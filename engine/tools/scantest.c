//
// scantest: checks sk_scan and sk_seek against normal playback
//
// Usage: scantest song.sng...
//
// For every row sk_scan reports, plays the song normally and checks that the
// voice really is on that pattern and has just read that row's note. Then
// checks that sk_seek lands where normal playback would be, by comparing the
// playroutine's register writes for a while after a few seek points.
//

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "goattrk2.h"
#include "sidkid.h"

#define MAX_EVENTS 200000
#define MAX_FRAMES 60000
#define SEEK_CHECK_FRAMES 300

static unsigned events[MAX_EVENTS * 2];
static unsigned char regs[MAX_FRAMES][25];
static short buffer[SK_MAX_FRAME_SAMPLES];

static int checksong(const char *path)
{
  int count, i, e, frame, lastframe;
  int rows[MAX_CHN] = {0};
  int errors = 0;
  const char *name = strrchr(path, '/') ? strrchr(path, '/') + 1 : path;

  if (!sk_load_song(path))
  {
    printf("  FAIL  %-24s could not load\n", name);
    return 1;
  }
  count = sk_scan(0, MAX_FRAMES, events, MAX_EVENTS);
  lastframe = count ? events[(count - 1) * 2] : 0;

  // Normal playback, checking each scanned row as its frame comes up
  sk_play(0);
  e = 0;
  for (frame = 1; frame <= lastframe; frame++)
  {
    sk_render_frame(buffer);
    if (sk_frames() != frame)
    {
      printf("  FAIL  %-24s frame counter %d, expected %d\n", name, sk_frames(), frame);
      return 1;
    }
    memcpy(regs[frame], sk_sidregs(), 25);
    for (; (e < count) && ((int)events[e * 2] == frame); e++)
    {
      int c = events[e * 2 + 1] & 0xff;
      int row = (events[e * 2 + 1] >> 8) & 0xff;
      int patt = events[e * 2 + 1] >> 16;
      unsigned char note = pattern[patt][row * 4];

      rows[c]++;
      if (chn[c].pattnum != patt)
      {
        if (errors++ < 5) printf("        %s frame %d voice %d: on pattern %d, scan says %d\n", name, frame, c, chn[c].pattnum, patt);
      }
      else if ((note <= LASTNOTE) && (chn[c].newnote != (unsigned char)(note + chn[c].trans)))
      {
        if (errors++ < 5) printf("        %s frame %d voice %d row %d: new note %02X, pattern has %02X+%d\n", name, frame, c, row, chn[c].newnote, note, (signed char)chn[c].trans);
      }
    }
  }
  if (e != count)
  {
    printf("        %s %d rows not in frame order\n", name, count - e);
    errors++;
  }

  // Seeking: the playroutine should write the same registers as it did when
  // it got there by playing
  for (i = 1; i <= 4; i++)
  {
    int target = lastframe * i / 5;
    int k;

    sk_seek(0, target);
    for (k = 1; k <= SEEK_CHECK_FRAMES && target + k <= lastframe; k++)
    {
      sk_render_frame(buffer);
      if ((sk_frames() != target + k) || memcmp(sk_sidregs(), regs[target + k], 25))
      {
        if (errors++ < 5) printf("        %s seek to %d: differs %d frames later\n", name, target, k);
        break;
      }
    }
  }

  printf("  %s  %-24s %6d rows %6d frames  (%d/%d/%d)\n", errors ? "FAIL" : "ok  ", name, count, lastframe, rows[0], rows[1], rows[2]);
  return errors != 0;
}

int main(int argc, char **argv)
{
  int c;
  int failed = 0;

  sk_init(44100, SK_MODEL_6581, 0, 0);
  for (c = 1; c < argc; c++) failed += checksong(argv[c]);
  return failed ? 1 : 0;
}
