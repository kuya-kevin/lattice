// B14: speaks Muse's final reply when voice replies are on. Short replies whole, long ones by their
// first sentence (core/voiceTools.ts); playback pauses while Muse speaks and picks up again after,
// unless someone moved the transport meanwhile; never speaks while a track records (and a
// recording that starts cuts the speech off); push-to-talk stops it too.
import { speakable, spokenReply } from '../core/voiceTools';
import { MockVoice, pickVoice, type Speech, type Voice, type VoiceStatus } from './voice';
import { onRecordingChange, recordingActive } from './pushToTalk';

/** The transport, as the voice sees it (App supplies it through the chat panel). */
export interface VoiceTransport {
  /** pause playback if it is playing; returns a token to resume with, or null if nothing played */
  pause(): unknown;
  /** resume from a pause() token, unless something else moved the transport meanwhile */
  resume(token: unknown): void;
}

export class VoiceReply {
  private current: Speech | null = null;
  private listeners = new Set<(speaking: boolean) => void>();
  /** every text handed to the voice, oldest first (tests read it) */
  readonly spoken: string[] = [];

  transport: VoiceTransport = { pause: () => null, resume: () => {} };

  constructor(
    readonly voice: Voice,
    private isRecording: () => boolean,
  ) {}

  speaking(): boolean {
    return this.current !== null;
  }

  subscribe(fn: (speaking: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l(this.speaking());
  }

  /** Speak a reply. Returns what is said, or null if nothing is (recording, nothing to say). */
  say(reply: string): string | null {
    if (this.isRecording()) return null;
    const text = speakable(spokenReply(reply));
    if (!text) return null;
    this.stop();
    const token = this.transport.pause();
    const speech = this.voice.speak(text);
    let cut = false;
    this.current = speech;
    this.spoken.push(text);
    this.emit();
    const stop = speech.stop;
    speech.stop = () => {
      cut = true;
      stop();
    };
    void speech.done.then(() => {
      if (this.current === speech) {
        this.current = null;
        this.emit();
      }
      if (!cut && token != null) this.transport.resume(token);
    });
    return text;
  }

  /** Stop speaking now (push-to-talk, recording, toggle off). Playback stays paused. */
  stop() {
    const s = this.current;
    if (!s) return;
    this.current = null;
    s.stop();
    this.emit();
  }
}

declare global {
  interface Window {
    /** B14 test hook: what the voice is doing */
    latticeVoice?: {
      readonly kind: string;
      speaking(): boolean;
      spoken(): string[];
      mockMsPerChar: number;
      say(text: string): string | null;
      stop(): void;
      status(): VoiceStatus;
      /** mock voice only: pretend the model is loading or failed */
      mockStatus(s: VoiceStatus): void;
    };
  }
}

let instance: VoiceReply | null = null;

/** The page's one VoiceReply (created on first use; also installs window.latticeVoice). */
export function voiceReplyFor(mode: 'electron' | 'web'): VoiceReply {
  if (instance) return instance;
  const vr = (instance = new VoiceReply(pickVoice(mode), recordingActive));
  onRecordingChange((on) => on && vr.stop());
  window.latticeVoice = {
    kind: vr.voice.kind,
    speaking: () => vr.speaking(),
    say: (text) => vr.say(text), // try the voice from the devtools console
    stop: () => vr.stop(),
    spoken: () => [...vr.spoken],
    status: () => vr.voice.status(),
    mockStatus: (st) => vr.voice instanceof MockVoice && vr.voice.box.set(st),
    get mockMsPerChar() {
      return vr.voice instanceof MockVoice ? vr.voice.msPerChar : 0;
    },
    set mockMsPerChar(ms: number) {
      if (vr.voice instanceof MockVoice) vr.voice.msPerChar = ms;
    },
  };
  return vr;
}
