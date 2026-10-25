//
// GOATTRACKER v2 table data operations
//
// Extracted verbatim from gtable.c (deletetable .. deleteinstrtable, plus
// exectable and findfreespeedtable); the table editor UI parts of that
// file are not part of the engine.
//

#include "goattrk2.h"

void deletetable(int num, int pos)
{
  int c, d;

  // Shift tablepointers in instruments
  for (c = 1; c < MAX_INSTR; c++)
  {
    if ((instr[c].ptr[num]-1) > pos) instr[c].ptr[num]--;
  }

  // Shift tablepointers in wavetable commands
  for (c = 0; c < MAX_TABLELEN; c++)
  {
    if ((ltable[WTBL][c] >= WAVECMD) && (ltable[WTBL][c] <= WAVELASTCMD))
    {
      int cmd = ltable[WTBL][c] & 0xf;

      if (num < STBL)
      {
        if (cmd == CMD_SETWAVEPTR+num)
        {
          if ((rtable[WTBL][c]-1) > pos) rtable[WTBL][c]--;
        }
      }
      else
      {
        if ((cmd == CMD_FUNKTEMPO) || ((cmd >= CMD_PORTAUP) && (cmd <= CMD_VIBRATO)))
        {
          if ((rtable[WTBL][c]-1) > pos) rtable[WTBL][c]--;
        }
      }
    }
  }

  // Shift tablepointers in patterns
  for (c = 0; c < MAX_PATT; c++)
  {
    for (d = 0; d <= MAX_PATTROWS; d++)
    {
      if (num < STBL)
      {
        if (pattern[c][d*4+2] == CMD_SETWAVEPTR+num)
        {
          if ((pattern[c][d*4+3]-1) > pos) pattern[c][d*4+3]--;
        }
      }
      else
      {
        if ((pattern[c][d*4+2] == CMD_FUNKTEMPO) ||
           ((pattern[c][d*4+2] >= CMD_PORTAUP) && (pattern[c][d*4+2] <= CMD_VIBRATO)))
        {
          if ((pattern[c][d*4+3]-1) > pos) pattern[c][d*4+3]--;
        }
      }
    }
  }

  // Shift jumppointers in the table itself
  for (c = 0; c < MAX_TABLELEN; c++)
  {
    if (num != STBL)
    {
      if (ltable[num][c] == 0xff)
        if ((rtable[num][c]-1) > pos) rtable[num][c]--;
    }
  }

  for (c = pos; c < MAX_TABLELEN; c++)
  {
    if (c+1 < MAX_TABLELEN)
    {
      ltable[num][c] = ltable[num][c+1];
      rtable[num][c] = rtable[num][c+1];
    }
    else
    {
      ltable[num][c] = 0;
      rtable[num][c] = 0;
    }
  }
}

