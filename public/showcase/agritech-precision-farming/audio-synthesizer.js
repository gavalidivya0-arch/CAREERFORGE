/**
 * AgritechPrecisionFarmingSoundSynthesizer
 * Programmatic Web Audio chime & tone engine for Agritech Precision Farming.
 * Generates interactive synthetic tones for agricultural IoT sensor alerts,
 * valve actuations, harvest completion chimes, and pump failure buzzers.
 */

// Each preset sound is a list of note definitions: [frequency in Hz, wave shape, duration in seconds, start offset in seconds].
export const SOUNDS = {
  click: [[880, 'triangle', 0.05, 0]],
  navigation: [[392, 'sine', 0.09, 0], [587.33, 'sine', 0.12, 0.07]],
  success: [[523.25, 'sine', 0.12, 0], [659.25, 'sine', 0.12, 0.1], [783.99, 'sine', 0.22, 0.2]],
  warning: [[740, 'square', 0.12, 0], [740, 'square', 0.12, 0.2]],
  error: [[160, 'sawtooth', 0.18, 0], [120, 'sawtooth', 0.28, 0.2]],
};

const SILENCE = 0.0001;

export class AgritechPrecisionFarmingSoundSynthesizer {
  constructor({ createContext = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)() } = {}) {
    this.createContext = createContext;
    this.context = null;
    this.output = null;
    this.analyser = null;
    this.volume = 0.5;
    this.muted = false;
    // Context time at which the last queued tone finishes.
    this.busyUntil = 0;
  }

  /**
   * Lazily initializes the Web Audio context on the first user interaction.
   * Browsers require user gesture before starting audio playback.
   */
  ensureContext() {
    if (!this.context) {
      this.context = this.createContext();
      this.output = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.output.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      this.updateOutput();
    }
    if (this.context.state === 'suspended') {
      this.context.resume();
    }
    return this.context;
  }

  /**
   * Updates output gain based on volume level and mute state.
   */
  updateOutput() {
    if (this.output) {
      this.output.gain.value = this.muted ? 0 : this.volume;
    }
  }

  /**
   * Sets volume level between 0 and 1. Clamps out-of-range values.
   * @param {number} level
   * @returns {number}
   */
  setVolume(level) {
    if (typeof level === 'number' && Number.isFinite(level)) {
      this.volume = Math.min(1, Math.max(0, level));
      this.updateOutput();
    }
    return this.volume;
  }

  /**
   * Toggles or sets audio mute status.
   * @param {boolean} muted
   * @returns {boolean}
   */
  setMuted(muted) {
    this.muted = Boolean(muted);
    this.updateOutput();
    return this.muted;
  }

  /**
   * Plays a single synthetic frequency tone.
   * @param {number} freq - Frequency in Hertz
   * @param {string} [type='sine'] - Oscillator wave type ('sine', 'triangle', 'square', 'sawtooth')
   * @param {number} [duration=0.15] - Duration in seconds
   * @param {number} [offset=0] - Delay offset before tone starts
   * @returns {boolean}
   */
  playTone(freq, type = 'sine', duration = 0.15, offset = 0) {
    if (!Number.isFinite(freq) || freq <= 0 || !Number.isFinite(duration) || duration <= 0) {
      return false;
    }
    const context = this.ensureContext();
    const start = context.currentTime + offset;
    const end = start + duration;

    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(freq, start);

    // Envelope shaping to prevent hard clicks on start and stop
    const shape = context.createGain();
    shape.gain.setValueAtTime(SILENCE, start);
    shape.gain.linearRampToValueAtTime(0.8, start + Math.min(0.008, duration / 4));
    shape.gain.exponentialRampToValueAtTime(SILENCE, end);

    oscillator.connect(shape);
    shape.connect(this.output);
    oscillator.onended = () => shape.disconnect();
    oscillator.start(start);
    oscillator.stop(end);
    this.busyUntil = Math.max(this.busyUntil, end);
    return true;
  }

  /**
   * Plays a named sound preset from the sound table.
   * @param {string} name
   * @returns {boolean}
   */
  play(name) {
    if (!Object.hasOwn(SOUNDS, name)) return false;
    SOUNDS[name].forEach((note) => this.playTone(...note));
    return true;
  }

  /**
   * Valve actuation button click sound.
   */
  playClick() {
    return this.play('click');
  }

  /**
   * Telemetry sweep chime.
   */
  playNavigationSweep() {
    return this.play('navigation');
  }

  /**
   * Harvest verified positive completion chime.
   */
  playSuccessChime() {
    return this.play('success');
  }

  /**
   * Sensor moisture alert warning beep.
   */
  playWarningBeep() {
    return this.play('warning');
  }

  /**
   * Pump pressure failure error buzzer.
   */
  playErrorBuzzer() {
    return this.play('error');
  }

  /**
   * Returns true if audio context is actively playing tones.
   * @returns {boolean}
   */
  isPlaying() {
    return Boolean(this.context) && this.context.currentTime < this.busyUntil;
  }
}

