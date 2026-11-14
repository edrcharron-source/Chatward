// Plays the shared app's sound (raw 48 kHz stereo 16-bit PCM from the main process) into the share's audio track.
// Runs on the audio thread. Sound arrives in bursts, so a little is kept in hand before playing; if too much piles
// up (the PC was busy), the oldest is skipped so the share doesn't fall behind the picture.

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const RATE = 48000;
const CAPACITY = RATE; // one second
const START_AT = RATE * 0.05; // wait for 50 ms before playing
const MOST = RATE * 0.25; // skip ahead past 250 ms behind

class AppAudioPlayer extends AudioWorkletProcessor {
  private left = new Float32Array(CAPACITY);
  private right = new Float32Array(CAPACITY);
  private read = 0;
  private write = 0;
  private held = 0;
  private playing = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Int16Array>) => this.add(e.data);
  }

  private add(pcm: Int16Array): void {
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      this.left[this.write] = pcm[i] / 32768;
      this.right[this.write] = pcm[i + 1] / 32768;
      this.write = (this.write + 1) % CAPACITY;
      if (this.held === CAPACITY) this.read = (this.read + 1) % CAPACITY;
      else this.held++;
    }
    if (this.held > MOST) {
      const skip = this.held - START_AT;
      this.read = (this.read + skip) % CAPACITY;
      this.held -= skip;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [outL, outR] = outputs[0];
    if (!this.playing && this.held < START_AT) return true; // outputs start silent
    this.playing = true;
    for (let i = 0; i < outL.length; i++) {
      if (this.held === 0) {
        // Ran dry: silence until enough has built up again.
        this.playing = false;
        break;
      }
      outL[i] = this.left[this.read];
      if (outR) outR[i] = this.right[this.read];
      this.read = (this.read + 1) % CAPACITY;
      this.held--;
    }
    return true;
  }
}

registerProcessor('chatward-app-audio', AppAudioPlayer);
