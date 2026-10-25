//
// SIDKid engine API
//

#include "goattrk2.h"
#include "sidkid.h"

extern int timeframes;

static int samplerate = 44100;
static int frametempo = 125;
static int sidmodel = SK_MODEL_6581;
static int sidinterpolate = 0;

static short framebuf[SK_MAX_FRAME_SAMPLES];
static int framepos = 0;
static int framelen = 0;

// Order list position of each voice after the previous frame, and whether
// it has since jumped backwards (the song looped)
static unsigned char lastsongptr[MAX_CHN];
static int looped[MAX_CHN];

static void settempo(void)
{
  // Same tempo as gsound.c: BME calls the player every
  // (rate * 5 / 2) / tempo samples, i.e. 50 Hz PAL or 60 Hz NTSC.
  if (multiplier)
    frametempo = (ntsc ? 150 : 125) * multiplier;
  else
    frametempo = (ntsc ? 150 : 125) / 2;
}

int sk_init(int rate, int model, int usentsc, int interpolate)
{
  if (rate < MINMIXRATE) rate = MINMIXRATE;
  if (rate > MAXMIXRATE) rate = MAXMIXRATE;
  samplerate = rate;
  ntsc = usentsc ? 1 : 0;
  settempo();

  initchannels();
  clearsong(1,1,1,1,1);
  sk_set_model(model, interpolate);

  framepos = 0;
  framelen = 0;
  return 1;
}

void sk_configure(int newmultiplier, int newntsc, int newadparam, int newoptimizepulse, int newoptimizerealtime)
{
  if ((newmultiplier < 0) || (newmultiplier > 16)) newmultiplier = 1;
  multiplier = newmultiplier;
  adparam = newadparam & 0xffff;
  optimizepulse = newoptimizepulse ? 1 : 0;
  optimizerealtime = newoptimizerealtime ? 1 : 0;
  if ((newntsc ? 1 : 0) != ntsc)
  {
    // The clock rate changes, so reSID has to be set up again
    ntsc = newntsc ? 1 : 0;
    sk_set_model(sidmodel, sidinterpolate);
  }
  settempo();
}

void sk_set_model(int model, int interpolate)
{
  sidmodel = model;
  sidinterpolate = interpolate;
  sid_init(samplerate, sidmodel == SK_MODEL_8580, ntsc, sidinterpolate & 1, 0, sidinterpolate >> 1);
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
  int c;

  if ((subsong < 0) || (subsong >= MAX_SONGS)) return;
  initsong(subsong, PLAY_BEGINNING);
  for (c = 0; c < MAX_CHN; c++)
  {
    lastsongptr[c] = 0;
    looped[c] = 0;
  }
}

int sk_song_looped(void)
{
  return looped[0] && looped[1] && looped[2];
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

  int c;

  if (samples > SK_MAX_FRAME_SAMPLES) samples = SK_MAX_FRAME_SAMPLES;
  playroutine();
  for (c = 0; c < MAX_CHN; c++)
  {
    if (chn[c].songptr < lastsongptr[c]) looped[c] = 1;
    lastsongptr[c] = chn[c].songptr;
  }
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
