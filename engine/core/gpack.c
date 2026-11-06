//
// SIDKid packer glue
//
// GoatTracker's packer/relocator (greloc.c, as gt2reloc builds it) made
// part of the engine: the loaded song, its player (player.s, built in) and
// GoatTracker's assembler make the C64 player and music, written to a file
// as SID, PRG or raw binary. What gt2reloc.c and the editor define for it
// is defined here. Defaults match gt2reloc.c.
//

#define GT2RELOC

#include "goattrk2.h"
#include "greloc.h"
#include "player_s.h"

unsigned playerversion = 0;
int fileformat = FORMAT_PRG;
int zeropageadr = 0xfc;
int playeradr = 0x1000;
unsigned sidaddress = 0xd400;
unsigned customclockrate = 0;
unsigned usefinevib = 0;
char packedsongname[MAX_PATHNAME];
char textbuffer[MAX_PATHNAME];
// The chip the SID file's header names (the engine's own is sidkid.c's)
unsigned sidmodel = 0;
// goattrk2.c: the editor's keyboard, cleared after packing
int key, rawkey;

// bme_io.c, for the one file the packer reads: its player, built in
static int playerpos = -1;

int io_open(char *name)
{
  if (strcmp(name, "player.s")) return -1;
  playerpos = 0;
  return 0;
}

int io_lseek(int handle, int bytes, int whence)
{
  (void)handle;
  if (whence == SEEK_END) playerpos = sizeof player_s + bytes;
  else if (whence == SEEK_CUR) playerpos += bytes;
  else playerpos = bytes;
  return playerpos;
}

int io_read8(int handle)
{
  (void)handle;
  return playerpos < (int)sizeof player_s ? player_s[playerpos++] : 0;
}

void io_close(int handle)
{
  (void)handle;
  playerpos = -1;
}

// bme_end.c
void fwritele16(FILE *file, unsigned data)
{
  fwrite8(file, data & 0xff);
  fwrite8(file, data >> 8);
}

#include "greloc.c"

// The song loaded packed to a file (FORMAT_SID, FORMAT_PRG or FORMAT_BIN),
// with the player settings the engine plays it with: its size, or 0
int sk_pack(const char *path, int format, int model)
{
  FILE *f;
  long size;

  if (strlen(path) >= MAX_PATHNAME) return 0;
  strcpy(packedsongname, path);
  remove(path);
  fileformat = format;
  sidmodel = model ? 1 : 0;
  // (as gt2reloc.c works it out)
  usefinevib = (finevibrato == 1 && multiplier < 2) || finevibrato > 1;
  relocator();
  f = fopen(path, "rb");
  if (!f) return 0;
  fseek(f, 0, SEEK_END);
  size = ftell(f);
  fclose(f);
  return (int)size;
}
