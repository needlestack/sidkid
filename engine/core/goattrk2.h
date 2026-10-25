//
// SIDKid engine shim for goattrk2.h
//
// The GoatTracker engine sources (gsong.c, gplay.c, gtables.c) include
// "goattrk2.h", which in the original pulls in the whole SDL/BME editor.
// This replacement declares only what the engine actually touches. The
// editor-state globals (cursor positions etc.) are defined in gglue.c.
//

#ifndef GOATTRK2_H
#define GOATTRK2_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <math.h>

#include "gcommon.h"
#include "gsound.h"
#include "gsid.h"
#include "gsong.h"
#include "gplay.h"

// GoatTracker uses 60, which suits its file dialog (names only) but not the
// full paths SIDKid passes; nothing in the song format depends on it
#define MAX_FILENAME 1024
#define MAX_PATHNAME 256

// gtable.h
#define MST_NOFINEVIB 0
#define MST_FINEVIB 1
#define MST_FUNKTEMPO 2
#define MST_PORTAMENTO 3
#define MST_RAW 4

// greloc.h
#define TYPE_NONE 0
#define TYPE_OVERFLOW 1
#define TYPE_JUMP 2

// Player configuration (goattrk2.c)
extern unsigned multiplier;
extern unsigned adparam;
extern unsigned ntsc;
extern unsigned finevibrato;
extern unsigned optimizepulse;
extern unsigned optimizerealtime;
extern unsigned residdelay;
extern int defaultpatternlength;
extern int followplay;
extern char songfilename[MAX_FILENAME];
extern char loadedsongfilename[MAX_FILENAME];
extern char instrfilename[MAX_FILENAME];

// Editor state still read by the engine. In GoatTracker these are cursor
// positions; for the engine, espos/esend/epnum are the play-from position,
// loop end and pattern-play selection, and einum is the instrument slot that
// loadinstrument()/saveinstrument() operate on.
extern int espos[MAX_CHN];
extern int esend[MAX_CHN];
extern int epnum[MAX_CHN];
extern int esnum, eschn, escolumn, eseditpos, esview, esmarkchn;
extern int eppos, epchn, epcolumn, epview, epmarkchn;
extern int einum, eipos, eicolumn;
extern int enpos;
extern int etmarknum;
extern int etview[MAX_TABLES];

extern INSTR instrcopybuffer;
extern unsigned char pattused[MAX_PATT];
extern unsigned char instrused[MAX_INSTR];
extern unsigned char tableused[MAX_TABLES][MAX_TABLELEN+1];
extern int tableerror;

// bme_end.c
void fwrite8(FILE *file, unsigned data);
unsigned fread8(FILE *file);

// goattrk2.h; gsong.c uses it to reset the pattern view
#define VISIBLEPATTROWS 31

// gtables.c (data-only part of gtable.c)
void deletetable(int num, int pos);
void inserttable(int num, int pos, int mode);
int gettablelen(int num);
int gettablepartlen(int num, int pos);
void optimizetable(int num);
int makespeedtable(unsigned data, int mode, int makenew);
void deleteinstrtable(int i);
void exectable(int num, int ptr);
int findfreespeedtable(void);

// gglue.c
void settableview(int num, int pos);
void songchange(void);
void clearinstr(int num);
void resettime(void);
void incrementtime(void);

#endif
