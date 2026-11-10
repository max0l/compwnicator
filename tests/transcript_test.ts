import { CONVERSATION, conversationMarks } from "./transcript-fixture.ts";
import { generatePython, previewStep, validateWorkflow } from "../src/generator.ts";
import type { Workflow } from "../src/model.ts";
import { buildTranscriptWorkflow } from "../src/transcript.ts";
import { type ConnectionSettings, type TranscriptMark } from "../src/transcript-model.ts";

const connection: ConnectionSettings = { host: "localhost", port: 1337, timeout: 2, maxBuffer: 1048576, rounds: 1 };
function assert(value: unknown, message = "Assertion failed"): asserts value { if (!value) throw new Error(message); }
function equal(actual: unknown, expected: unknown): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function mark(start: number, end: number, overrides: Partial<TranscriptMark> = {}): TranscriptMark {
  return { id: `selection-${start}-${end}`, start, end, kind: "send", appendNewline: true, name: "", pattern: "", convert: "text", ...overrides };
}
function build(text: string, marks: TranscriptMark[]): Workflow {
  const result = buildTranscriptWorkflow(text, marks, connection);
  assert(result.workflow, result.errors.join("\n"));
  equal(result.errors, []);
  return result.workflow;
}
function rejects(text: string, marks: TranscriptMark[], message: string): void {
  const result = buildTranscriptWorkflow(text, marks, connection);
  equal(result.workflow, null);
  assert(result.errors.some(error => error.toLowerCase().includes(message.toLowerCase())), result.errors.join("\n"));
}

const pythonHarness = String.raw`
import json, socket, subprocess, sys, threading
case = json.load(sys.stdin)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(1)
listener.settimeout(5)
port = listener.getsockname()[1]
errors = []
def serve():
    try:
        conn, _ = listener.accept()
        with conn:
            conn.settimeout(5)
            for event in case['events']:
                if 'send' in event:
                    conn.sendall(event['send'].encode('utf-8'))
                else:
                    expected = event['expect'].encode('utf-8')
                    received = bytearray()
                    while len(received) < len(expected):
                        chunk = conn.recv(len(expected) - len(received))
                        if not chunk: break
                        received.extend(chunk)
                    assert received == expected, (received, expected)
            # The generated solver must finish without waiting for server EOF.
            assert conn.recv(1) == b'', 'unexpected extra bytes'
    except Exception as exc:
        errors.append(repr(exc))
    finally:
        listener.close()
thread = threading.Thread(target=serve, daemon=True)
thread.start()
result = subprocess.run([sys.executable, '-c', case['source'], '--host', '127.0.0.1', '--port', str(port)], capture_output=True, text=True, timeout=8)
thread.join(6)
assert not thread.is_alive(), 'server did not finish'
assert not errors, errors
assert result.returncode == 0, result.stderr
`;
async function exercise(workflow: Workflow, events: { send?: string; expect?: string }[]): Promise<void> {
  for (const variant of ["socket", "pwntools"] as const) {
    const child = new Deno.Command("python3", { args: ["-c", pythonHarness], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify({ source: generatePython(workflow, variant), events })));
    await writer.close();
    const output = await child.output();
    assert(output.success, variant + ": " + new TextDecoder().decode(output.stderr));
  }
}

Deno.test("example preserves the four exact sends, literal EOF, and server prompt whitespace", () => {
  const marks = conversationMarks();
  const workflow = build(CONVERSATION, marks);
  equal(marks.map(item => CONVERSATION.slice(item.start, item.end)), ["Bob", "Alice", "1", "Hallo Alice,\nhere is bob.\nEOF\n"]);
  equal(workflow.steps.flatMap(step => step.actions.filter(action => action.kind === "send").map(action => action.value)), ["Bob\n", "Alice\n", "1\n", "Hallo Alice,\nhere is bob.\nEOF\n"]);
  equal(workflow.steps.map(step => step.sample), [
    "Hello, weclome to server inc.\nPlease state your name: ",
    "Hello bob, who whould you like to write to? ",
    "What would you like to write:\n1) Text message\n2) Audio\n3) Exit\n> ",
    "Enter the message and end with EOF?\n",
    "Thanks for the message. It has been sent. Good bye.\n",
  ]);
  equal(workflow.steps.map(step => step.pattern), ["Please state your name: ", "Hello bob, who whould you like to write to? ", "> ", "Enter the message and end with EOF?\n", "Thanks for the message. It has been sent. Good bye.\n"]);
  const last = workflow.steps.at(-1)!;
  equal(last.receive, "until");
  equal(last.actions.map(action => [action.kind, action.value]), [["log", "{response}"]]);
  equal(validateWorkflow(workflow), []);
});

