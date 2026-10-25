//
// SIDKid engine API
//

#include "goattrk2.h"
#include "sidkid.h"

extern int timeframes;

static int samplerate = 44100;
static int frametempo = 125;

static short framebuf[SK_MAX_FRAME_SAMPLES];
static int framepos = 0;
static int framelen = 0;

int sk_init(int rate, int model, int usentsc, int interpolate)
{
  if (rate < MINMIXRATE) rate = MINMIXRATE;
  if (rate > MAXMIXRATE) rate = MAXMIXRATE;
  samplerate = rate;
  ntsc = usentsc ? 1 : 0;

  // Same tempo as gsound.c: BME calls the player every
  // (rate * 5 / 2) / tempo samples, i.e. 50 Hz PAL or 60 Hz NTSC.
  if (multiplier)
    frametempo = (ntsc ? 150 : 125) * multiplier;
  else
    frametempo = (ntsc ? 150 : 125) / 2;

  initchannels();
  clearsong(1,1,1,1,1);
  sid_init(samplerate, model == SK_MODEL_8580, ntsc, interpolate & 1, 0, interpolate >> 1);

  framepos = 0;
  framelen = 0;
  return 1;
}

int sk_load_song(const char *path)
{
  if (strlen(path) >= MAX_FILENAME) return 0;
  strcpy(songfilename, path);
  memset(loadedsongfilename, 0, sizeof loadedsongfilename);
  loadsong();
  return loadedsongfilename[0] != 0;
}

int sk_save_song(const char *path)
{
  if (strlen(path) >= MAX_FILENAME-4) return 0;
  strcpy(songfilename, path);
  return savesong();
}

int sk_num_subsongs(void)
{
  int c;
  int count = 0;

  for (c = 0; c < MAX_SONGS; c++)
  {
    if ((songlen[c][0]) && (songlen[c][1]) && (songlen[c][2]))
      count = c + 1;
  }
  return count;
}

void sk_play(int subsong)
{
  if ((subsong < 0) || (subsong >= MAX_SONGS)) return;
  initsong(subsong, PLAY_BEGINNING);
}

void sk_stop(void)
{
  stopsong();
}

int sk_is_playing(void)
{
  return isplaying();
}

void sk_toggle_mute(int channel)
{
  if ((channel < 0) || (channel >= MAX_CHN)) return;
  mutechannel(channel);
}

int sk_is_muted(int channel)
{
  if ((channel < 0) || (channel >= MAX_CHN)) return 0;
  return chn[channel].mute;
}

int sk_render_frame(short *out)
{
  int samples = ((samplerate * 5) >> 1) / frametempo;

  if (samples > SK_MAX_FRAME_SAMPLES) samples = SK_MAX_FRAME_SAMPLES;
  playroutine();
  return sid_fillbuffer(out, samples);
}

void sk_render(short *out, int n)
{
  while (n > 0)
  {
    int amount;

    if (framepos >= framelen)
    {
      framelen = sk_render_frame(framebuf);
      framepos = 0;
      if (framelen <= 0) break;
    }
    amount = framelen - framepos;
    if (amount > n) amount = n;
    memcpy(out, &framebuf[framepos], amount * sizeof(short));
    out += amount;
    framepos += amount;
    n -= amount;
  }
  // Only reachable if reSID produced nothing; pad with silence
  if (n > 0) memset(out, 0, n * sizeof(short));
}

const unsigned char *sk_sidregs(void)
{
  return sidreg;
}

int sk_frames(void)
{
  return timeframes;
}

const char *sk_song_name(void) { return songname; }
const char *sk_author_name(void) { return authorname; }
const char *sk_copyright_name(void) { return copyrightname; }
