// General MIDI catalogue, drum maps and the online instrument libraries.

// Slugs exactly as used by https://gleitz.github.io/midi-js-soundfonts/<library>/<slug>-mp3.js
export const GM_SLUGS = 'acoustic_grand_piano bright_acoustic_piano electric_grand_piano honkytonk_piano electric_piano_1 electric_piano_2 harpsichord clavinet celesta glockenspiel music_box vibraphone marimba xylophone tubular_bells dulcimer drawbar_organ percussive_organ rock_organ church_organ reed_organ accordion harmonica tango_accordion acoustic_guitar_nylon acoustic_guitar_steel electric_guitar_jazz electric_guitar_clean electric_guitar_muted overdriven_guitar distortion_guitar guitar_harmonics acoustic_bass electric_bass_finger electric_bass_pick fretless_bass slap_bass_1 slap_bass_2 synth_bass_1 synth_bass_2 violin viola cello contrabass tremolo_strings pizzicato_strings orchestral_harp timpani string_ensemble_1 string_ensemble_2 synth_strings_1 synth_strings_2 choir_aahs voice_oohs synth_choir orchestra_hit trumpet trombone tuba muted_trumpet french_horn brass_section synth_brass_1 synth_brass_2 soprano_sax alto_sax tenor_sax baritone_sax oboe english_horn bassoon clarinet piccolo flute recorder pan_flute blown_bottle shakuhachi whistle ocarina lead_1_square lead_2_sawtooth lead_3_calliope lead_4_chiff lead_5_charang lead_6_voice lead_7_fifths lead_8_bass__lead pad_1_new_age pad_2_warm pad_3_polysynth pad_4_choir pad_5_bowed pad_6_metallic pad_7_halo pad_8_sweep fx_1_rain fx_2_soundtrack fx_3_crystal fx_4_atmosphere fx_5_brightness fx_6_goblins fx_7_echoes fx_8_scifi sitar banjo shamisen koto kalimba bagpipe fiddle shanai tinkle_bell agogo steel_drums woodblock taiko_drum melodic_tom synth_drum reverse_cymbal guitar_fret_noise breath_noise seashore bird_tweet telephone_ring helicopter applause gunshot'.split(' ');

