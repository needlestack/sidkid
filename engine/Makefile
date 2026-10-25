# SIDKid engine
#
#   make          native sngrender in build/native/
#   make ref      the same tool built from the untouched vendor sources
#   make test     check native, reference and wasm builds give identical
#                 SID registers and audio on all example songs
#   make wasm     build/wasm/sidkid.js + .wasm

ROOT := ..
BUILD := $(ROOT)/build
VENDOR := $(ROOT)/vendor/gt2/src
EXAMPLES := $(ROOT)/vendor/gt2/examples

CC ?= cc
CXX ?= c++
NODE ?= node
# -ffp-contract=off: wasm never fuses multiply-adds, so native builds must
# not either, or reSID's float math rounds differently and the audio drifts
# by a few LSBs between native and browser.
CFLAGS += -O2 -ffp-contract=off -Wall -Wno-unused-result -Wno-unused-variable \
	-Wno-unused-but-set-variable -Wno-sign-compare -Wno-char-subscripts \
	-Wno-parentheses -Wno-dangling-else
CXXFLAGS += -O2 -ffp-contract=off -w

RESID := envelope extfilt filter pot sid voice wave \
	wave6581__ST wave6581_P_T wave6581_PS_ wave6581_PST \
	wave8580__ST wave8580_P_T wave8580_PS_ wave8580_PST
RESIDFP := envelopefp extfiltfp filterfp potfp sidfp voicefp wavefp

CORE_C := gsong gplay gtables gglue
CORE_CXX := gsid $(addprefix resid/,$(RESID)) $(addprefix resid-fp/,$(RESIDFP))
API := sidkid.o sidkid_sid.o

# --- native ---------------------------------------------------------------

NATIVE := $(BUILD)/native
NATIVE_OBJS := $(addprefix $(NATIVE)/core/,$(addsuffix .o,$(CORE_C) $(CORE_CXX))) $(addprefix $(NATIVE)/,$(API))

all: $(NATIVE)/sngrender $(NATIVE)/scantest

$(NATIVE)/sngrender: $(NATIVE_OBJS) $(NATIVE)/tools/sngrender.o
	$(CXX) -o $@ $^

$(NATIVE)/scantest: $(NATIVE_OBJS) $(NATIVE)/tools/scantest.o
	$(CXX) -o $@ $^

