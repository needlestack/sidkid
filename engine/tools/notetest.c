//
// notetest: checks playing single notes with tables set from outside
//
// Usage: notetest
//
// Sets up wave and pulse programs and an instrument through the SIDKid API,
// plays a note, and checks the playroutine's register writes follow them.
//

#include <stdio.h>
#include <string.h>

#include "goattrk2.h"
#include "sidkid.h"

#define NOTE 48 // C-4

static int errors = 0;

static void check(int ok, const char *what)
{
  printf("  %s  %s\n", ok ? "ok  " : "FAIL", what);
  if (!ok) errors++;
}

static unsigned short freq(int note)
{
  return freqtbllo[note] | (freqtblhi[note] << 8);
}

// Runs frames until voice 1 has the waveform, up to a limit
static int waitwave(int wave, int limit)
{
  int f;

  for (f = 0; f < limit; f++)
  {
    sk_tick();
    if (sk_sidregs()[4] == wave) return 1;
  }
  return 0;
}

static void arpeggio(void)
{
  // Pulse, then a looping major chord: +0, +4, +7
  static const unsigned char left[] = {0x41, 0x00, 0x00, 0x00, 0xff};
  static const unsigned char right[] = {0x00, 0x04, 0x07, 0x00, 0x02};
  static const int chord[] = {0, 4, 7};
  int f, ok;

  sk_reset();
  sk_set_table(WTBL, left, right, sizeof left);
  sk_set_instrument(1, 0x00, 0xf0, 1, 0, 0, 0, 0, 2, 0x09);
  sk_note_on(0, NOTE, 1);
  ok = waitwave(0x41, 10);
  check(ok && ((sk_sidregs()[0] | (sk_sidregs()[1] << 8)) == freq(NOTE)), "wave program starts the note with pulse at its pitch");

  ok = 1;
  for (f = 1; f < 12; f++)
  {
    const unsigned char *regs;

    sk_tick();
    regs = sk_sidregs();
    if ((regs[0] | (regs[1] << 8)) != freq(NOTE + chord[f % 3])) ok = 0;
  }
  check(ok, "wave program loops the chord");
  check(sk_table_pos(0, WTBL) >= 2 && sk_table_pos(0, WTBL) <= 4, "table position stays inside the loop");

  sk_note_off(0);
  sk_tick();
  check(sk_sidregs()[4] == 0x40, "note off clears the gate");
}

static void pulsesweep(void)
{
  static const unsigned char wl[] = {0x41, 0xff};
  static const unsigned char wr[] = {0x00, 0x00};
  // Width $800, then up by $10 for 16 frames, then stop
  static const unsigned char pl[] = {0x88, 0x10, 0xff};
  static const unsigned char pr[] = {0x00, 0x10, 0x00};
  int f, ok, width, start;

  // Pulse optimization is on, as by default: it must not skip steps here
  sk_reset();
  sk_set_table(WTBL, wl, wr, sizeof wl);
  sk_set_table(PTBL, pl, pr, sizeof pl);
  sk_set_instrument(1, 0x00, 0xf0, 1, 1, 0, 0, 0, 2, 0x09);
  sk_note_on(0, NOTE, 1);

  ok = 1;
  start = -1;
  for (f = 0; f < 40; f++)
  {
    sk_tick();
    width = sk_sidregs()[2] | ((sk_sidregs()[3] & 0xf) << 8);
    if ((start < 0) && (width == 0x800)) start = f;
    if ((start >= 0) && (f - start <= 16) && (width != 0x800 + (f - start) * 0x10)) ok = 0;
  }
  check(ok && (start >= 0) && (width == 0x900), "pulse program sweeps the width every frame and stops");
  check(sk_table_pos(0, PTBL) == 0, "pulse program has ended");
}

static void stopsplaying(const char *song)
{
  if (!song || !sk_load_song(song)) return;
  sk_play(0);
  sk_tick();
  sk_reset();
  check(!sk_is_playing(), "reset stops a playing song");
}

int main(int argc, char **argv)
{
  sk_init(44100, SK_MODEL_6581, 0, 0);
  arpeggio();
  pulsesweep();
  stopsplaying(argc > 1 ? argv[1] : 0);
  return errors ? 1 : 0;
}
