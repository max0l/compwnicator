import { generatePython, validateWorkflow } from "../src/generator.ts";
import { newStep, type Step, type Workflow } from "../src/model.ts";

const harness = String.raw`
import json, socket, subprocess, sys, threading, time
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
                elif 'sleep' in event:
                    time.sleep(event['sleep'])
                elif 'expect' in event:
                    expected = bytes.fromhex(event['expect'])
                    received = bytearray()
                    while len(received) < len(expected):
                        chunk = conn.recv(len(expected) - len(received))
                        if not chunk: break
                        received.extend(chunk)
                    assert received == expected, (received, expected)
                elif 'close' in event:
                    conn.shutdown(socket.SHUT_WR)
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
if case.get('failure'):
    assert result.returncode != 0, result.stdout
    assert case['failure'].lower() in result.stderr.lower(), result.stderr
else:
    assert result.returncode == 0, result.stderr
print('loopback protocol verified')
`;
function workflow(steps: Step[], rounds = 1): Workflow {
  return { version: 1, name: "Boundary regression", host: "localhost", port: 1337, timeout: 1, maxBuffer: 1024, rounds, steps };
}
function step(overrides: Partial<Step>): Step { return { ...newStep(), actions: [], ...overrides }; }
const hex = (text: string): string => Array.from(new TextEncoder().encode(text), byte => byte.toString(16).padStart(2, "0")).join("");
for (const variant of ["socket", "pwntools"] as const) {
  async function exercise(config: Workflow, events: Record<string, unknown>[], failure?: string, solveBody?: string) {
    let source = generatePython(config, variant);
    if (solveBody) source = source.replace('raise NotImplementedError("Implement solve(context) before using a solve action")', solveBody);
    const child = new Deno.Command("python3", { args: ["-c", harness], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify({ source, events, failure })));
    await writer.close();
    const output = await child.output();
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  }
  Deno.test(variant + ": " + "coalesced prompts preserve unread bytes; fragmented prompt has no newline", async () => {
    await exercise(workflow([
      step({ pattern: "first> ", actions: [{ id: "a", kind: "sendline", value: "one", operator: "always", condition: "" }] }),
      step({ pattern: "second> ", actions: [{ id: "b", kind: "sendline", value: "two", operator: "always", condition: "" }] }),
    ]), [{ send: "fir" }, { sleep: 0.02 }, { send: "st> second> " }, { expect: "6f6e650a74776f0a" }]);
  });
  Deno.test(variant + ": " + "multiple typed captures persist to next step and repeat across rounds", async () => {
    await exercise(workflow([
      step({ receive: "line", captures: [
        { id: "c1", name: "left", kind: "regex", pattern: "(\\d+) (\\d+)", group: "1", convert: "int" },
        { id: "c2", name: "right", kind: "regex", pattern: "(\\d+) (\\d+)", group: "2", convert: "int" },
      ] }),
      step({ pattern: "> ", actions: [{ id: "a", kind: "sendline", value: "{left}:{right}:{round}", operator: "always", condition: "" }] }),
    ], 2), [{ send: "12 34\n> 56 78\n> " }, { expect: "31323a33343a310a35363a37383a320a" }]);
  });
  Deno.test(variant + ": arbitrary-precision integer captures round-trip without edits", async () => {
    const integer = "115327401361681369925084801190836720110830720281578936710098059350491036337023";
    await exercise(workflow([
      step({ receive: "line", captures: [{ id: "large", name: "large", kind: "regex", pattern: "([0-9]+)", group: "1", convert: "int" }], actions: [{ id: "reply", kind: "sendline", value: "{large}", operator: "always", condition: "" }] }),
    ]), [{ send: integer + "\n" }, { expect: hex(integer + "\n") }]);
  });
  Deno.test(variant + ": " + "failed checks skip captures and actions; conditional actions choose response", async () => {
    await exercise(workflow([
      step({ receive: "line", checks: [{ id: "c", operator: "contains", value: "accepted" }], onFailure: "skip", captures: [{ id: "missing", name: "missing", kind: "regex", pattern: "never", group: "0", convert: "text" }], actions: [{ id: "a", kind: "sendline", value: "wrong", operator: "always", condition: "" }] }),
      step({ receive: "line", actions: [
        { id: "b", kind: "sendline", value: "wrong", operator: "notContains", condition: "ready" },
        { id: "send-binary", kind: "sendHex", value: "00ff", operator: "contains", condition: "ready" },
      ] }),
    ]), [{ send: "rejected\nready\n" }, { expect: "00ff" }]);
  });
  Deno.test(variant + ": " + "EOF cannot silently satisfy an incomplete delimiter", async () => {
    await exercise(workflow([step({ pattern: "complete> " })]), [{ send: "incomplete" }, { close: true }], "EOF");
  });
  Deno.test(variant + ": " + "read timeout bounds an unfinished frame", async () => {
    await exercise(workflow([step({ pattern: "> " })]), [{ send: "partial" }, { sleep: 1.2 }], "tim");
  });
  Deno.test(variant + ": " + "literal configuration cannot execute Python code", async () => {
    await exercise(workflow([step({ receive: "none", name: "\"; raise RuntimeError('injected') #", actions: [{ id: "a", kind: "sendline", value: "\"triple\" \\ slash", operator: "always", condition: "" }] })]), [{ expect: "22747269706c6522205c20736c6173680a" }]);
  });

  Deno.test(variant + ": regex, exact UTF-8 byte counts, EOF, and solve hook share captures", async () => {
    await exercise(workflow([
      step({ receive: "regex", pattern: "N=([0-9]+)> ", captures: [{ id: "n", name: "n", kind: "regex", pattern: "N=([0-9]+)", group: "1", convert: "int" }] }),
      step({ receive: "bytes", pattern: "4", captures: [{ id: "emoji", name: "emoji", kind: "whole", pattern: "", group: "", convert: "text" }], actions: [{ id: "answer", kind: "solve", value: "", operator: "always", condition: "" }] }),
      step({ receive: "eof", pattern: "", actions: [{ id: "log", kind: "log", value: "{response}", operator: "always", condition: "" }] }),
    ]), [{ send: "N=" }, { sleep: 0.02 }, { send: "41> 😀" }, { expect: "34323af09f98800a" }, { send: "done\n" }, { close: true }], undefined, "return str(context['n'] + 1) + ':' + context['emoji']");
  });
  Deno.test(variant + ": all matches, split, and JSON paths feed later sends", async () => {
    await exercise(workflow([
      step({ receive: "line", captures: [{ id: "all", name: "numbers", kind: "regexAll", pattern: "([0-9]+)", group: "1", convert: "int" }, { id: "split", name: "word", kind: "split", pattern: ":", group: "1", convert: "text" }] }),
      step({ receive: "line", captures: [{ id: "json", name: "token", kind: "json", pattern: "", group: "data.0.token", convert: "text" }], actions: [{ id: "send", kind: "sendline", value: "{numbers}|{word}|{token}", operator: "always", condition: "" }] }),
    ]), [{ send: '12:word:34\n{"data":[{"token":"ok"}]}\n' }, { expect: "5b31322c2033345d7c776f72647c6f6b0a" }]);
  });
  Deno.test(variant + ": buffer limits reject oversized frames", async () => {
    await exercise({ ...workflow([step({ pattern: "done" })]), maxBuffer: 8 }, [{ send: "123456789" }], "maxBuffer");
  });
  Deno.test(variant + ": EOF at the exact buffer limit succeeds", async () => {
    await exercise({ ...workflow([step({ receive: "eof", pattern: "" })]), maxBuffer: 4 }, [{ send: "done" }, { close: true }]);
  });
}
Deno.test("imports reject malformed nested configuration and reserved captures", () => {
  const malformed = [null, [], { version: 1, steps: [null] }, { ...workflow([step({})]), timeout: 0 }, workflow([step({ captures: [{ id: "x", name: "response", kind: "whole", pattern: "", group: "", convert: "text" }] })])];
  for (const value of malformed) {
    if (!validateWorkflow(value).length) throw new Error(`Accepted invalid workflow: ${JSON.stringify(value)}`);
  }
});
