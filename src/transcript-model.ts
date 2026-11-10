import type { Conversion, Workflow } from "./model.ts";

/** Offsets are JavaScript UTF-16 positions in the unmodified textarea text. */
export interface TranscriptMark {
  id: string;
  start: number;
  end: number;
  kind: "send" | "capture";
  /** A send selection normally omits the Enter key; enable to append LF. */
  appendNewline: boolean;
  name: string;
  pattern: string;
  convert: Conversion;
}
export interface TranscriptResult { workflow: Workflow | null; errors: string[]; }
export type ConnectionSettings = Pick<Workflow, "host" | "port" | "timeout" | "maxBuffer" | "rounds">;
