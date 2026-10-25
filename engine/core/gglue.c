//
// SIDKid engine glue
//
// Definitions the GoatTracker engine sources expect from the editor
// (goattrk2.c, gorder.c, gpattern.c, ginstr.c, gtable.c, gdisplay.c,
// greloc.c, gsound.c, bme_end.c). Defaults match goattrk2.c.
//

#include "goattrk2.h"

// goattrk2.c
unsigned multiplier = 1;
unsigned adparam = 0x0f00;
unsigned ntsc = 0;
unsigned finevibrato = 1;
unsigned optimizepulse = 1;
unsigned optimizerealtime = 1;
unsigned residdelay = 0;
int defaultpatternlength = 64;
int followplay = 0;
char songfilename[MAX_FILENAME];
char loadedsongfilename[MAX_FILENAME];
char instrfilename[MAX_FILENAME];

// gorder.c
int espos[MAX_CHN];
int esend[MAX_CHN];
int esnum, eschn, escolumn, eseditpos, esview;
int esmarkchn = -1;
int enpos;

// gpattern.c
int epnum[MAX_CHN];
int eppos, epchn, epcolumn, epview;
int epmarkchn = -1;

// ginstr.c
INSTR instrcopybuffer;
int einum, eipos, eicolumn;

// gtable.c
int etview[MAX_TABLES];
int etmarknum = -1;

// greloc.c
unsigned char pattused[MAX_PATT];
unsigned char instrused[MAX_INSTR];
unsigned char tableused[MAX_TABLES][MAX_TABLELEN+1];
int tableerror;

// gdisplay.c: playback time, counted in frames
int timeframes = 0;

// gsound.c: the engine renders synchronously, so there is no player
// thread to suspend or flush.
void sound_suspend(void) {}
void sound_flush(void) {}

// bme_end.c
void fwrite8(FILE *file, unsigned data)
{
  unsigned char bytes[1];

  bytes[0] = data;
  fwrite(bytes, 1, 1, file);
}

unsigned fread8(FILE *file)
{
  unsigned char bytes[1] = {0};

  fread(bytes, 1, 1, file);
  return bytes[0];
}

// gtable.c: view-only, nothing to do without a table editor
void settableview(int num, int pos)
{
  (void)num;
  (void)pos;
}

// gorder.c, without the editor view bookkeeping
void songchange(void)
{
  int c, d;

  for (c = 0; c < MAX_CHN; c++)
  {
    espos[c] = 0;
    esend[c] = 0;
    epnum[c] = c;
  }
  for (c = 0; c < MAX_CHN; c++)
  {
    for (d = espos[c]; d < songlen[esnum][c]; d++)
    {
      if (songorder[esnum][c][d] < MAX_PATT)
      {
        epnum[c] = songorder[esnum][c][d];
        break;
      }
    }
  }
  eppos = 0;
  eseditpos = 0;
  epmarkchn = -1;
  esmarkchn = -1;
  stopsong();
}

// ginstr.c
void clearinstr(int num)
{
  memset(&instr[num], 0, sizeof(INSTR));
  if (num)
  {
    if (multiplier)
      instr[num].gatetimer = 2 * multiplier;
    else
      instr[num].gatetimer = 1;

    instr[num].firstwave = 0x9;
  }
}

// gdisplay.c
void resettime(void)
{
  timeframes = 0;
}

void incrementtime(void)
{
  timeframes++;
}
