import test from 'node:test';
import assert from 'node:assert/strict';
import { CUES, FitnessCrossfitProSoundSynthesizer } from './audio-synthesizer.js';

function fakeContext() {
  const tones = [];
  const gain = () => ({
    gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    connect() {},
  });
  return {
    tones,
    created: 0,
    currentTime: 10,
    state: 'running',
    destination: {},
    createGain: gain,
    createAnalyser: () => ({ connect() {} }),
    createOscillator() {
      const tone = { frequency: {}, connect() {}, start(at) { this.startAt = at; }, stop(at) { this.stopAt = at; } };
      tones.push(tone);
      return tone;
    },
  };
}

function setup() {
  const context = fakeContext();
  const synth = new FitnessCrossfitProSoundSynthesizer(() => { context.created += 1; return context; });
  return { context, synth };
}

test('the audio context is created once, only when a sound is played', () => {
  const { context, synth } = setup();
  synth.setVolume(0.8);
  assert.equal(context.created, 0);
  synth.playTone(440, 'sine', 0.2);
  synth.playTone(440, 'sine', 0.2);
  assert.equal(context.created, 1);
  assert.equal(synth.master.gain.value, 0.8);
});

test('playTone schedules start and stop and ignores bad values', () => {
  const { context, synth } = setup();
  assert.equal(synth.playTone(0, 'sine', 1), false);
  assert.equal(synth.playTone(440, 'sine', 0), false);
  assert.equal(synth.playTone(440, 'square', 0.5, 1), true);
  const [tone] = context.tones;
  assert.deepEqual([tone.type, tone.frequency.value, tone.startAt, tone.stopAt], ['square', 440, 11, 11.5]);
});

test('volume is clamped and mute silences playback', () => {
  const { context, synth } = setup();
  assert.equal(synth.setVolume(4), 1);
  assert.equal(synth.setVolume(-1), 0);
  assert.equal(synth.setVolume(NaN), 0);
  synth.setMuted(true);
  assert.equal(synth.playSuccessChime(), false);
  assert.equal(context.tones.length, 0);
});

test('named cues play every tone and unknown names do nothing', () => {
  const { context, synth } = setup();
  assert.equal(synth.playSuccessChime(), true);
  assert.equal(synth.playErrorBuzzer(), true);
  assert.equal(synth.playCue('countdown'), true);
  assert.equal(context.tones.length, CUES.success.length + CUES.error.length + CUES.countdown.length);
  assert.equal(synth.playCue('toString'), false);
});
