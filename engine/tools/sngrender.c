//
// sngrender: render a GoatTracker .sng to WAV and/or a SID register log
//
// Usage: sngrender song.sng [options]
//   -o file.wav   write audio (mono 16-bit)
//   -r file.txt   write SID registers after every frame, one line per frame
//   -s seconds    length to render (default 60)
//   -n subsong    subsong number (default 0)
//   -m model      0 = 6581, 1 = 8580 (default 0)
//   -i mode       reSID interpolation as GoatTracker's -I (default 0)
//   -t rate       sample rate (default 44100)
//

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sidkid.h"

static void writele16(FILE *f, unsigned v)
{
  fputc(v & 0xff, f);
  fputc((v >> 8) & 0xff, f);
}

static void writele32(FILE *f, unsigned v)
{
  writele16(f, v & 0xffff);
  writele16(f, v >> 16);
}

static void writewavheader(FILE *f, int rate, unsigned datasize)
{
  fwrite("RIFF", 4, 1, f);
  writele32(f, 36 + datasize);
  fwrite("WAVEfmt ", 8, 1, f);
  writele32(f, 16);
  writele16(f, 1);        // PCM
  writele16(f, 1);        // mono
  writele32(f, rate);
  writele32(f, rate * 2);
  writele16(f, 2);
  writele16(f, 16);
  fwrite("data", 4, 1, f);
  writele32(f, datasize);
}

int main(int argc, char **argv)
{
  const char *songpath = NULL;
  const char *wavpath = NULL;
  const char *regpath = NULL;
  double seconds = 60.0;
  int subsong = 0;
  int model = 0;
  int interpolate = 0;
  int rate = 44100;
  FILE *wav = NULL;
  FILE *reg = NULL;
  unsigned datasize = 0;
  long totalsamples;
  long done = 0;
  static short buf[SK_MAX_FRAME_SAMPLES];
  int c;

  for (c = 1; c < argc; c++)
  {
    if ((argv[c][0] == '-') && (c + 1 < argc))
    {
      const char *v = argv[++c];
      switch (argv[c-1][1])
      {
        case 'o': wavpath = v; break;
        case 'r': regpath = v; break;
        case 's': seconds = atof(v); break;
        case 'n': subsong = atoi(v); break;
        case 'm': model = atoi(v); break;
        case 'i': interpolate = atoi(v); break;
        case 't': rate = atoi(v); break;
        default:
          fprintf(stderr, "Unknown option %s\n", argv[c-1]);
          return 1;
      }
    }
    else songpath = argv[c];
  }

  if (!songpath)
  {
    fprintf(stderr, "Usage: sngrender song.sng [-o out.wav] [-r regs.txt] [-s seconds] [-n subsong] [-m model] [-i interp] [-t rate]\n");
    return 1;
  }

  sk_init(rate, model, 0, interpolate);
  if (!sk_load_song(songpath))
  {
    fprintf(stderr, "Could not load %s\n", songpath);
    return 1;
  }
  fprintf(stderr, "\"%s\" by %s (%s), %d subsong(s)\n",
    sk_song_name(), sk_author_name(), sk_copyright_name(), sk_num_subsongs());

  if (wavpath)
  {
    wav = fopen(wavpath, "wb");
    if (!wav)
    {
      fprintf(stderr, "Could not write %s\n", wavpath);
      return 1;
    }
    writewavheader(wav, rate, 0);
  }
  if (regpath)
  {
    reg = fopen(regpath, "w");
    if (!reg)
    {
      fprintf(stderr, "Could not write %s\n", regpath);
      return 1;
    }
  }

  sk_play(subsong);
  totalsamples = (long)(seconds * rate);
  while (done < totalsamples)
  {
    int n = sk_render_frame(buf);

    if (n <= 0) break;
    if (n > totalsamples - done) n = totalsamples - done;
    if (wav)
    {
      fwrite(buf, sizeof(short), n, wav);
      datasize += n * sizeof(short);
    }
    if (reg)
    {
      const unsigned char *r = sk_sidregs();
      int d;
      for (d = 0; d < 25; d++)
        fprintf(reg, d ? " %02x" : "%02x", r[d]);
      fputc('\n', reg);
    }
    done += n;
  }

  if (wav)
  {
    fseek(wav, 0, SEEK_SET);
    writewavheader(wav, rate, datasize);
    fclose(wav);
  }
  if (reg) fclose(reg);
  fprintf(stderr, "Rendered %.1f seconds\n", (double)done / rate);
  return 0;
}
