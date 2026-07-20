/* =========================================================
   Simple Piano — application logic
   Vanilla JS + Tone.js. Organized into small focused modules.
   ========================================================= */
(() => {
  "use strict";

  /* ------------------------------------------------------------------
     1. Note utilities
  ------------------------------------------------------------------ */
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const NOTE_SPOKEN = ["C", "C sharp", "D", "D sharp", "E", "F", "F sharp", "G", "G sharp", "A", "A sharp", "B"];
  const FIRST_MIDI = 21;  // A0
  const LAST_MIDI = 108;  // C8

  const midiToName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
  const isBlack = (m) => [1, 3, 6, 8, 10].includes(m % 12);
  const noteAria = (m) => `${NOTE_SPOKEN[m % 12]} ${Math.floor(m / 12) - 1}`;

  /* ------------------------------------------------------------------
     2. Computer-keyboard mapping (common Virtual Piano layout)
        White: A S D F G H J K L ; '   Black: W E T Y U O P
        Offsets are semitones above the base note; Octave/Transpose shift them.
  ------------------------------------------------------------------ */
  const BASE_MIDI = 60; // C4 sits under "A" by default
  const KEY_MAP = {
    KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7,
    KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15,
    Semicolon: 16, Quote: 17,
  };
  const KEYCAP = {
    KeyA: "A", KeyW: "W", KeyS: "S", KeyE: "E", KeyD: "D", KeyF: "F", KeyT: "T",
    KeyG: "G", KeyY: "Y", KeyH: "H", KeyU: "U", KeyJ: "J", KeyK: "K", KeyO: "O",
    KeyL: "L", KeyP: "P", Semicolon: ";", Quote: "'",
  };

  /* ------------------------------------------------------------------
     3. State
  ------------------------------------------------------------------ */
  const state = {
    started: false,
    transpose: 0,      // -12..+12 semitones
    octave: 0,         // keyboard octave shift, -3..+3
    sustain: false,
    labels: true,
    metronome: false,
    tempo: 120,
    recording: false,
    playing: false,
  };

  const heldCount = new Map();   // midi -> active press count (any source)
  const sustained = new Set();   // midi ringing because sustain is held
  const visualCount = new Map(); // midi -> visual-highlight count
  const pressedKeys = new Map(); // keyboard code -> midi
  const pointerNote = new Map(); // pointerId -> midi (mouse/touch)
  const keyEls = new Map();      // midi -> element

  /* ------------------------------------------------------------------
     4. DOM references
  ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const dom = {
    gate: $("gate"), gateBtn: $("gateBtn"), gateText: $("gateText"),
    keyboard: $("keyboard"), scroll: $("pianoScroll"), scrollHint: $("scrollHint"),
    fx: $("fx"), status: $("status"), srLive: $("srLive"),
    record: $("recordBtn"), play: $("playBtn"), stop: $("stopBtn"),
    metro: $("metroBtn"), tempo: $("tempo"),
    volume: $("volume"), sustain: $("sustainBtn"),
    transDown: $("transDown"), transUp: $("transUp"), transReadout: $("transReadout"),
    octDown: $("octDown"), octUp: $("octUp"), octReadout: $("octReadout"),
    labels: $("labelsBtn"), theme: $("themeBtn"), fs: $("fsBtn"),
    midiDownload: $("midiDownload"), midiUpload: $("midiUploadBtn"), midiFile: $("midiFile"),
    reset: $("resetBtn"),
  };

  const setStatus = (msg, warn = false) => {
    dom.status.textContent = msg;
    dom.status.classList.toggle("warn", warn);
  };
  const announce = (msg) => { dom.srLive.textContent = msg; };

  /* ------------------------------------------------------------------
     5. Audio engine
  ------------------------------------------------------------------ */
  let instrument = null;
  let masterGain = null;
  let analyser = null;
  let metroSynth = null;
  let metroLoop = null;
  let beat = 0;

  const SALAMANDER = "https://tonejs.github.io/audio/salamander/";
  const SAMPLE_URLS = {
    A0: "A0.mp3", C1: "C1.mp3", "D#1": "Ds1.mp3", "F#1": "Fs1.mp3",
    A1: "A1.mp3", C2: "C2.mp3", "D#2": "Ds2.mp3", "F#2": "Fs2.mp3",
    A2: "A2.mp3", C3: "C3.mp3", "D#3": "Ds3.mp3", "F#3": "Fs3.mp3",
    A3: "A3.mp3", C4: "C4.mp3", "D#4": "Ds4.mp3", "F#4": "Fs4.mp3",
    A4: "A4.mp3", C5: "C5.mp3", "D#5": "Ds5.mp3", "F#5": "Fs5.mp3",
    A5: "A5.mp3", C6: "C6.mp3", "D#6": "Ds6.mp3", "F#6": "Fs6.mp3",
    A6: "A6.mp3", C7: "C7.mp3", "D#7": "Ds7.mp3", "F#7": "Fs7.mp3",
    A7: "A7.mp3", C8: "C8.mp3",
  };

  const makeSynth = () =>
    new Tone.PolySynth(Tone.Synth, {
      maxPolyphony: 64,
      oscillator: { type: "triangle" },
      envelope: { attack: 0.004, decay: 0.7, sustain: 0.12, release: 1.4 },
      volume: -6,
    });

  function loadInstrument() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (inst, mode) => { if (!done) { done = true; resolve({ inst, mode }); } };
      let sampler;
      try {
        sampler = new Tone.Sampler({
          urls: SAMPLE_URLS,
          baseUrl: SALAMANDER,
          release: 1.4,
          onload: () => finish(sampler, "sampler"),
        });
      } catch (e) {
        return finish(makeSynth(), "synth");
      }
      // Fall back to a synth if samples don't arrive quickly (e.g. offline).
      setTimeout(() => finish(makeSynth(), "synth"), 9000);
    });
  }

  async function startAudio() {
    if (state.started) return;
    await Tone.start();

    masterGain = new Tone.Gain(volumeToGain(dom.volume.value)).toDestination();
    analyser = new Tone.Analyser("waveform", 256);
    masterGain.connect(analyser);

    metroSynth = new Tone.MembraneSynth({
      pitchDecay: 0.008, octaves: 4,
      envelope: { attack: 0.001, decay: 0.18, sustain: 0 }, volume: -8,
    }).connect(masterGain);

    setStatus("Loading grand piano samples…");
    const { inst, mode } = await loadInstrument();
    instrument = inst;
    instrument.connect(masterGain);

    Tone.Transport.bpm.value = state.tempo;
    state.started = true;
    dom.gate.classList.add("is-hidden");
    setStatus(mode === "sampler" ? "Ready. Play something." : "Ready (synth mode — samples unavailable offline).");
    centerOnMiddleC();
  }

  const volumeToGain = (v) => Math.pow(Number(v) / 100, 1.6) * 1.1;

  /* ------------------------------------------------------------------
     6. Note on / off  (ref-counted, sustain-aware)
  ------------------------------------------------------------------ */
  function attack(midi, velocity = 0.85) {
    if (midi < FIRST_MIDI || midi > LAST_MIDI || !instrument) return;
    const c = heldCount.get(midi) || 0;
    heldCount.set(midi, c + 1);
    setKeyVisual(midi, true);
    if (c === 0) {
      sustained.delete(midi);
      instrument.triggerAttack(midiToName(midi), Tone.now(), velocity);
      openRecordNote(midi, velocity);
      spawnParticles(midi, velocity);
    }
  }

  function release(midi) {
    const c = heldCount.get(midi) || 0;
    if (c === 0) return;
    setKeyVisual(midi, false); // key visually rises on physical release
    if (c > 1) { heldCount.set(midi, c - 1); return; }
    heldCount.delete(midi);
    if (state.sustain) {
      sustained.add(midi); // keep ringing until pedal lifts
    } else {
      stopSound(midi);
    }
  }

  function stopSound(midi) {
    if (!instrument) return;
    instrument.triggerRelease(midiToName(midi), Tone.now());
    closeRecordNote(midi);
  }

  function applySustain(on) {
    state.sustain = on;
    if (!on) {
      sustained.forEach((midi) => { if (!heldCount.has(midi)) stopSound(midi); });
      sustained.clear();
    }
    dom.sustain.classList.toggle("is-on", on);
    dom.sustain.setAttribute("aria-pressed", String(on));
  }

  function panic() {
    heldCount.clear(); sustained.clear(); pressedKeys.clear(); pointerNote.clear();
    visualCount.clear();
    keyEls.forEach((el) => el.classList.remove("is-active"));
    if (instrument && instrument.releaseAll) instrument.releaseAll();
  }

  /* ------------------------------------------------------------------
     7. Key visuals
  ------------------------------------------------------------------ */
  function setKeyVisual(midi, on) {
    const el = keyEls.get(midi);
    if (!el) return;
    let c = visualCount.get(midi) || 0;
    c = on ? c + 1 : Math.max(0, c - 1);
    visualCount.set(midi, c);
    el.classList.toggle("is-active", c > 0);
  }

  /* ------------------------------------------------------------------
     8. Build the 88-key keyboard
  ------------------------------------------------------------------ */
  function buildKeyboard() {
    const frag = document.createDocumentFragment();
    let whiteIndex = 0;
    for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) {
      const black = isBlack(m);
      const el = document.createElement("button");
      el.type = "button";
      el.className = "key " + (black ? "key--black" : "key--white");
      el.dataset.midi = m;
      el.tabIndex = m === BASE_MIDI ? 0 : -1; // roving tabindex, starts on middle C
      el.setAttribute("aria-label", noteAria(m));

      if (black) {
        el.style.setProperty("--w", whiteIndex);
      } else {
        el.style.setProperty("--i", whiteIndex);
        whiteIndex++;
      }

      const label = document.createElement("span");
      label.className = "key__label";
      el.appendChild(label);

      keyEls.set(m, el);
      frag.appendChild(el);
    }
    dom.keyboard.appendChild(frag);
    updateKeyLabels();
  }

  function updateKeyLabels() {
    keyEls.forEach((el) => { el.firstChild.textContent = ""; });
    for (const code in KEY_MAP) {
      const midi = BASE_MIDI + KEY_MAP[code] + state.octave * 12 + state.transpose;
      const el = keyEls.get(midi);
      if (el) el.firstChild.textContent = KEYCAP[code];
    }
  }

  function centerOnMiddleC() {
    const el = keyEls.get(BASE_MIDI);
    if (!el) return;
    const target = el.offsetLeft - dom.scroll.clientWidth / 2 + el.offsetWidth / 2;
    dom.scroll.scrollLeft = Math.max(0, target);
    maybeShowScrollHint();
  }

  function maybeShowScrollHint() {
    const overflow = dom.keyboard.scrollWidth > dom.scroll.clientWidth + 8;
    dom.scrollHint.classList.toggle("show", overflow);
    if (overflow) setTimeout(() => dom.scrollHint.classList.remove("show"), 4200);
  }

  /* ------------------------------------------------------------------
     9. Pointer input (mouse + touch, with glissando & multi-touch)
  ------------------------------------------------------------------ */
  function midiFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const key = el && el.closest(".key");
    return key ? Number(key.dataset.midi) : null;
  }

  function initPointer() {
    const kb = dom.keyboard;
    kb.addEventListener("pointerdown", (e) => {
      const midi = midiFromPoint(e.clientX, e.clientY);
      if (midi == null) return;
      try { kb.setPointerCapture(e.pointerId); } catch (_) {}
      pointerNote.set(e.pointerId, midi);
      attack(midi, 0.9);
      e.preventDefault();
    });
    kb.addEventListener("pointermove", (e) => {
      if (!pointerNote.has(e.pointerId)) return;
      const prev = pointerNote.get(e.pointerId);
      const midi = midiFromPoint(e.clientX, e.clientY);
      if (midi !== prev) {
        if (prev != null) release(prev);
        if (midi != null) attack(midi, 0.8);
        pointerNote.set(e.pointerId, midi);
      }
      e.preventDefault();
    });
    const end = (e) => {
      if (!pointerNote.has(e.pointerId)) return;
      const midi = pointerNote.get(e.pointerId);
      if (midi != null) release(midi);
      pointerNote.delete(e.pointerId);
    };
    kb.addEventListener("pointerup", end);
    kb.addEventListener("pointercancel", end);
    // Block page scroll/gestures while touching keys.
    kb.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  }

  /* ------------------------------------------------------------------
     10. Computer keyboard input + roving-tabindex accessibility
  ------------------------------------------------------------------ */
  const isTextTarget = (t) =>
    t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

  function initComputerKeys() {
    window.addEventListener("keydown", (e) => {
      if (isTextTarget(e.target)) return;

      // Roving focus + play when a key element is focused.
      const focusedKey = e.target.closest && e.target.closest(".key");

      // Transport shortcut: Space toggles play / stop (unless a key/button has focus).
      if (e.code === "Space" && !focusedKey && !e.target.closest(".btn")) {
        e.preventDefault();
        state.playing ? stopSequence() : playRecording();
        return;
      }

      if (focusedKey) {
        if (e.code === "ArrowRight" || e.code === "ArrowLeft" || e.code === "Home" || e.code === "End") {
          e.preventDefault();
          moveKeyFocus(Number(focusedKey.dataset.midi), e.code);
          return;
        }
        if (e.code === "Enter" || e.code === "Space") {
          e.preventDefault();
          const midi = Number(focusedKey.dataset.midi);
          attack(midi, 0.9);
          setTimeout(() => release(midi), 220);
          return;
        }
      }

      const off = KEY_MAP[e.code];
      if (off === undefined || e.repeat) return;
      e.preventDefault();
      const midi = BASE_MIDI + off + state.octave * 12 + state.transpose;
      if (pressedKeys.has(e.code)) return;
      pressedKeys.set(e.code, midi);
      attack(midi, 0.92);
    });

    window.addEventListener("keyup", (e) => {
      if (!pressedKeys.has(e.code)) return;
      release(pressedKeys.get(e.code));
      pressedKeys.delete(e.code);
    });
  }

  function moveKeyFocus(midi, code) {
    let next = midi;
    if (code === "ArrowRight") next = Math.min(LAST_MIDI, midi + 1);
    else if (code === "ArrowLeft") next = Math.max(FIRST_MIDI, midi - 1);
    else if (code === "Home") next = FIRST_MIDI;
    else if (code === "End") next = LAST_MIDI;
    const cur = keyEls.get(midi), nx = keyEls.get(next);
    if (cur) cur.tabIndex = -1;
    if (nx) { nx.tabIndex = 0; nx.focus(); }
  }

  /* ------------------------------------------------------------------
     11. Web MIDI input
  ------------------------------------------------------------------ */
  function initWebMidi() {
    if (!navigator.requestMIDIAccess) return;
    navigator.requestMIDIAccess().then((access) => {
      const attachAll = () => {
        for (const input of access.inputs.values()) input.onmidimessage = onMidiMessage;
      };
      attachAll();
      access.onstatechange = attachAll;
      if (access.inputs.size > 0) setStatus("MIDI device connected.");
    }).catch(() => { /* permission denied — silent */ });
  }

  function onMidiMessage(msg) {
    const [status, note, velocity] = msg.data;
    const cmd = status & 0xf0;
    const midi = note + state.transpose;
    if (cmd === 0x90 && velocity > 0) attack(midi, velocity / 127);
    else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) release(midi);
  }

  /* ------------------------------------------------------------------
     12. Recorder
  ------------------------------------------------------------------ */
  let recorded = [];          // [{midi, velocity, time, duration}]
  const openNotes = new Map();// midi -> note object being recorded
  let recStart = 0;

  function openRecordNote(midi, velocity) {
    if (!state.recording) return;
    const note = { midi, velocity, time: Tone.now() - recStart, duration: 0 };
    recorded.push(note);
    openNotes.set(midi, note);
  }
  function closeRecordNote(midi) {
    const note = openNotes.get(midi);
    if (!note) return;
    note.duration = Math.max(0.05, Tone.now() - recStart - note.time);
    openNotes.delete(midi);
  }

  function toggleRecording() {
    if (!state.started) return;
    state.recording ? stopRecording() : startRecording();
  }
  function startRecording() {
    stopSequence();
    recorded = [];
    openNotes.clear();
    recStart = Tone.now();
    state.recording = true;
    dom.record.classList.add("is-recording");
    dom.record.setAttribute("aria-pressed", "true");
    setStatus("Recording…");
    updateTransportUI();
  }
  function stopRecording() {
    state.recording = false;
    openNotes.forEach((note) => {
      note.duration = Math.max(0.05, Tone.now() - recStart - note.time);
    });
    openNotes.clear();
    dom.record.classList.remove("is-recording");
    dom.record.setAttribute("aria-pressed", "false");
    setStatus(recorded.length ? `Recorded ${recorded.length} notes.` : "Nothing recorded.");
    updateTransportUI();
  }

  /* ------------------------------------------------------------------
     13. Player (recording + imported MIDI) — timer-based for clean stop
  ------------------------------------------------------------------ */
  let playTimers = [];

  function playSequence(notes, label) {
    if (!notes.length) { setStatus("Nothing to play."); return; }
    stopSequence();
    if (state.recording) stopRecording();
    state.playing = true;
    updateTransportUI();
    setStatus(label);

    let maxEnd = 0;
    for (const n of notes) {
      const end = n.time + n.duration;
      if (end > maxEnd) maxEnd = end;
      playTimers.push(setTimeout(() => {
        if (!instrument) return;
        instrument.triggerAttackRelease(midiToName(n.midi), n.duration, undefined, n.velocity);
        setKeyVisual(n.midi, true);
        spawnParticles(n.midi, n.velocity);
        playTimers.push(setTimeout(() => setKeyVisual(n.midi, false), n.duration * 1000));
      }, n.time * 1000));
    }
    playTimers.push(setTimeout(() => {
      state.playing = false;
      updateTransportUI();
      setStatus("Playback finished.");
    }, maxEnd * 1000 + 250));
  }

  function stopSequence() {
    playTimers.forEach(clearTimeout);
    playTimers = [];
    if (state.playing && instrument && instrument.releaseAll) instrument.releaseAll();
    visualCount.clear();
    keyEls.forEach((el) => el.classList.remove("is-active"));
    state.playing = false;
    updateTransportUI();
  }

  const playRecording = () => playSequence(recorded, "Playing recording…");

  function updateTransportUI() {
    const hasRec = recorded.length > 0;
    dom.play.disabled = !hasRec || state.playing;
    dom.stop.disabled = !state.playing;
    dom.midiDownload.disabled = !hasRec;
    dom.record.disabled = state.playing;
  }

  /* ------------------------------------------------------------------
     14. Metronome
  ------------------------------------------------------------------ */
  function toggleMetronome() {
    if (!state.started) return;
    state.metronome = !state.metronome;
    dom.metro.classList.toggle("is-on", state.metronome);
    dom.metro.setAttribute("aria-pressed", String(state.metronome));
    if (state.metronome) {
      beat = 0;
      if (!metroLoop) {
        metroLoop = new Tone.Loop((time) => {
          const strong = beat % 4 === 0;
          metroSynth.triggerAttackRelease(strong ? "C3" : "G2", "32n", time, strong ? 1 : 0.6);
          beat++;
        }, "4n");
      }
      Tone.Transport.start();
      metroLoop.start(0);
      setStatus(`Metronome on · ${state.tempo} BPM`);
    } else {
      if (metroLoop) metroLoop.stop();
      Tone.Transport.pause();
      setStatus("Metronome off.");
    }
  }

  function setTempo(v) {
    const t = Math.min(240, Math.max(40, Math.round(Number(v) || 120)));
    state.tempo = t;
    dom.tempo.value = t;
    if (state.started) Tone.Transport.bpm.value = t;
    if (state.metronome) setStatus(`Metronome on · ${t} BPM`);
  }

  /* ------------------------------------------------------------------
     15. MIDI file: export & import
  ------------------------------------------------------------------ */
  function resolveMidiCtor() {
    const lib = window.Midi;
    if (!lib) return null;
    return typeof lib === "function" ? lib : lib.Midi || null;
  }

  function downloadMidi() {
    const Ctor = resolveMidiCtor();
    if (!Ctor) { setStatus("MIDI library unavailable.", true); return; }
    if (!recorded.length) return;
    const midi = new Ctor();
    const track = midi.addTrack();
    for (const n of recorded) {
      track.addNote({
        midi: n.midi,
        time: n.time,
        duration: Math.max(0.05, n.duration),
        velocity: n.velocity,
      });
    }
    const blob = new Blob([midi.toArray()], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "simple-piano-recording.mid";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("Downloaded recording as MIDI.");
  }

  async function importMidi(file) {
    const Ctor = resolveMidiCtor();
    if (!Ctor) { setStatus("MIDI library unavailable.", true); return; }
    try {
      const buf = await file.arrayBuffer();
      const midi = new Ctor(buf);
      const notes = [];
      midi.tracks.forEach((tr) => {
        tr.notes.forEach((n) => {
          if (n.midi >= FIRST_MIDI && n.midi <= LAST_MIDI) {
            notes.push({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity || 0.8 });
          }
        });
      });
      notes.sort((a, b) => a.time - b.time);
      if (!notes.length) { setStatus("No playable notes in that file.", true); return; }
      playSequence(notes, `Playing “${file.name}” · ${notes.length} notes…`);
    } catch (err) {
      setStatus("Could not read that MIDI file.", true);
    }
  }

  /* ------------------------------------------------------------------
     16. Visual FX — reactive waveform + particles
  ------------------------------------------------------------------ */
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let ctx = null, dpr = 1, fxW = 0, fxH = 0, particles = [], rafId = 0;

  function initFx() {
    if (reducedMotion) return;
    ctx = dom.fx.getContext("2d");
    resizeFx();
    window.addEventListener("resize", resizeFx);
    rafId = requestAnimationFrame(drawFx);
  }
  function resizeFx() {
    if (!ctx) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = dom.fx.getBoundingClientRect();
    fxW = r.width; fxH = r.height;
    dom.fx.width = Math.floor(fxW * dpr);
    dom.fx.height = Math.floor(fxH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawnParticles(midi, velocity) {
    if (reducedMotion || !ctx) return;
    const el = keyEls.get(midi);
    if (!el) return;
    const kr = el.getBoundingClientRect();
    const cr = dom.fx.getBoundingClientRect();
    const x = kr.left - cr.left + kr.width / 2;
    const y = kr.top - cr.top + kr.height * 0.14;
    const n = 3 + Math.round(velocity * 4);
    for (let i = 0; i < n; i++) {
      particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 0.6,
        vy: -0.7 - Math.random() * 1.1 - velocity,
        life: 1,
        size: 1.5 + Math.random() * 2.5,
      });
    }
    if (particles.length > 260) particles.splice(0, particles.length - 260);
  }

  function drawFx() {
    rafId = requestAnimationFrame(drawFx);
    if (!ctx) return;
    ctx.clearRect(0, 0, fxW, fxH);

    // Reactive waveform ribbon near the lower third of the keys.
    if (analyser && state.started) {
      const buf = analyser.getValue();
      const mid = fxH * 0.82;
      ctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / (buf.length - 1)) * fxW;
        const y = mid + buf[i] * fxH * 0.14;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = "rgba(99,102,241,0.30)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy; p.vy += 0.03; p.life -= 0.02;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life) * 0.7;
      ctx.fillStyle = "#6366F1";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------------
     17. Theme, fullscreen, transpose/octave, reset
  ------------------------------------------------------------------ */
  function toggleTheme() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    dom.theme.setAttribute("aria-pressed", String(!dark));
    document.querySelector('meta[name="theme-color"]').setAttribute("content", dark ? "#F6F7FB" : "#0B0C12");
  }

  function toggleLabels() {
    state.labels = !state.labels;
    document.body.classList.toggle("labels-off", !state.labels);
    dom.labels.classList.toggle("is-on", state.labels);
    dom.labels.setAttribute("aria-pressed", String(state.labels));
  }

  function toggleFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    }
  }

  function setTranspose(v) {
    state.transpose = Math.min(12, Math.max(-12, v));
    dom.transReadout.textContent = (state.transpose > 0 ? "+" : "") + state.transpose;
    updateKeyLabels();
  }
  function setOctave(v) {
    state.octave = Math.min(3, Math.max(-3, v));
    dom.octReadout.textContent = (state.octave > 0 ? "+" : "") + state.octave;
    updateKeyLabels();
  }

  function resetAll() {
    stopSequence();
    if (state.recording) stopRecording();
    if (state.metronome) toggleMetronome();
    panic();
    recorded = [];
    openNotes.clear();
    setTranspose(0);
    setOctave(0);
    setTempo(120);
    if (state.sustain) applySustain(false);
    if (!state.labels) toggleLabels();
    dom.volume.value = 78;
    if (masterGain) masterGain.gain.rampTo(volumeToGain(78), 0.05);
    updateTransportUI();
    setStatus("Reset. Fresh start.");
    announce("All controls reset.");
  }

  /* ------------------------------------------------------------------
     18. Wire up controls
  ------------------------------------------------------------------ */
  function initControls() {
    dom.gateBtn.addEventListener("click", startAudio);
    dom.gate.addEventListener("click", (e) => { if (e.target === dom.gate) startAudio(); });

    dom.record.addEventListener("click", toggleRecording);
    dom.play.addEventListener("click", playRecording);
    dom.stop.addEventListener("click", stopSequence);
    dom.metro.addEventListener("click", toggleMetronome);
    dom.tempo.addEventListener("change", (e) => setTempo(e.target.value));

    dom.volume.addEventListener("input", (e) => {
      if (masterGain) masterGain.gain.rampTo(volumeToGain(e.target.value), 0.04);
    });
    dom.sustain.addEventListener("click", () => applySustain(!state.sustain));

    dom.transDown.addEventListener("click", () => setTranspose(state.transpose - 1));
    dom.transUp.addEventListener("click", () => setTranspose(state.transpose + 1));
    dom.octDown.addEventListener("click", () => setOctave(state.octave - 1));
    dom.octUp.addEventListener("click", () => setOctave(state.octave + 1));

    dom.labels.addEventListener("click", toggleLabels);
    dom.theme.addEventListener("click", toggleTheme);
    dom.fs.addEventListener("click", toggleFullscreen);

    dom.midiDownload.addEventListener("click", downloadMidi);
    dom.midiUpload.addEventListener("click", () => dom.midiFile.click());
    dom.midiFile.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importMidi(f);
      e.target.value = "";
    });
    dom.reset.addEventListener("click", resetAll);

    dom.scroll.addEventListener("scroll", () => dom.scrollHint.classList.remove("show"), { once: true });
    window.addEventListener("resize", maybeShowScrollHint);
    // Release everything if the tab loses focus (prevents stuck notes).
    window.addEventListener("blur", () => { if (state.started) panic(); });
  }

  /* ------------------------------------------------------------------
     19. Init
  ------------------------------------------------------------------ */
  function init() {
    if (typeof Tone === "undefined") {
      setStatus("Could not load the audio engine. Check your connection and refresh.", true);
      dom.gateText.textContent = "Audio engine failed to load. Refresh the page while online.";
      return;
    }
    buildKeyboard();
    initPointer();
    initComputerKeys();
    initControls();
    initFx();
    initWebMidi();
    updateTransportUI();
    maybeShowScrollHint();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
