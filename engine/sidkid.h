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

// Loads a GoatTracker .sng file. Returns 1 on success.
int sk_load_song(const char *path);
int sk_save_song(const char *path);

int sk_num_subsongs(void);
void sk_play(int subsong);
void sk_stop(void);
int sk_is_playing(void);
void sk_toggle_mute(int channel);
int sk_is_muted(int channel);

// Runs one frame of the playroutine and renders its samples into out
// (at least SK_MAX_FRAME_SAMPLES long). Returns the number of samples.
int sk_render_frame(short *out);

// Fills out with exactly n samples, running frames as needed.
void sk_render(short *out, int n);

// The 25 SID register values written by the last frame.
const unsigned char *sk_sidregs(void);

// Frames played since the song started.
int sk_frames(void);

const char *sk_song_name(void);
const char *sk_author_name(void);
const char *sk_copyright_name(void);

#ifdef __cplusplus
}
#endif

#endif
