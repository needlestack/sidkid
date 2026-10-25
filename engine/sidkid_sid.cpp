//
// SIDKid engine: reSID queries that gsid.cpp does not provide
//
// Only standard reSID is supported; reSID-fp keeps its envelope state
// private, so with interpolation modes 2 and 3 the levels read as zero.
//

#include "resid/sid.h"

extern SID *sid;

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
