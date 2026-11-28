// UI sounds generated with the Web Audio API; no audio files.

/** Each cue is a list of [frequency in Hz, wave type, duration in s, delay in s]. */
export const CUES = {
  tap: [[660, 'triangle', 0.06, 0]],
  navigate: [[420, 'sine', 0.08, 0], [560, 'sine', 0.1, 0.07]],
  warning: [[740, 'square', 0.12, 0], [740, 'square', 0.12, 0.2]],
  success: [[523.25, 'sine', 0.14, 0], [659.25, 'sine', 0.14, 0.11], [783.99, 'sine', 0.26, 0.22]],
  error: [[150, 'sawtooth', 0.18, 0], [110, 'sawtooth', 0.28, 0.16]],
  // Three short beeps one second apart, then a longer, higher "go".
  countdown: [[600, 'square', 0.15, 0], [600, 'square', 0.15, 1], [600, 'square', 0.15, 2], [1200, 'square', 0.5, 3]],
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export class FitnessCrossfitProSoundSynthesizer {
  constructor(createContext = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)()) {
    this.createContext = createContext;
    this.context = null;
    this.master = null;
    this.analyser = null;
    this.volume = 0.5;
    this.muted = false;
  }

  /** Browsers only allow audio after a user gesture, so the context is created on first use. */
  ensureContext() {
    if (!this.context) {
      this.context = this.createContext();
      this.master = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.master.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      this.applyVolume();
    }
    if (this.context.state === 'suspended') this.context.resume();
    return this.context;
  }

  applyVolume() {
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  setVolume(level) {
    if (Number.isFinite(level)) this.volume = clamp(level, 0, 1);
    this.applyVolume();
    return this.volume;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this.applyVolume();
  }

  playTone(freq, type = 'sine', duration = 0.1, delay = 0) {
    if (this.muted || !(freq > 0) || !(duration > 0)) return false;
    const context = this.ensureContext();
    const start = context.currentTime + Math.max(0, delay);
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = freq;
    // Short ramps avoid the click of a hard start or stop.
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(1, start + Math.min(0.01, duration / 3));
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(start);
    oscillator.stop(start + duration);
    return true;
  }

  playCue(name) {
    const cue = Object.hasOwn(CUES, name) ? CUES[name] : null;
    if (!cue) return false;
    return cue.map((tone) => this.playTone(...tone)).every(Boolean);
  }

  playSuccessChime() {
    return this.playCue('success');
  }

  playErrorBuzzer() {
    return this.playCue('error');
  }
}

function start() {
  const synth = new FitnessCrossfitProSoundSynthesizer();
  const canvas = document.getElementById('scope');
  const pen = canvas.getContext('2d');
  const volume = document.getElementById('volume');
  const mute = document.getElementById('mute');
  const status = document.getElementById('sound-status');
  let frame = 0;
  let quietAt = 0;

  const draw = () => {
    const samples = new Uint8Array(synth.analyser.fftSize);
    synth.analyser.getByteTimeDomainData(samples);
    pen.clearRect(0, 0, canvas.width, canvas.height);
    pen.beginPath();
    samples.forEach((sample, i) => {
      const x = (i / (samples.length - 1)) * canvas.width;
      const y = (sample / 255) * canvas.height;
      if (i === 0) pen.moveTo(x, y);
      else pen.lineTo(x, y);
    });
    pen.strokeStyle = '#f97316';
    pen.lineWidth = 2;
    pen.stroke();
    // Stop animating once the cue is over so the page idles.
    frame = performance.now() < quietAt ? requestAnimationFrame(draw) : 0;
  };

  document.querySelectorAll('[data-cue]').forEach((button) => {
    button.addEventListener('click', () => {
      const name = button.dataset.cue;
      if (!synth.playCue(name)) {
        status.textContent = 'Sound is muted';
        return;
      }
      status.textContent = `Playing ${button.textContent.trim()}`;
      const length = Math.max(...CUES[name].map(([, , duration, delay]) => duration + delay));
      quietAt = performance.now() + length * 1000 + 100;
      if (!frame) draw();
    });
  });
  volume.addEventListener('input', () => synth.setVolume(volume.value / 100));
  mute.addEventListener('change', () => {
    synth.setMuted(mute.checked);
    status.textContent = mute.checked ? 'Sound is muted' : 'Sound is on';
  });
  synth.setVolume(volume.value / 100);
}

if (typeof document !== 'undefined') start();
