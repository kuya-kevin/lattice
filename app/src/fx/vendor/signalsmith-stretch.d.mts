export interface StretchSchedule {
  output?: number;
  active?: boolean;
  input?: number;
  rate?: number;
  semitones?: number;
  tonalityHz?: number;
  formantSemitones?: number;
  formantCompensation?: boolean;
  formantBaseHz?: number;
  loopStart?: number;
  loopEnd?: number;
}

export interface StretchNode extends AudioWorkletNode {
  inputTime: number;
  schedule(s: StretchSchedule): Promise<unknown>;
  start(when?: number): Promise<unknown>;
  stop(when?: number): Promise<unknown>;
  latency(): Promise<number>;
  configure?(c: { blockMs?: number; intervalMs?: number; splitComputation?: boolean; preset?: string }): Promise<unknown>;
}

declare function SignalsmithStretch(ctx: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
export default SignalsmithStretch;