/**
 * Converts analyser frequency/time-domain bytes into 2D canvas coordinates.
 * @param {Uint8Array} samples
 * @param {number} width
 * @param {number} height
 * @returns {Array<[number, number]>}
 */
export function scopePoints(samples, width, height) {
  const step = samples.length > 1 ? width / (samples.length - 1) : 0;
  return Array.from(samples, (value, i) => [i * step, (value / 255) * height]);
}

/**
 * Mounts interactive event handlers and animation loop to DOM elements.
 * @param {Document} doc
 * @param {AgritechPrecisionFarmingSoundSynthesizer} synth
 * @param {Function} [requestFrame]
 */
export function mountSoundboard(doc, synth, requestFrame = (fn) => globalThis.requestAnimationFrame(fn)) {
  const slider = doc.getElementById('volume');
  const level = doc.getElementById('level');
  const mute = doc.getElementById('mute');
  const status = doc.getElementById('status');
  const wave = doc.getElementById('wave');
  const canvas = doc.getElementById('scope');
  if (!canvas) return;

  const pen = canvas.getContext('2d');
  let drawing = false;

  function trace(samples) {
    pen.clearRect(0, 0, canvas.width, canvas.height);
    pen.strokeStyle = '#34d399';
    pen.lineWidth = 2;
    pen.beginPath();
    scopePoints(samples, canvas.width, canvas.height).forEach(([x, y], i) => {
      if (i === 0) pen.moveTo(x, y);
      else pen.lineTo(x, y);
    });
    pen.stroke();
  }

  function tick() {
    if (!synth.analyser) {
      drawing = false;
      wave?.classList.remove('active');
      return;
    }
    const samples = new Uint8Array(synth.analyser.fftSize);
    synth.analyser.getByteTimeDomainData(samples);
    trace(samples);

    if (synth.isPlaying()) {
      wave?.classList.add('active');
      requestFrame(tick);
    } else {
      drawing = false;
      wave?.classList.remove('active');
      // Draw baseline silence
      trace(new Uint8Array(synth.analyser.fftSize).fill(128));
    }
  }

  function startScope() {
    if (!drawing) {
      drawing = true;
      requestFrame(tick);
    }
  }

  if (slider && level) {
    slider.addEventListener('input', () => {
      const vol = Number(slider.value) / 100;
      synth.setVolume(vol);
      level.textContent = `${Math.round(vol * 100)}%`;
    });
  }

  if (mute) {
    mute.addEventListener('change', () => {
      synth.setMuted(mute.checked);
      if (status) {
        status.textContent = mute.checked ? 'Audio muted.' : 'Audio unmuted.';
      }
    });
  }

  const buttons = doc.querySelectorAll('.board button[data-sound]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const soundKey = btn.dataset.sound;
      let played = false;
      if (soundKey === 'click') played = synth.playClick();
      else if (soundKey === 'navigation') played = synth.playNavigationSweep();
      else if (soundKey === 'success') played = synth.playSuccessChime();
      else if (soundKey === 'warning') played = synth.playWarningBeep();
      else if (soundKey === 'error') played = synth.playErrorBuzzer();
      else played = synth.play(soundKey);

      if (played) {
        startScope();
        if (status) {
          status.textContent = `Playing ${soundKey} alert tone.`;
        }
      }
    });
  });

  // Initial flat silence line on canvas
  trace(new Uint8Array(64).fill(128));
}

// Auto mount if in browser environment
if (typeof document !== 'undefined') {
  const synth = new AgritechPrecisionFarmingSoundSynthesizer();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountSoundboard(document, synth));
  } else {
    mountSoundboard(document, synth);
  }
}
