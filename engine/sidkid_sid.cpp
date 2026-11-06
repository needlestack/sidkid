//
// SIDKid engine: reSID queries that gsid.cpp does not provide
//
// Only standard reSID is supported; reSID-fp keeps its envelope state
// private, so with interpolation modes 2 and 3 the levels read as zero.
//

#include "resid/sid.h"
#include "resid-fp/sidfp.h"
#include <stdlib.h>
#include "core/gsid.h"

extern SID *sid;
extern SIDFP *sidfp;
extern int clockrate;
extern int samplerate;
extern unsigned residdelay;

// A frame made as it's played, a part at a time, exactly as
// sid_fillbuffer makes it whole: its register writes first (each a few
// cycles apart), then its cycles, and samples made up if they fall short.
// (sid_fillbuffer is gsid.cpp's; this is it in parts, the same to the
// sample with reSID, as the worklet plays; reSID-fp's clocking takes whole
// frames for granted.) What the frame has left to clock:
static int framecycles = 0;

extern "C" int sk_frame_begin(short *ptr, int samples)
{
  int tdelta;
  int tdelta2;
  int result = 0;
  int total = 0;
  int c;
  int badline = rand() % NUMSIDREGS;

  framecycles = 0;
  tdelta = clockrate * samples / samplerate;
  if (tdelta <= 0) return total;

  for (c = 0; c < NUMSIDREGS; c++)
  {
    unsigned char o = sid_getorder(c);

    // Possible random badline delay once per writing
    if ((badline == c) && (residdelay))
    {
      tdelta2 = residdelay;
      if (sid) result = sid->clock(tdelta2, ptr, samples);
      if (sidfp) result = sidfp->clock(tdelta2, ptr, samples);
      total += result;
      ptr += result;
      samples -= result;
      tdelta -= residdelay;
    }

    if (sid) sid->write(o, sidreg[o]);
    if (sidfp) sidfp->write(o, sidreg[o]);

    tdelta2 = SIDWRITEDELAY;
    if (sid) result = sid->clock(tdelta2, ptr, samples);
    if (sidfp) result = sidfp->clock(tdelta2, ptr, samples);
    total += result;
    ptr += result;
    samples -= result;
    tdelta -= SIDWRITEDELAY;

    // (a frame too short for its writes ends with them)
    if (tdelta <= 0) return -total;
  }
  framecycles = tdelta;
  return total;
}

// At least one more sample of the frame (about `want`), with room to its
// end; 0 when it's over
extern "C" int sk_frame_more(short *ptr, int want, int room)
{
  int result = 0;
  int tdelta;

  if (room <= 0) return 0;
  if (framecycles > 0)
  {
    // Stopped after `want` samples, the cycles not yet clocked stay for the
    // next part (reSID leaves them in tdelta), so the frame is split only
    // between samples: just as the whole frame would have gone
    tdelta = framecycles;
    if (sid) result = sid->clock(tdelta, ptr, want < room ? want : room);
    if (sidfp) result = sidfp->clock(tdelta, ptr, want < room ? want : room);
    framecycles = tdelta;
    // (the frame's end reached with cycles to spare: they go unclocked, as whole)
    if (result >= room) framecycles = 0;
    if (result > 0) return result;
  }
  // Its cycles spent: samples made up until the frame is full
  tdelta = clockrate * room / samplerate;
  if (tdelta <= 0) return 0;
  if (sid) result = sid->clock(tdelta, ptr, room);
  if (sidfp) result = sidfp->clock(tdelta, ptr, room);
  return result;
}

extern "C" void sk_envelopes(unsigned char *out)
{
  int c;

  if (sid)
  {
    SID::State state = sid->read_state();
    for (c = 0; c < 3; c++) out[c] = state.envelope_counter[c];
  }
  else
  {
    for (c = 0; c < 3; c++) out[c] = 0;
  }
}