Deno.test("generated Python sends example bytes and finishes while final connection remains open", async () => {
  const workflow = build(CONVERSATION, conversationMarks());
  const inputs = ["Bob\n", "Alice\n", "1\n", "Hallo Alice,\nhere is bob.\nEOF\n"];
  const events = workflow.steps.flatMap((step, index) => index < inputs.length ? [{ send: step.sample }, { expect: inputs[index]! }] : [{ send: step.sample }]);
  await exercise(workflow, events);
});

Deno.test("braces are escaped as literal templates and Python recovers original UTF-8 payload", async () => {
  const payload = '{answer}: {{literal}} } {response} 😀\nEOF\n';
  const workflow = build(`> ${payload}done\n`, [mark(2, 2 + payload.length, { appendNewline: false })]);
  const action = workflow.steps[0]!.actions[0]!;
  equal(action.value, payload.replace(/[{}]/g, brace => brace + brace));
  await exercise(workflow, [{ send: "> " }, { expect: payload }, { send: "done\n" }]);
});

Deno.test("explicit UTF-16 offsets select repeated typed values, not earlier server occurrences", () => {
  const text = "😀 Bob in banner\nName: Bob\nBob accepted\nAgain: Bob\n";
  const first = text.indexOf("Bob", text.indexOf("Name:"));
  const second = text.indexOf("Bob", text.indexOf("Again:"));
  const workflow = build(text, [mark(second, second + 3), mark(first, first + 3)]);
  equal(workflow.steps.map(step => step.sample), ["😀 Bob in banner\nName: ", "Bob accepted\nAgain: "]);
  equal(workflow.steps.map(step => step.actions[0]!.value), ["Bob\n", "Bob\n"]);
});

Deno.test("only one local Enter echo is removed and all other CRLF and blank lines remain", () => {
  const text = "> x\r\n\nnext: y\n\nlast\r\n";
  const y = text.indexOf("y");
  const workflow = build(text, [mark(2, 3), mark(y, y + 1)]);
  equal(workflow.steps.map(step => step.sample), ["> ", "\nnext: ", "\nlast\r\n"]);
  equal(workflow.steps.at(-1)!.pattern, "last\r\n");
});

Deno.test("send-first and raw sends preserve bytes without invented line endings", () => {
  const workflow = build("raw\n\nready", [mark(0, 3, { appendNewline: false })]);
  equal(workflow.steps[0]!.receive, "none");
  equal(workflow.steps[0]!.actions[0]!.value, "raw");
  equal(workflow.steps[1]!.sample, "\n\nready");
  const selectedNewline = build("a\n\nready", [mark(0, 2, { appendNewline: false })]);
  equal(selectedNewline.steps[1]!.sample, "\nready");
  const extraNewline = build("a\n\nready", [mark(0, 2)]);
  equal(extraNewline.steps[0]!.actions[0]!.value, "a\n\n");
  equal(extraNewline.steps[1]!.sample, "\nready");
});

Deno.test("repeated last prompt lines and newline-only frames do not finish prematurely", () => {
  const repeated = build("ready\nready\nx\n", [mark(12, 13)]);
  equal(repeated.steps[0]!.pattern, "ready\nready\n");
  const newline = build("\nx\n", [mark(1, 2)]);
  equal(newline.steps[0]!.pattern, "\n");
});

Deno.test("typed capture in final prompt line produces a dynamic receive frame", async () => {
  const text = "Count: 12 > go\nFinished\n";
  const workflow = build(text, [mark(7, 9, { kind: "capture", name: "count", convert: "int" }), mark(12, 14)]);
  const first = workflow.steps[0]!;
  equal(first.receive, "regex");
  assert(!first.pattern.includes("12"), first.pattern);
  const preview = previewStep({ ...first, sample: "Count: 987654 > " });
  equal(preview.errors, []);
  equal(preview.captures.count, 987654);
  await exercise(workflow, [{ send: "Count: 9" }, { send: "87654 > " }, { expect: "go\n" }, { send: "Finished\n" }]);
});

Deno.test("captures before the prompt use contextual parsers without freezing values", () => {
  const text = "Count: 12\nPrompt: yes\n";
  const workflow = build(text, [mark(7, 9, { kind: "capture", name: "count", convert: "int" }), mark(18, 21)]);
  const first = workflow.steps[0]!;
  equal(first.receive, "until");
  equal(first.pattern, "Prompt: ");
  const preview = previewStep({ ...first, sample: "Count: 700\nPrompt: " });
  equal(preview.errors, []);
  equal(preview.captures.count, 700);
  assert(first.captures[0]!.pattern.startsWith("^Count: "));
});

