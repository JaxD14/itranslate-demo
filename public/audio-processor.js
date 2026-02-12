/**
 * AudioWorklet processor that captures microphone audio,
 * accumulates samples into ~200ms chunks, converts to PCM16,
 * and posts them to the main thread for WebSocket transmission.
 *
 * The AudioContext should be created with { sampleRate: 16000 }
 * so no manual downsampling is needed.
 */
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Accumulate samples until we have ~200ms worth
    // At 16kHz: 200ms = 3200 samples
    this._buffer = [];
    this._targetLength = 3200;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0]; // Float32Array, 128 samples per quantum

    for (let i = 0; i < samples.length; i++) {
      // Clamp to [-1, 1] and convert float32 to int16
      const s = Math.max(-1, Math.min(1, samples[i]));
      this._buffer.push(s < 0 ? s * 0x8000 : s * 0x7fff);
    }

    // When we have enough samples, send the chunk
    if (this._buffer.length >= this._targetLength) {
      const pcm16 = new Int16Array(this._buffer.splice(0, this._targetLength));
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
