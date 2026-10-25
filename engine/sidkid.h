//
// SIDKid engine API
//
// A headless wrapper around the GoatTracker 2 song model, playroutine and
// reSID. Rendering is synchronous and frame-based: one playroutine call per
// C64 frame, then that frame's samples, so the output does not depend on how
// large the caller's audio buffers are.
//

#ifndef SIDKID_H
#define SIDKID_H

#ifdef __cplusplus
extern "C" {
#endif

#define SK_MODEL_6581 0
#define SK_MODEL_8580 1

#define SK_MAX_FRAME_SAMPLES 4096

// model: SK_MODEL_*; interpolate: 0 = fast, 1 = interpolate,
// 2 = reSID-fp, 3 = reSID-fp with resampling (as GoatTracker's -I option)
int sk_init(int samplerate, int model, int ntsc, int interpolate);

// Player options that GoatTracker keeps in its configuration rather than in
// the song (its -S, -N, -A, -O and -R options). multiplier 0 means half
// speed; adparam is the hard restart AD/SR (default 0x0f00).
void sk_configure(int multiplier, int ntsc, int adparam, int optimizepulse, int optimizerealtime);

// Changes the emulated chip without touching the loaded song.
void sk_set_model(int model, int interpolate);

// Loads a GoatTracker .sng file. Returns 1 on success.
int sk_load_song(const char *path);
int sk_save_song(const char *path);

int sk_num_subsongs(void);
void sk_play(int subsong);
void sk_stop(void);
int sk_is_playing(void);

// True once every voice has taken its loop and read the first row after it
// since sk_play(), i.e. the song has played through once.
int sk_song_looped(void);

void sk_toggle_mute(int channel);
int sk_is_muted(int channel);

// Runs one frame of the playroutine and renders its samples into out
// (at least SK_MAX_FRAME_SAMPLES long). Returns the number of samples.
int sk_render_frame(short *out);

// Starts the song and fast-forwards it by the given number of frames
// without rendering audio. Envelopes pick up from wherever reSID was.
void sk_seek(int subsong, int frame);

// Plays the song silently from the start, without rendering audio, and
// records every pattern row each voice reads, as pairs of words:
//   frame (as sk_frames() would report it after that frame)
//   voice | row << 8 | pattern << 16
// Stops once the song has looped (see sk_song_looped), or ends, or after
// maxframes. Returns the number of rows recorded.
// Leaves the song stopped.
int sk_scan(int subsong, int maxframes, unsigned *out, int maxevents);

// Fills out with exactly n samples, running frames as needed.
void sk_render(short *out, int n);

// Playing single notes, for trying out sounds. These work while no song is
// playing (a playing song is stopped). Notes are 0 (C-0) to 94 (A#7).

// Stops any song and resets the player, leaving the loaded song as it is.
void sk_reset(void);

// Replaces table (0 wave, 1 pulse, 2 filter, 3 speed) with length rows.
void sk_set_table(int table, const unsigned char *left, const unsigned char *right, int length);

// Sets instrument num (1-63). wave, pulse, filter and speed are 1-based
// table positions, 0 for none.
void sk_set_instrument(int num, int ad, int sr, int wave, int pulse, int filter, int speed, int vibdelay, int gatetimer, int firstwave);

// Starts a note on a voice with an instrument, as GoatTracker's jam mode.
// It sounds after the instrument's gate timer, plus a frame.
void sk_note_on(int voice, int note, int num);
void sk_note_off(int voice);

// Runs one frame of the playroutine without rendering audio.
void sk_tick(void);

// The 1-based table position a voice is at (0 = not running). The filter
// is shared, so its position is the same for every voice.
int sk_table_pos(int voice, int table);

// The 25 SID register values written by the last frame.
const unsigned char *sk_sidregs(void);

// Current envelope level (0-255) of the three voices, written to out[0..2].
void sk_envelopes(unsigned char *out);

// Frames played since the song started.
int sk_frames(void);

const char *sk_song_name(void);
const char *sk_author_name(void);
const char *sk_copyright_name(void);

#ifdef __cplusplus
}
#endif

#endif