Deno.test("custom patterns with inner groups use named capture selection", () => {
  const text = "Token: red-12 > go\n";
  const workflow = build(text, [mark(7, 13, { kind: "capture", name: "token", pattern: "(red|blue)-([0-9]+)" }), mark(16, 18)]);
  const capture = workflow.steps[0]!.captures[0]!;
  assert(capture.group.startsWith("transcript_capture_"));
  assert(capture.pattern.includes("(?P<transcript_capture_0>(?:(red|blue)-([0-9]+)))"));
  const preview = previewStep({ ...workflow.steps[0]!, sample: "Token: blue-999 > " });
  equal(preview.errors, []);
  equal(preview.captures.token, "blue-999");
});

Deno.test("multiple typed captures support all conversion defaults and final-tail captures", () => {
  const samples: { sample: string; convert: TranscriptMark["convert"] }[] = [
    { sample: "-1.25e2", convert: "float" }, { sample: "00ff", convert: "hex" },
    { sample: "YQ==", convert: "base64" }, { sample: '{"n":2}', convert: "json" },
    { sample: "hello\nworld", convert: "text" },
  ];
  for (const { sample, convert } of samples) {
    const text = `go\nResult: ${sample}\nDone\n`;
    const workflow = build(text, [mark(0, 2), mark(11, 11 + sample.length, { kind: "capture", name: "value", convert })]);
    equal(workflow.steps[1]!.receive, "until");
    equal(workflow.steps[1]!.pattern, "Done\n");
    equal(previewStep(workflow.steps[1]!).errors, []);
  }
  const multi = build("A=12 B=3.5 > go\n", [mark(2, 4, { kind: "capture", name: "left", convert: "int" }), mark(7, 10, { kind: "capture", name: "right", convert: "float" }), mark(13, 15)]);
  equal(previewStep(multi.steps[0]!).captures, { left: 12, right: 3.5 });
});

Deno.test("invalid ranges, overlaps, missing sends, duplicate names, and unsafe boundaries are rejected", () => {
  rejects("> x\n", [], "at least one");
  rejects("> x\n", [mark(-1, 1)], "range");
  rejects("> x\n", [mark(2, 8)], "range");
  rejects("> x\n", [mark(2, 2)], "nonempty");
  rejects("> x\n", [mark(1.5, 3)], "range");
  rejects("> xxx\n", [mark(2, 4), mark(3, 5)], "overlap");
  rejects("A=1 B=2 > x\n", [mark(2, 3, { kind: "capture", name: "same" }), mark(6, 7, { kind: "capture", name: "same" }), mark(10, 11)], "duplicate");
  rejects("A=1 > x\n", [mark(2, 3, { kind: "capture", name: "response" }), mark(6, 7)], "identifier");
  rejects("A=1 > x\n", [mark(2, 3, { kind: "capture", name: "not-valid" }), mark(6, 7)], "identifier");
  rejects("A=12x\n", [mark(2, 4, { kind: "capture", name: "value", convert: "int" }), mark(4, 5)], "stable server delimiter");
  rejects("> x\nresult", [mark(2, 3), mark(3, 4, { kind: "capture", name: "echo" })], "local Enter echo");
  rejects("> x\nresult", [mark(2, 3), mark(3, 6, { kind: "capture", name: "straddle" })], "one inbound server frame");
});

Deno.test("malformed, mismatched, and incorrectly typed capture patterns return errors", () => {
  const text = "N=12 > x\n";
  const input = mark(7, 8);
  rejects(text, [mark(2, 4, { kind: "capture", name: "n", pattern: "(" }), input], "pattern");
  rejects(text, [mark(2, 4, { kind: "capture", name: "n", pattern: "[a-z]+" }), input], "nonempty receive regex match");
  rejects("N=no > x\n", [mark(2, 4, { kind: "capture", name: "n", convert: "int" }), input], "nonempty receive regex match");
});

Deno.test("text and mark limits and connection validation return useful errors", () => {
  rejects("x".repeat(200_001), [mark(0, 1)], "200000");
  rejects("x", Array.from({ length: 501 }, () => mark(0, 1)), "500");
  const result = buildTranscriptWorkflow("x", [mark(0, 1)], { ...connection, port: 0 });
  equal(result.workflow, null);
  assert(result.errors.some(error => error.includes("workflow.port")));
});

Deno.test("build never mutates text, marks, their ordering, or connection; IDs are globally unique", () => {
  const marks = conversationMarks().reverse();
  const before = JSON.stringify(marks);
  for (const item of marks) Object.freeze(item);
  Object.freeze(marks);
  const settings = Object.freeze({ ...connection });
  const result = buildTranscriptWorkflow(CONVERSATION, marks, settings);
  assert(result.workflow, result.errors.join("\n"));
  equal(JSON.stringify(marks), before);
  equal(settings, connection);
  const ids = result.workflow.steps.flatMap(step => [step.id, ...step.captures.map(capture => capture.id), ...step.actions.map(action => action.id)]);
  equal(new Set(ids).size, ids.length);
});
