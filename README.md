# SIDKid

Make real Commodore 64 SID music in the browser

Built on the GoatTracker 2 engine by Lasse Öörni (Cadaver): SIDKid provides
a familiar, fully graphical interface to the SID chip and many Goattracker 
features. Build complex instruments with graphical tools, and sequence them
in a DAW style timeline. Then export the result to audio, .sid or .sng files,
and take them to VICE or a real C64.

**Try it out: [needlestack.github.io/sidkid](https://needlestack.github.io/sidkid/)**

- **Instrument Maker**: control a sound over time: volume envelope, waveform
changes, pitch steps, vibrato, and filter sweeps.
- **Song Maker**: play instruments using the SID's three voices in a timeline with a piano roll. Stack more than three voices and they grab from each other.
- **Export** songs as a C64 disk (`.d64`) that loads and plays by itself (drop
  it on VICE), a SID file, a GoatTracker song, or a WAV.
- **Import** many GoatTracker songs into SIDKid to check them out and play

Want to know more? Read the **[quick start](docs/quickstart.md)**.

<a href="https://needlestack.github.io/sidkid/instruments.html"><img src="docs/images/instrument-maker.png" width="49%" alt="The Instrument Maker"></a>
<a href="https://needlestack.github.io/sidkid/songs.html"><img src="docs/images/song-maker.png" width="49%" alt="The Song Maker"></a>

Open the [Instrument Maker](https://needlestack.github.io/sidkid/instruments.html) or the [Song Maker](https://needlestack.github.io/sidkid/songs.html).

Building it or working on it? See [SIDKid for developers](docs/development.md).


## License

GPL v2, as GoatTracker (see `LICENSE`). It includes:

- GoatTracker 2 and reSID (GPL v2);
- GoatTracker's assembler by Magnus Lind (`engine/core/asm/`), free for
  non-commercial, non-profit use (see its file headers);
- d64lib from GMC64 (`web/src/d64lib.js`, MIT).
