class PCMInput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.n = 0;
    this.phase = 0;
    this.samples = [];
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const x of channel) {
      this.sum += x;
      this.n++;
      this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.samples.push(
          Math.round(Math.max(-1, Math.min(1, this.sum / this.n)) * 32767),
        );
        this.sum = 0;
        this.n = 0;
      }
      if (this.samples.length >= 640) {
        const b = new Int16Array(this.samples);
        this.port.postMessage(b.buffer, [b.buffer]);
        this.samples = [];
      }
    }
    return true;
  }
}
registerProcessor("relay-pcm", PCMInput);
