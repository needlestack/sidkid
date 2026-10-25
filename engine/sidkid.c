//
// SIDKid engine API
//

#include "goattrk2.h"
#include "sidkid.h"

extern int timeframes;
extern int psnum;
extern unsigned char filterctrl, filtertype, filtercutoff, filtertime, filterptr;

static int samplerate = 44100;
static int frametempo = 125;
static int sidmodel = SK_MODEL_6581;
static int sidinterpolate = 0;

static short framebuf[SK_MAX_FRAME_SAMPLES];
static int framepos = 0;
static int framelen = 0;

// Order list position of each voice after the previous frame; whether it
// has taken its loop; and whether it has since read the first row there
// (the song has looped)
static unsigned char lastsongptr[MAX_CHN];
static int takenloop[MAX_CHN];
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

  unsigned char mute[MAX_CHN];

  if ((subsong < 0) || (subsong >= MAX_SONGS)) return;

  // GoatTracker carries some player state (filter, pulse, vibrato...) over
  // from the previous run, so a song can start slightly differently each
  // time. Reset it to how it is after loading, keeping the mutes.
  for (c = 0; c < MAX_CHN; c++) mute[c] = chn[c].mute;
  initchannels();
  for (c = 0; c < MAX_CHN; c++) chn[c].mute = mute[c];
  filterctrl = filtertype = filtercutoff = filtertime = filterptr = 0;
  masterfader = 0x0f;
  memset(sidreg, 0, sizeof sidreg);

  initsong(subsong, PLAY_BEGINNING);
  for (c = 0; c < MAX_CHN; c++)
  {
    lastsongptr[c] = 0;
    takenloop[c] = 0;
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

// One playroutine call, keeping track of whether the song has looped.
// Returns a bit per voice that read a pattern row.
static int advance(void)
{
  int c;
  int rows = 0;
  int atloop[MAX_CHN];
  CHN old[MAX_CHN];

  // A voice whose pattern has ended with the order list on its loop
  // command will take the loop as soon as it moves on. Jumping back is not
  // enough to tell: a loop to the voice's last position goes nowhere.
  memcpy(old, chn, sizeof old);
  for (c = 0; c < MAX_CHN; c++)
    atloop[c] = (chn[c].pattptr == 0x7fffffff) && (songorder[psnum][c][chn[c].songptr] == LOOPSONG);
  playroutine();
  for (c = 0; c < MAX_CHN; c++)
  {
    CHN *cptr = &chn[c];

    // The pattern pointer moves on when a row is read; it is reset to 0
    // when a new pattern is set up, before its first row is read. A
    // one-row pattern ends where it started, so then look for the order
    // list having moved instead.
    if (((cptr->pattptr != old[c].pattptr) && (cptr->pattptr != 0)) ||
        ((cptr->pattptr == 0x7fffffff) && (old[c].pattptr == 0x7fffffff) &&
         ((cptr->songptr != old[c].songptr) || (cptr->repeat != old[c].repeat) || (cptr->pattnum != old[c].pattnum))))
      rows |= 1 << c;
    if ((cptr->songptr < lastsongptr[c]) || (atloop[c] && (cptr->pattptr != 0x7fffffff))) takenloop[c] = 1;
    // The loop is taken as the last row before it starts to sound; the
    // song has looped once the first row after it is read
    if (takenloop[c] && (rows & (1 << c))) looped[c] = 1;
    lastsongptr[c] = cptr->songptr;
  }
  return rows;
}

int sk_render_frame(short *out)
{
  int samples = ((samplerate * 5) >> 1) / frametempo;

  if (samples > SK_MAX_FRAME_SAMPLES) samples = SK_MAX_FRAME_SAMPLES;
  advance();
  return sid_fillbuffer(out, samples);
}

void sk_seek(int subsong, int frame)
{
  sk_play(subsong);
  while ((frame-- > 0) && (isplaying())) advance();
  framepos = 0;
  framelen = 0;
}

int sk_scan(int subsong, int maxframes, unsigned *out, int maxevents)
{
  int c;
  int count = 0;

  sk_play(subsong);
  while ((timeframes < maxframes) && (count + MAX_CHN <= maxevents))
  {
    int rows = advance();
    if (!isplaying()) break;

    for (c = 0; c < MAX_CHN; c++)
    {
      unsigned ptr = chn[c].pattptr;
      int row;

      if (!(rows & (1 << c))) continue;
      row = (ptr == 0x7fffffff) ? pattlen[chn[c].pattnum] - 1 : (int)(ptr / 4) - 1;
      out[count * 2] = timeframes;
      out[count * 2 + 1] = c | (row << 8) | (chn[c].pattnum << 16);
      count++;
    }
    if (sk_song_looped()) break;
  }
  sk_stop();
  advance();
  return count;
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