export const GM_NAMES = ['Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Nylon Guitar', 'Steel Guitar', 'Jazz Guitar', 'Clean Guitar', 'Muted Guitar', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Finger Bass', 'Pick Bass', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Choir', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Square Lead', 'Saw Lead', 'Calliope Lead', 'Chiff Lead', 'Charang Lead', 'Voice Lead', 'Fifths Lead', 'Bass + Lead',
  'New Age Pad', 'Warm Pad', 'Polysynth Pad', 'Choir Pad', 'Bowed Pad', 'Metallic Pad', 'Halo Pad', 'Sweep Pad',
  'Rain FX', 'Soundtrack FX', 'Crystal FX', 'Atmosphere FX', 'Brightness FX', 'Goblins FX', 'Echoes FX', 'Sci-fi FX',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'];

export const GM_FAMILIES = [
  { name: 'Piano', color: '#a78bfa' }, { name: 'Chromatic Perc.', color: '#f0abfc' }, { name: 'Organ', color: '#fbbf24' },
  { name: 'Guitar', color: '#fb923c' }, { name: 'Bass', color: '#60a5fa' }, { name: 'Strings', color: '#f472b6' },
  { name: 'Ensemble & Choir', color: '#e879f9' }, { name: 'Brass', color: '#facc15' }, { name: 'Reed', color: '#a3e635' },
  { name: 'Pipe', color: '#4ade80' }, { name: 'Synth Lead', color: '#22d3ee' }, { name: 'Synth Pad', color: '#818cf8' },
  { name: 'Synth FX', color: '#2dd4bf' }, { name: 'Ethnic', color: '#fdba74' }, { name: 'Percussive', color: '#fda4af' },
  { name: 'Sound FX', color: '#94a3b8' },
];
export const familyOf = (program) => GM_FAMILIES[Math.floor(program / 8)];

export const LIBRARIES = [
  { id: 'FluidR3_GM', name: 'FluidR3 GM', desc: 'Balanced and light (~1-3 MB per instrument)' },
  { id: 'MusyngKite', name: 'Musyng Kite', desc: 'Richest samples, larger downloads' },
  { id: 'FatBoy', name: 'FatBoy', desc: 'Punchy and characterful' },
];

// Instruments whose notes should sustain past the sample length (looped).
export const isSustained = (p) =>
  (p >= 16 && p <= 23) || (p >= 40 && p <= 44) || (p >= 48 && p <= 54) || (p >= 56 && p <= 95) || (p >= 109 && p <= 111);

export function releaseFor(p) {
  if (p >= 88 && p <= 103) return 0.9;  // pads, fx
  if (p >= 48 && p <= 54) return 0.45;  // ensembles
  if (p >= 40 && p <= 44) return 0.35;
  if (p >= 16 && p <= 23) return 0.08;  // organs
  if (p >= 56 && p <= 79) return 0.16;  // brass / reed / pipe
  if (p >= 80 && p <= 87) return 0.12;
  return 0.3;
}

// ------------------------------------------------------------------ drums

export const DRUM_NAMES = {
  35: 'Kick 2', 36: 'Kick', 37: 'Side Stick', 38: 'Snare', 39: 'Clap', 40: 'Snare 2', 41: 'Floor Tom L', 42: 'Closed HH',
  43: 'Floor Tom H', 44: 'Pedal HH', 45: 'Low Tom', 46: 'Open HH', 47: 'Low-Mid Tom', 48: 'Hi-Mid Tom', 49: 'Crash', 50: 'High Tom',
  51: 'Ride', 52: 'China', 53: 'Ride Bell', 54: 'Tambourine', 55: 'Splash', 56: 'Cowbell', 57: 'Crash 2', 58: 'Vibraslap',
  59: 'Ride 2', 60: 'Hi Bongo', 61: 'Lo Bongo', 62: 'Mute Conga', 63: 'Open Conga', 64: 'Low Conga', 65: 'Hi Timbale', 66: 'Lo Timbale',
  67: 'Hi Agogo', 68: 'Lo Agogo', 69: 'Cabasa', 70: 'Maracas', 71: 'Whistle S', 72: 'Whistle L', 73: 'Guiro S', 74: 'Guiro L',
  75: 'Claves', 76: 'Wood Block H', 77: 'Wood Block L', 78: 'Cuica M', 79: 'Cuica O', 80: 'Triangle M', 81: 'Triangle O',
};

export const DRUM_KITS = [
  { id: 'gm-fluid', name: 'Standard Kit', desc: 'Full GM acoustic kit · FluidR3', source: 'surikov', file: '0_FluidR3_GM_sf2_file' },
  { id: 'gm-chaos', name: 'Chaos Kit', desc: 'Full GM kit · Chaos soundfont', source: 'surikov', file: '0_Chaos_sf2_file' },
  { id: 'gm-jclive', name: 'Live Kit', desc: 'Full GM kit · JCLive soundfont', source: 'surikov', file: '0_JCLive_sf2_file' },
  { id: 'tj-acoustic-kit', name: 'Acoustic Kit', desc: 'Studio acoustic drums', source: 'tonejs', dir: 'acoustic-kit' },
  { id: 'tj-CR78', name: 'CR-78', desc: 'Vintage Roland drum machine', source: 'tonejs', dir: 'CR78' },
  { id: 'tj-KPR77', name: 'KPR-77', desc: 'Korg drum machine', source: 'tonejs', dir: 'KPR77' },
  { id: 'tj-LINN', name: 'LinnDrum', desc: '80s sampled drum machine', source: 'tonejs', dir: 'LINN' },
  { id: 'tj-R8', name: 'Roland R-8', desc: 'Late-80s PCM drums', source: 'tonejs', dir: 'R8' },
  { id: 'tj-Techno', name: 'Techno', desc: 'Hard electronic kit', source: 'tonejs', dir: 'Techno' },
  { id: 'tj-4OP-FM', name: '4-OP FM', desc: 'FM-synthesised drums', source: 'tonejs', dir: '4OP-FM' },
  { id: 'tj-Stark', name: 'Stark', desc: 'Crunchy lo-fi kit', source: 'tonejs', dir: 'Stark' },
  { id: 'tj-Kit3', name: 'Kit 3', desc: 'Electronic kit', source: 'tonejs', dir: 'Kit3' },
  { id: 'tj-Kit8', name: 'Kit 8', desc: 'Electronic kit', source: 'tonejs', dir: 'Kit8' },
  { id: 'tj-breakbeat8', name: 'Breakbeat', desc: 'Chopped break hits', source: 'tonejs', dir: 'breakbeat8' },
  { id: 'tj-Bongos', name: 'Bongos', desc: 'Hand percussion', source: 'tonejs', dir: 'Bongos' },
  { id: 'synth-808', name: 'BasicDAW 808', desc: 'Synthesised kit · works offline', source: 'synth' },
];
export const drumKit = (id) => DRUM_KITS.find((k) => k.id === id) || DRUM_KITS[0];

// ------------------------------------------------------------------ instrument specs

export function instrumentLabel(spec) {
  if (!spec) return 'No instrument';
  if (spec.kind === 'gm') return GM_NAMES[spec.program] ?? `Program ${spec.program}`;
  if (spec.kind === 'drums') return drumKit(spec.kit).name;
  if (spec.kind === 'synth') return SYNTH_NAMES[spec.preset] ?? spec.preset;
  return 'Instrument';
}

export function instrumentSub(spec) {
  if (!spec) return '';
  if (spec.kind === 'gm') return `${LIBRARIES.find((l) => l.id === spec.library)?.name ?? spec.library} · GM ${spec.program + 1}`;
  if (spec.kind === 'drums') return `Drum kit · ${drumKit(spec.kit).desc}`;
  if (spec.kind === 'synth') return 'BasicDAW synth · offline';
  return '';
}

export const isDrumSpec = (spec) => spec?.kind === 'drums';

// Names for the built-in synth presets (their sound design lives in audio/synth.js).
export const SYNTH_NAMES = {
  'saw-lead': 'Neon Saw Lead', 'square-lead': 'Square Lead', supersaw: 'Supersaw', 'warm-pad': 'Warm Pad', 'glass-pad': 'Glass Pad',
  'sub-bass': 'Sub Bass', 'reese-bass': 'Reese Bass', acid: 'Acid 303', pluck: 'Pluck', 'fm-bell': 'FM Bell', 'fm-keys': 'FM E-Piano',
  chip: 'Chiptune', 'synth-brass': 'Synth Brass', 'soft-lead': 'Soft Lead',
};
