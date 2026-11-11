import { previewStep, validateWorkflow } from "./generator.ts";
import { uid, type Conversion, type Step, type Workflow } from "./model.ts";
import { type ConnectionSettings, type TranscriptMark, type TranscriptResult } from "./transcript-model.ts";

const MAX_TEXT = 200_000;
const MAX_MARKS = 500;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED: Record<string, boolean> = { round: true, response: true, ["__proto__"]: true, prototype: true, constructor: true };
const literalRegex = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
const literalTemplate = (text: string): string => text.replace(/[{}]/g, brace => brace + brace);
const failed = (errors: string[]): TranscriptResult => ({ workflow: null, errors });

function defaultPattern(conversion: Conversion, sample: string): string {
  switch (conversion) {
    case "int": return "[+-]?[0-9]+";
    case "float": return "[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?";
    case "hex": return "(?:[0-9a-fA-F]{2}[ \\t\\r\\n]*)+";
    case "base64": return "(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?";
    case "json": return "[\\s\\S]+?";
    default: return /[\r\n]/.test(sample) ? "[\\s\\S]+?" : "[^\\r\\n]+?";
  }
}

/** Include a terminating LF (and its CR) rather than selecting an empty last line. */
function lastLineStart(text: string, before = text.length): number {
  const end = text[before - 1] === "\n" ? before - 1 : before;
  return end <= 0 ? 0 : text.lastIndexOf("\n", end - 1) + 1;
}

function makeFrame(text: string, start: number, end: number, marks: TranscriptMark[], name: string, flexibleFinalNewline = false): Step {
  const sample = text.slice(start, end);
  const step: Step = { id: uid(), name, receive: sample ? "until" : "none", pattern: "", sample, captures: [], checks: [], onFailure: "stop", actions: [] };
  if (!sample) return step;

  let boundary = lastLineStart(sample);
  // A repeated final line would finish the receive before the intended prompt.
  // Fall back to the complete frame without repeatedly copying long suffixes.
  if (boundary > 0 && sample.indexOf(sample.slice(boundary)) !== boundary) boundary = 0;
  const boundaryHasCapture = marks.some(mark => mark.end > start + boundary);
  if (!marks.length) {
    step.pattern = sample.slice(boundary);
    return step;
  }

  let expression = "^";
  let cursor = start;
  const groups: string[] = [];
  for (const [index, mark] of marks.entries()) {
    let group = `transcript_capture_${index}`;
    // Do not collide with a named group supplied inside a custom pattern.
    while (marks.some(candidate => candidate.pattern.includes(`${group}>`))) group += "_";
    groups.push(group);
    expression += literalRegex(text.slice(cursor, mark.start));
    expression += `(?P<${group}>(?:${mark.pattern || defaultPattern(mark.convert, text.slice(mark.start, mark.end))}))`;
    cursor = mark.end;
  }
  const tail = text.slice(cursor, end);
  expression += flexibleFinalNewline && tail.endsWith("\n")
    ? literalRegex(tail.slice(0, -1)) + "\\r?\\n"
    : literalRegex(tail);
  const parser = expression + "(?![\\s\\S])";
  step.captures = marks.map((mark, index) => ({ id: uid(), name: mark.name, kind: "regex", pattern: parser, group: groups[index]!, convert: mark.convert }));
  if (boundaryHasCapture) {
    step.receive = "regex";
    // No end-of-buffer assertion: a coalesced following server frame must stay unread.
    step.pattern = expression;
  } else step.pattern = sample.slice(boundary);
  return step;
}