void inserttable(int num, int pos, int mode)
{
  int c, d;

  // Shift tablepointers in instruments
  for (c = 1; c < MAX_INSTR; c++)
  {
    if (!mode)
    {
      if ((instr[c].ptr[num]-1) >= pos) instr[c].ptr[num]++;
    }
    else
    {
      if ((instr[c].ptr[num]-1) > pos) instr[c].ptr[num]++;
    }
  }

  // Shift tablepointers in wavetable commands
  for (c = 0; c < MAX_TABLELEN; c++)
  {
    if ((ltable[WTBL][c] >= WAVECMD) && (ltable[WTBL][c] <= WAVELASTCMD))
    {
      int cmd = ltable[WTBL][c] & 0xf;

      if (num < STBL)
      {
        if (cmd == CMD_SETWAVEPTR+num)
        {
          if (!mode)
          {
            if ((rtable[WTBL][c]-1) >= pos) rtable[WTBL][c]++;
          }
          else
          {
            if ((rtable[WTBL][c]-1) > pos) rtable[WTBL][c]++;
          }
        }
      }
      else
      {
        if ((cmd == CMD_FUNKTEMPO) || ((cmd >= CMD_PORTAUP) && (cmd <= CMD_VIBRATO)))
        {
          if (!mode)
          {
            if ((rtable[WTBL][c]-1) >= pos) rtable[WTBL][c]++;
          }
          else
          {
            if ((rtable[WTBL][c]-1) > pos) rtable[WTBL][c]++;
          }
        }
      }
    }
  }


  // Shift tablepointers in patterns
  for (c = 0; c < MAX_PATT; c++)
  {
    for (d = 0; d <= MAX_PATTROWS; d++)
    {
      if (num < STBL)
      {
        if (pattern[c][d*4+2] == CMD_SETWAVEPTR+num)
        {
          if (!mode)
          {
            if ((pattern[c][d*4+3]-1) >= pos) pattern[c][d*4+3]++;
          }
          else
          {
            if ((pattern[c][d*4+3]-1) > pos) pattern[c][d*4+3]++;
          }
        }
      }
      else
      {
        if ((pattern[c][d*4+2] == CMD_FUNKTEMPO) ||
           ((pattern[c][d*4+2] >= CMD_PORTAUP) && (pattern[c][d*4+2] <= CMD_VIBRATO)))
        {
          if (!mode)
          {
            if ((pattern[c][d*4+3]-1) >= pos) pattern[c][d*4+3]++;
          }
          else
          {
            if ((pattern[c][d*4+3]-1) > pos) pattern[c][d*4+3]++;
          }
        }
      }
    }
  }

  // Shift jumppointers in the table itself
  if (num != STBL)
  {
    for (c = 0; c < MAX_TABLELEN; c++)
    {
      if (ltable[num][c] == 0xff)
      {
        if (!mode)
        {
          if ((rtable[num][c]-1) >= pos) rtable[num][c]++;
        }
        else
        {
          if ((rtable[num][c]-1) > pos) rtable[num][c]++;
        }
      }
    }
  }

  for (c = MAX_TABLELEN-1; c >= pos; c--)
  {
    if (c > pos)
    {
      ltable[num][c] = ltable[num][c-1];
      rtable[num][c] = rtable[num][c-1];
    }
    else
    {
      if ((num == WTBL) && (mode == 1))
      {
        ltable[num][c] = 0xe9;
        rtable[num][c] = 0;
      }
      else
      {
        ltable[num][c] = 0;
        rtable[num][c] = 0;
      }
    }
  }
}

int gettablelen(int num)
{
  int c;

  for (c = MAX_TABLELEN-1; c >= 0; c--)
  {
    if (ltable[num][c] | rtable[num][c]) break;
  }
  return c+1;
}

int gettablepartlen(int num, int pos)
{
  int c;

  if (pos < 0) return 0;
  if (num == STBL) return 1;

  for (c = pos; c < MAX_TABLELEN; c++)
  {
    if (ltable[num][c] == 0xff)
    {
      c++;
      break;
    }
  }
  return c-pos;
}

void optimizetable(int num)
{
  int c,d;

  memset(tableused, 0, sizeof tableused);

  for (c = 0; c < MAX_PATT; c++)
  {
    for (d = 0; d < pattlen[c]; d++)
    {
      if ((pattern[c][d*4+2] >= CMD_SETWAVEPTR) && (pattern[c][d*4+2] <= CMD_SETFILTERPTR))
        exectable(pattern[c][d*4+2] - CMD_SETWAVEPTR, pattern[c][d*4+3]);
      if ((pattern[c][d*4+2] >= CMD_PORTAUP) && (pattern[c][d*4+2] <= CMD_VIBRATO))
        exectable(STBL, pattern[c][d*4+3]);
      if (pattern[c][d*4+2] == CMD_FUNKTEMPO)
        exectable(STBL, pattern[c][d*4+3]);
    }
  }

  for (c = 0; c < MAX_INSTR; c++)
  {
    for (d = 0; d < MAX_TABLES; d++)
    {
      exectable(d, instr[c].ptr[d]);
    }
  }

  for (c = 0; c < MAX_TABLELEN; c++)
  {
    if (tableused[WTBL][c+1])
    {
      if ((ltable[WTBL][c] >= WAVECMD) && (ltable[WTBL][c] <= WAVELASTCMD))
      {
        d = -1;

        switch(ltable[WTBL][c] - WAVECMD)
        {
          case CMD_PORTAUP:
          case CMD_PORTADOWN:
          case CMD_TONEPORTA:
          case CMD_VIBRATO:
          d = STBL;
          break;

          case CMD_SETPULSEPTR:
          d = PTBL;
           break;

           case CMD_SETFILTERPTR:
           d = FTBL;
          break;
        }

        if (d != -1) exectable(d, rtable[WTBL][c]);
      }
    }
  }

  for (c = MAX_TABLELEN-1; c >= 0; c--)
  {
    if ((ltable[num][c]) || (rtable[num][c])) break;
  }
  for (; c >= 0; c--)
  {
    if (!tableused[num][c+1]) deletetable(num, c);
  }
}