$(NATIVE)/core/%.o: core/%.c core/*.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -Icore -c -o $@ $<

$(NATIVE)/core/%.o: core/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -Icore -c -o $@ $<

$(NATIVE)/%.o: %.c sidkid.h core/*.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -Icore -I. -c -o $@ $<

$(NATIVE)/%.o: %.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -Icore -c -o $@ $<

# --- reference: vendor gsong.c/gplay.c/gsid.cpp/reSID, our shim + glue -----
#
# The vendor files are copied next to our shim so their #include "goattrk2.h"
# picks up the shim rather than the editor's header.

REF := $(BUILD)/ref
REF_VENDOR := gsong.c gplay.c gsid.cpp gcommon.h gsong.h gplay.h gsid.h gsound.h
REF_OURS := goattrk2.h gtables.c gglue.c
REF_OBJS := $(addprefix $(REF)/obj/,$(addsuffix .o,$(CORE_C) $(CORE_CXX))) $(addprefix $(REF)/obj/,$(API))

ref: $(REF)/sngrender

$(REF)/src/.stamp: $(addprefix $(VENDOR)/,$(REF_VENDOR)) $(addprefix core/,$(REF_OURS))
	@mkdir -p $(REF)/src/resid $(REF)/src/resid-fp
	cp $(addprefix $(VENDOR)/,$(REF_VENDOR)) $(REF)/src/
	cp $(VENDOR)/resid/*.cpp $(VENDOR)/resid/*.h $(REF)/src/resid/
	cp $(VENDOR)/resid-fp/*.cpp $(VENDOR)/resid-fp/*.h $(REF)/src/resid-fp/
	cp $(addprefix core/,$(REF_OURS)) $(REF)/src/
	@touch $@

$(REF)/sngrender: $(REF_OBJS) $(REF)/obj/tools/sngrender.o
	$(CXX) -o $@ $^

$(REF)/obj/%.o: $(REF)/src/.stamp
	@mkdir -p $(dir $@)
	@if [ -f $(REF)/src/$*.c ]; then \
		echo $(CC) $(REF)/src/$*.c; $(CC) $(CFLAGS) -I$(REF)/src -c -o $@ $(REF)/src/$*.c; \
	else \
		echo $(CXX) $(REF)/src/$*.cpp; $(CXX) $(CXXFLAGS) -I$(REF)/src -c -o $@ $(REF)/src/$*.cpp; \
	fi

$(REF)/obj/sidkid.o: sidkid.c sidkid.h $(REF)/src/.stamp
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -I$(REF)/src -I. -c -o $@ $<

$(REF)/obj/sidkid_sid.o: sidkid_sid.cpp $(REF)/src/.stamp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -I$(REF)/src -c -o $@ $<

$(REF)/obj/tools/sngrender.o: tools/sngrender.c sidkid.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -I. -c -o $@ $<

# --- test -----------------------------------------------------------------

test: $(NATIVE)/sngrender $(NATIVE)/scantest $(REF)/sngrender wasm
	$(NATIVE)/scantest $(EXAMPLES)/*.sng
	./tools/compare.sh $(NATIVE)/sngrender $(REF)/sngrender $(EXAMPLES) $(BUILD)/test
	$(NODE) tools/wasmcompare.mjs $(BUILD)/wasm/sidkid.js $(EXAMPLES) $(BUILD)/test

# --- wasm -----------------------------------------------------------------

WASM := $(BUILD)/wasm
EMCC ?= emcc
EMXX ?= em++
WASM_OBJS := $(addprefix $(WASM)/core/,$(addsuffix .o,$(CORE_C) $(CORE_CXX))) $(addprefix $(WASM)/,$(API))
WASM_FUNCS := sk_init sk_configure sk_set_model sk_load_song sk_save_song sk_num_subsongs sk_play sk_stop sk_seek sk_scan \
	sk_is_playing sk_song_looped sk_toggle_mute sk_is_muted sk_render sk_render_frame sk_sidregs sk_envelopes sk_frames \
	sk_song_name sk_author_name sk_copyright_name malloc free
comma := ,
empty :=
space := $(empty) $(empty)
WASM_EXPORTS := $(subst $(space),$(comma),$(strip $(addprefix _,$(WASM_FUNCS))))

wasm: $(WASM)/sidkid.js

$(WASM)/sidkid.js: $(WASM_OBJS)
	$(EMXX) -O2 -o $@ $^ \
		-sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createSidKid \
		-sENVIRONMENT=web,worker,node,shell -sALLOW_MEMORY_GROWTH \
		-sINCOMING_MODULE_JS_API=wasmBinary \
		-sEXPORTED_FUNCTIONS=$(WASM_EXPORTS) \
		-sEXPORTED_RUNTIME_METHODS=FS,HEAP16,HEAPU8,UTF8ToString

$(WASM)/core/%.o: core/%.c core/*.h
	@mkdir -p $(dir $@)
	$(EMCC) $(CFLAGS) -Icore -c -o $@ $<

$(WASM)/core/%.o: core/%.cpp
	@mkdir -p $(dir $@)
	$(EMXX) $(CXXFLAGS) -Icore -c -o $@ $<

$(WASM)/%.o: %.c sidkid.h core/*.h
	@mkdir -p $(dir $@)
	$(EMCC) $(CFLAGS) -Icore -I. -c -o $@ $<

$(WASM)/%.o: %.cpp
	@mkdir -p $(dir $@)
	$(EMXX) $(CXXFLAGS) -Icore -c -o $@ $<

clean:
	rm -rf $(BUILD)

.PHONY: all ref test wasm clean