/** Build only from explicitly selected input; terminal echo is not server data. */
export function buildTranscriptWorkflow(text: string, marks: TranscriptMark[], connection: ConnectionSettings): TranscriptResult {
  if (typeof text !== "string" || text.length > MAX_TEXT) return failed([`Transcript must contain at most ${MAX_TEXT} UTF-16 characters.`]);
  if (!Array.isArray(marks) || marks.length > MAX_MARKS) return failed([`Select at most ${MAX_MARKS} input and capture marks.`]);
  const errors: string[] = [];
  const sorted = [...marks].sort((a, b) => a.start - b.start || a.end - b.end);
  const names = new Set<string>();
  let previousEnd = 0;
  for (const [index, mark] of sorted.entries()) {
    const label = `Mark ${index + 1}`;
    if (!Number.isSafeInteger(mark.start) || !Number.isSafeInteger(mark.end) || mark.start < 0 || mark.end > text.length || mark.end <= mark.start) errors.push(`${label}: select a nonempty range within the transcript.`);
    if (mark.start < previousEnd) errors.push(`${label}: selections must not overlap.`);
    previousEnd = Math.max(previousEnd, mark.end);
    if (mark.kind !== "send" && mark.kind !== "capture") errors.push(`${label}: unknown selection kind.`);
    if (mark.kind === "capture") {
      if (typeof mark.name !== "string" || !NAME.test(mark.name) || Object.hasOwn(RESERVED, mark.name)) errors.push(`${label}: capture name must be an identifier, excluding round, response and prototype-related names.`);
      if (names.has(mark.name)) errors.push(`${label}: duplicate capture name ${mark.name}.`);
      names.add(mark.name);
      if (typeof mark.pattern !== "string") errors.push(`${label}: capture pattern must be text.`);
    }
  }
  const sends = sorted.filter(mark => mark.kind === "send");
  const captures = sorted.filter(mark => mark.kind === "capture");
  if (!sends.length) errors.push("Mark at least one typed input to send; server output is never guessed to be input.");
  if (errors.length) return failed(errors);

  const steps: Step[] = [];
  const assigned = new Set<TranscriptMark>();
  const appendFrame = (start: number, end: number, name: string): Step => {
    const frameCaptures = captures.filter(mark => mark.start >= start && mark.end <= end);
    for (const mark of frameCaptures) assigned.add(mark);
    const last = frameCaptures.at(-1);
    // Terminal copies commonly omit the final LF even though a line-oriented
    // service sent one. When the final server value itself is selected, use that
    // line ending as its stable boundary. The generated regex consumes only the
    // CRLF/LF, so a coalesced banner for the next round remains in the buffer.
    const captureNeedsBoundary = last?.end === end;
    const inferFinalNewline = captureNeedsBoundary && end === text.length;
    if (captureNeedsBoundary && !inferFinalNewline) errors.push(`Capture ${last.name}: no stable server delimiter follows this value. Leave a trailing prompt or newline unmarked.`);
    const frameText = inferFinalNewline ? text + "\n" : text;
    const frameEnd = inferFinalNewline ? end + 1 : end;
    const step = makeFrame(frameText, start, frameEnd, frameCaptures, name, inferFinalNewline);
    steps.push(step);
    return step;
  };

  let cursor = 0;
  for (const [index, mark] of sends.entries()) {
    // A send selected inside the previous send's local Enter echo is not a frame.
    if (mark.start < cursor) return failed([`Input ${index + 1}: selection overlaps the previous input's local Enter echo.`]);
    const step = appendFrame(cursor, mark.start, `Input ${index + 1}`);
    const payload = text.slice(mark.start, mark.end) + (mark.appendNewline ? "\n" : "");
    step.actions.push({ id: uid(), kind: "send", value: literalTemplate(payload), operator: "always", condition: "" });
    cursor = mark.end;
    if (mark.appendNewline && !text.slice(mark.start, mark.end).endsWith("\n")) {
      if (text.startsWith("\r\n", cursor)) cursor += 2;
      else if (text[cursor] === "\n") cursor++;
    }
  }
  if (cursor < text.length) {
    const step = appendFrame(cursor, text.length, "Final server output");
    step.actions.push({ id: uid(), kind: "log", value: "{response}", operator: "always", condition: "" });
  }
  for (const mark of captures) if (!assigned.has(mark)) errors.push(`Capture ${mark.name}: selection must stay inside one inbound server frame, not typed input or local Enter echo.`);
  if (errors.length) return failed(errors);

  const workflow: Workflow = { version: 1, name: "Marked terminal transcript", ...connection, steps };
  errors.push(...validateWorkflow(workflow));
  if (errors.length) return failed(errors);
  for (const step of steps) {
    if (!step.captures.length) continue;
    errors.push(...previewStep(step).errors.map(error => `${step.name}: ${error}`));
    const raw = previewStep({ ...step, captures: step.captures.map(capture => ({ ...capture, convert: "text" })) });
    for (const capture of step.captures) {
      const mark = captures.find(candidate => candidate.name === capture.name)!;
      if (!raw.errors.length && raw.captures[capture.name] !== text.slice(mark.start, mark.end)) errors.push(`Capture ${capture.name}: pattern does not match exactly the selected value. Adjust the pattern or include a separating literal.`);
    }
  }
  return errors.length ? failed(errors) : { workflow, errors: [] };
}