int makespeedtable(unsigned data, int mode, int makenew)
{
  int c;
  unsigned char l = 0, r = 0;

  if (!data) return -1;

  switch (mode)
  {
    case MST_NOFINEVIB:
    l = (data & 0xf0) >> 4;
    r = (data & 0x0f) << 4;
    break;

    case MST_FINEVIB:
    l = (data & 0x70) >> 4;
    r = ((data & 0x0f) << 4) | ((data & 0x80) >> 4);
    break;

    case MST_FUNKTEMPO:
    l = (data & 0xf0) >> 4;
    r = data & 0x0f;
    break;

    case MST_PORTAMENTO:
    l = (data << 2) >> 8;
    r = (data << 2) & 0xff;
    break;
    
    case MST_RAW:
    r = data & 0xff;
    l = data >> 8;
    break;
  }

  if (makenew == 0)
  {
    for (c = 0; c < MAX_TABLELEN; c++)
    {
      if ((ltable[STBL][c] == l) && (rtable[STBL][c] == r))
        return c;
    }
  }

  for (c = 0; c < MAX_TABLELEN; c++)
  {
    if ((!ltable[STBL][c]) && (!rtable[STBL][c]))
    {
      ltable[STBL][c] = l;
      rtable[STBL][c] = r;

      settableview(STBL, c);
      return c;
    }
  }
  return -1;
}

void deleteinstrtable(int i)
{
  int c,d;
  int eraseok = 1;

  for (c = 0; c < MAX_TABLES; c++)
  {
    if (instr[i].ptr[c])
    {
      int pos = instr[i].ptr[c]-1;
      int len = gettablepartlen(c, pos);

      // Check that this table area isn't used by another instrument
      for (d = 1; d < MAX_INSTR; d++)
      {
        if ((d != i) && (instr[d].ptr[c]))
        {
          int cmppos = instr[d].ptr[c]-1;
          if ((cmppos >= pos) && (cmppos < pos+len)) eraseok = 0;
        }
      }
      if (eraseok)
        while (len--) deletetable(c, pos);
    }
  }
}


void exectable(int num, int ptr)
{
  // Jump error check
  if ((num != STBL) && (ptr) && (ptr <= MAX_TABLELEN))
  {
    if (ltable[num][ptr-1] == 0xff)
    {
      tableerror = TYPE_JUMP;
      return;
    }
  }

  for (;;)
  {
    // Exit when table stopped
    if (!ptr) break;
    // Overflow check
    if ((num != STBL) && (ptr > MAX_TABLELEN))
    {
      tableerror = TYPE_OVERFLOW;
      break;
    }
    // If were already here, exit
    if (tableused[num][ptr]) break;
    // Mark current position used
    tableused[num][ptr] = 1;
    // Go to next ptr.
    if (num != STBL)
    {
      if (ltable[num][ptr-1] == 0xff)
      {
        ptr = rtable[num][ptr-1];
      }
      else ptr++;
    }
    else break;
  }
}

int findfreespeedtable(void)
{
  int c;
  for (c = 0; c < MAX_TABLELEN; c++)
  {
    if ((!ltable[STBL][c]) && (!rtable[STBL][c]))
    {
      return c;
    }
  }
  return -1;
}

