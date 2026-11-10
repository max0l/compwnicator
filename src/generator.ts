import type { Capture, Operator, Step, Workflow } from "./model.ts";

const RECEIVE = ["until", "line", "regex", "bytes", "eof", "none"];
const PARSERS = ["regex", "regexAll", "split", "json", "whole"];
const CONVERSIONS = ["text", "int", "float", "hex", "base64", "json"];
const ACTIONS = ["sendline", "send", "sendHex", "solve", "log", "stop"];
const OPERATORS = ["always", "contains", "notContains", "equals", "notEquals", "startsWith", "endsWith", "regex", "notRegex", "empty", "notEmpty"];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED: object = { round: true, response: true, ["__proto__"]: true, prototype: true, constructor: true };
const MAX_TEXT = 1_000_000;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Preview uses JavaScript RegExp, not Python. Unicode classes, anchors and
 * lookbehind can differ; always test the exported solver against your service. */
function regex(pattern: string, global = false): RegExp {
  let flags = global ? "gu" : "u";
  const prefix = pattern.match(/^\(\?([ims]+)\)/);
  if (prefix) {
    flags += [...new Set(prefix[1])].join("");
    pattern = pattern.slice(prefix[0].length);
  }
  if (/\\[pP]\{|\\[AzZG]|\(\?[aLuux-]|\(\?>|\(\?\(/.test(pattern)) {
    throw new Error("Regex uses engine-specific syntax outside the supported Python/JavaScript subset");
  }
  pattern = pattern.replace(/\(\?P<([A-Za-z_]\w*)>/g, "(?<$1>")
    .replace(/\(\?P=([A-Za-z_]\w*)\)/g, "\\k<$1>");
  if (/\\u\{|\\(?![dDsSwWbBfnrtv0-9xu]|k<[A-Za-z_][A-Za-z0-9_]*>)[A-Za-z]/.test(pattern)) {
    throw new Error("Regex escape is outside the supported Python/JavaScript subset");
  }
  return new RegExp(pattern, flags);
}

function templateFields(value: string): string[] {
  const fields: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char !== "{" && char !== "}") continue;
    if (value[index + 1] === char) { index++; continue; }
    if (char === "}") throw new Error("Unmatched } in template; use }} for a literal brace");
    const end = value.indexOf("}", index + 1);
    if (end < 0) throw new Error("Unmatched { in template; use {{ for a literal brace");
    const name = value.slice(index + 1, end);
    if (!NAME.test(name) || (Object.hasOwn(RESERVED, name) && name !== "round" && name !== "response")) {
      throw new Error("Templates accept only {name} placeholders, without attributes, indexes or format specifiers");
    }
    fields.push(name);
    index = end;
  }
  return fields;
}

export function validateWorkflow(input: unknown): string[] {
  const errors: string[] = [];
  const fail = (path: string, text: string) => errors.push(`${path}: ${text}`);
  const record = (value: unknown, path: string, keys: string[]): value is Record<string, unknown> => {
    if (!object(value)) { fail(path, "must be an object"); return false; }
    for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
    for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, "unknown field");
    return true;
  };
  const text = (value: unknown, path: string, nonempty = false): value is string => {
    if (typeof value !== "string" || value.length > MAX_TEXT || (nonempty && !value.trim())) {
      fail(path, `must be ${nonempty ? "a nonempty" : "a"} string of at most ${MAX_TEXT} characters`); return false;
    }
    // Lone surrogates cannot be encoded by Python's strict UTF-8 encoder.
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) { fail(path, "contains an unpaired Unicode surrogate"); return false; }
      } else if (code >= 0xdc00 && code <= 0xdfff) { fail(path, "contains an unpaired Unicode surrogate"); return false; }
    }
    return true;
  };
  const choice = (value: unknown, path: string, values: string[]) => {
    if (typeof value !== "string" || !values.includes(value)) fail(path, `must be one of ${values.join(", ")}`);
  };
  const integer = (value: unknown, path: string, min: number, max: number) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(path, `must be an integer from ${min} to ${max}`);
  };
  const list = (value: unknown, path: string, limit: number): value is unknown[] => {
    if (!Array.isArray(value) || value.length > limit) { fail(path, `must be an array of at most ${limit} entries`); return false; }
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) { fail(path, "must not contain missing array entries"); return false; }
    }
    return true;
  };
  const ids = new Set<string>();
  const id = (value: unknown, path: string) => {
    if (text(value, path, true)) {
      if (ids.has(value)) fail(path, "must be unique within the workflow");
      ids.add(value);
    }
  };
  const checkRegex = (value: unknown, path: string, receiving = false) => {
    if (typeof value !== "string") return;
    try {
      const parsed = regex(value);
      if (receiving && parsed.test("")) fail(path, "receive regex must not match an empty frame");
    } catch (error) { fail(path, message(error)); }
  };
  const condition = (operator: unknown, value: unknown, path: string) => {
    choice(operator, `${path}.operator`, OPERATORS);
    if (text(value, `${path}.value`) && (operator === "regex" || operator === "notRegex")) checkRegex(value, `${path}.value`);
  };
  if (!record(input, "workflow", ["version", "name", "host", "port", "timeout", "maxBuffer", "rounds", "steps"])) return errors;
  if (input.version !== 1) fail("workflow.version", "must be 1");
  text(input.name, "workflow.name", true);
  if (text(input.host, "workflow.host", true) && /[\s\x00-\x1f\x7f]/.test(input.host)) fail("workflow.host", "must be a hostname or IP address without whitespace/control characters");
  integer(input.port, "workflow.port", 1, 65535);
  if (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 86400) fail("workflow.timeout", "must be a finite number greater than 0 and at most 86400 seconds");
  integer(input.maxBuffer, "workflow.maxBuffer", 1, 67_108_864);
  integer(input.rounds, "workflow.rounds", 1, 1_000_000_000);
  if (!list(input.steps, "workflow.steps", 1000)) return errors;
  if (!input.steps.length) fail("workflow.steps", "must contain at least one step");
  input.steps.forEach((step, index) => {
    const path = `steps[${index}]`;
    if (!record(step, path, ["id", "name", "receive", "pattern", "sample", "captures", "checks", "onFailure", "actions"])) return;
    id(step.id, `${path}.id`);
    text(step.name, `${path}.name`, true);
    choice(step.receive, `${path}.receive`, RECEIVE);
    text(step.sample, `${path}.sample`);
    if (text(step.pattern, `${path}.pattern`)) {
      if (step.receive === "until" && !step.pattern) fail(`${path}.pattern`, "literal delimiter must not be empty");
      if (step.receive === "regex") checkRegex(step.pattern, `${path}.pattern`, true);
      if (step.receive === "bytes") {
        if (!/^[1-9][0-9]*$/.test(step.pattern)) fail(`${path}.pattern`, "byte count must be a positive decimal integer");
        else integer(Number(step.pattern), `${path}.pattern`, 1, typeof input.maxBuffer === "number" ? input.maxBuffer : 67_108_864);
      }
      if (step.receive === "until" && typeof input.maxBuffer === "number" && new TextEncoder().encode(step.pattern).length > input.maxBuffer) fail(`${path}.pattern`, "UTF-8 delimiter exceeds maxBuffer");
    }
    choice(step.onFailure, `${path}.onFailure`, ["stop", "skip"]);
    if (list(step.captures, `${path}.captures`, 100)) {
      const names = new Set<string>();
      step.captures.forEach((capture, ci) => {
        const cp = `${path}.captures[${ci}]`;
        if (!record(capture, cp, ["id", "name", "kind", "pattern", "group", "convert"])) return;
        id(capture.id, `${cp}.id`);
        if (text(capture.name, `${cp}.name`, true)) {
          if (!NAME.test(capture.name) || Object.hasOwn(RESERVED, capture.name)) fail(`${cp}.name`, "must be an identifier, excluding round, response and prototype-related names");
          if (names.has(capture.name)) fail(`${cp}.name`, "duplicate capture name in this step");
          names.add(capture.name);
        }
        choice(capture.kind, `${cp}.kind`, PARSERS);
        choice(capture.convert, `${cp}.convert`, CONVERSIONS);
        if (text(capture.pattern, `${cp}.pattern`) && ["regex", "regexAll", "split"].includes(String(capture.kind))) checkRegex(capture.pattern, `${cp}.pattern`);
        if (text(capture.group, `${cp}.group`)) {
          if (["regex", "regexAll"].includes(String(capture.kind)) && capture.group !== "" && !/^(?:[0-9]+|[A-Za-z_][A-Za-z0-9_]*)$/.test(capture.group)) fail(`${cp}.group`, "must be a numeric or named regex group (empty means 0)");
          if (capture.kind === "split") {
            if (!/^[0-9]+$/.test(capture.group)) fail(`${cp}.group`, "must be a zero-based nonnegative split index");
            else integer(Number(capture.group), `${cp}.group`, 0, 1_000_000);
          }
          if (["regex", "regexAll"].includes(String(capture.kind)) && typeof capture.pattern === "string") {
            try {
              const parsed = regex(capture.pattern);
              const groups = new RegExp(`(?:${parsed.source})|`, parsed.flags).exec("")!;
              const selected = capture.group || "0";
              if (/^[0-9]+$/.test(selected) ? Number(selected) >= groups.length : !Object.hasOwn(groups.groups ?? {}, selected)) fail(`${cp}.group`, "group does not exist in the capture regex");
            } catch { /* Pattern syntax errors are reported above. */ }
          }
          if (capture.kind === "json" && capture.group && capture.group.split(".").some(part => !part || Object.hasOwn(RESERVED, part))) fail(`${cp}.group`, "must be a dotted JSON path without empty or reserved segments");
        }
      });
    }
    if (list(step.checks, `${path}.checks`, 100)) step.checks.forEach((check, ci) => {
      const cp = `${path}.checks[${ci}]`;
      if (!record(check, cp, ["id", "operator", "value"])) return;
      id(check.id, `${cp}.id`); condition(check.operator, check.value, cp);
    });
    if (list(step.actions, `${path}.actions`, 100)) step.actions.forEach((action, ai) => {
      const ap = `${path}.actions[${ai}]`;
      if (!record(action, ap, ["id", "kind", "value", "operator", "condition"])) return;
      id(action.id, `${ap}.id`); choice(action.kind, `${ap}.kind`, ACTIONS);
      condition(action.operator, action.condition, `${ap}.condition`);
      if (text(action.value, `${ap}.value`) && action.kind !== "solve") {
        try {
          const fields = templateFields(action.value);
          if (action.kind === "sendHex" && !fields.length && !/^(?:[0-9a-fA-F]{2}\s*)*$/.test(action.value.trim())) fail(`${ap}.value`, "must be hexadecimal byte pairs (or a {name} template)");
        } catch (error) { fail(`${ap}.value`, message(error)); }
      }
    });
  });
  return errors;
}

function evaluate(operator: Operator, value: string, frame: string): boolean {
  switch (operator) {
    case "always": return true;
    case "contains": return frame.includes(value);
    case "notContains": return !frame.includes(value);
    case "equals": return frame === value;
    case "notEquals": return frame !== value;
    case "startsWith": return frame.startsWith(value);
    case "endsWith": return frame.endsWith(value);
    case "regex": return regex(value).test(frame);
    case "notRegex": return !regex(value).test(frame);
    case "empty": return frame.length === 0;
    case "notEmpty": return frame.length !== 0;
  }
}

function convert(value: unknown, conversion: Capture["convert"]): unknown {
  if (conversion === "json") return typeof value === "string" ? JSON.parse(value) : value;
  if (conversion === "text") return typeof value === "string" ? value : JSON.stringify(value);
  const text = typeof value === "string" ? value.trim() : String(value);
  if (conversion === "int") {
    if (!/^[+-]?[0-9]+$/.test(text)) throw new Error("Not a decimal integer");
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new Error("Integer exceeds browser's exact range; Python supports larger integers");
    return value;
  }
  if (conversion === "float") {
    if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text) || !Number.isFinite(Number(text))) throw new Error("Not a finite decimal float");
    return Number(text);
  }
  if (conversion === "hex") {
    if (!/^(?:[0-9a-fA-F]{2}\s*)*$/.test(text)) throw new Error("Not hexadecimal byte pairs");
    return Array.from(text.replace(/\s/g, "").match(/../g) ?? [], pair => parseInt(pair, 16));
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error("Not strict padded base64");
  return Array.from(atob(text), char => char.charCodeAt(0));
}

function captureValue(capture: Capture, frame: string): unknown {
  const group = capture.group || "0";
  const select = (match: RegExpMatchArray): string => {
    const value = /^[0-9]+$/.test(group) ? match[Number(group)] : match.groups?.[group];
    if (value === undefined) throw new Error(`Missing or unmatched group ${group}`);
    return value;
  };
  let value: unknown;
  if (capture.kind === "whole") value = frame;
  else if (capture.kind === "regex") {
    const match = regex(capture.pattern).exec(frame);
    if (!match) throw new Error("Regex did not match");
    value = select(match);
  } else if (capture.kind === "regexAll") {
    const matches = Array.from(frame.matchAll(regex(capture.pattern, true)));
    if (!matches.length) throw new Error("Regex did not match");
    return matches.map(match => convert(select(match), capture.convert));
  } else if (capture.kind === "split") {
    value = frame.split(regex(capture.pattern))[Number(capture.group)];
    if (value === undefined) throw new Error(`Split index ${capture.group} is missing`);
  } else {
    value = JSON.parse(frame);
    if (capture.group) for (const part of capture.group.split(".")) {
      if (Array.isArray(value)) {
        if (!/^(?:0|[1-9][0-9]*)$/.test(part) || !Object.hasOwn(value, part)) throw new Error(`Missing JSON array index ${part}`);
        value = value[Number(part)];
      } else if (object(value) && Object.hasOwn(value, part)) value = value[part];
      else throw new Error(`Missing JSON path segment ${part}`);
    }
  }
  return convert(value, capture.convert);
}

export function previewStep(step: Step): { captures: Record<string, unknown>; errors: string[]; checks: { passed: boolean; label: string }[] } {
  const captures: Record<string, unknown> = Object.create(null);
  const errors: string[] = [];
  const checks: { passed: boolean; label: string }[] = [];
  // A small wrapper validates even a runtime call with malformed imported data.
  const validation = validateWorkflow({ version: 1, name: "Preview", host: "localhost", port: 1, timeout: 1, maxBuffer: 67_108_864, rounds: 1, steps: [step] });
  if (validation.length) return { captures, errors: validation, checks };
  let frame = step.sample;
  try {
    if (step.receive === "none") frame = "";
    else if (step.receive === "until") {
      const end = frame.indexOf(step.pattern);
      if (end < 0) throw new Error("Sample does not contain the receive delimiter");
      frame = frame.slice(0, end + step.pattern.length);
    } else if (step.receive === "line") {
      const end = frame.indexOf("\n");
      if (end < 0) throw new Error("Sample does not contain a complete newline-terminated frame");
      frame = frame.slice(0, end + 1);
    } else if (step.receive === "regex") {
      const match = regex(step.pattern).exec(frame);
      if (!match || !match[0].length) throw new Error("Sample does not contain a nonempty receive regex match");
      frame = frame.slice(0, match.index + match[0].length);
    } else if (step.receive === "bytes") {
      const bytes = new TextEncoder().encode(frame);
      const count = Number(step.pattern);
      if (bytes.length < count) throw new Error(`Sample has ${bytes.length} UTF-8 bytes; need ${count}`);
      frame = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, count));
    }
  } catch (error) { return { captures, errors: [message(error)], checks }; }
  for (const check of step.checks) {
    try { checks.push({ passed: evaluate(check.operator, check.value, frame), label: `${check.operator}${check.value ? `: ${check.value}` : ""}` }); }
    catch (error) { errors.push(`Check: ${message(error)}`); }
  }
  if (checks.some(check => !check.passed)) {
    errors.push(`Check failed: this step will ${step.onFailure === "skip" ? "skip captures and actions" : "stop the solver"}`);
    return { captures, errors, checks };
  }
  for (const capture of step.captures) {
    try { captures[capture.name] = captureValue(capture, frame); }
    catch (error) { errors.push(`${capture.name}: ${message(error)}`); }
  }
  return { captures, errors, checks };
}

export type PythonVariant = "socket" | "pwntools";

export function generatePython(workflow: Workflow, variant: PythonVariant = "socket"): string {
  if (variant !== "socket" && variant !== "pwntools") throw new Error("Unknown Python variant");
  const errors = validateWorkflow(workflow);
  if (errors.length) throw new Error(`Invalid workflow:\n${errors.join("\n")}`);
  const config = JSON.stringify(JSON.stringify(workflow));
  const dependency = variant === "pwntools" ? "pwntools transport.\n# Install: python3 -m pip install pwntools" : "standard library only.";
  return `#!/usr/bin/env python3\n# Generated by Compwnicator. Python 3.9+; ${dependency}\n# Configuration is data, never executable code.\nCONFIG_JSON = ${config}\n` + pythonRuntime(variant === "pwntools" ? PWNTOOLS_TRANSPORT : SOCKET_TRANSPORT);
}

const SOCKET_TRANSPORT = String.raw`
import socket


class Transport:
    def __init__(self, host, port, timeout):
        self.connection = socket.create_connection((host, port), timeout=timeout)

    def close(self):
        self.connection.close()

    def send(self, data, timeout):
        self.connection.settimeout(timeout)
        self.connection.sendall(data)

    def recv(self, size, timeout):
        self.connection.settimeout(timeout)
        return self.connection.recv(size)
`;

const PWNTOOLS_TRANSPORT = String.raw`
try:
    from pwnlib.exception import PwnlibException
    from pwnlib.tubes.remote import remote
except ImportError as error:
    raise SystemExit('pwntools is required. Install it with: python3 -m pip install pwntools') from error


class Transport:
    def __init__(self, host, port, timeout):
        try:
            # Compwnicator handles verbose logging consistently for both variants.
            self.connection = remote(host, port, timeout=timeout, level='error')
        except PwnlibException as error:
            raise OSError(str(error)) from error

    def close(self):
        self.connection.close()

    def send(self, data, timeout):
        self.connection.settimeout(timeout)
        try:
            self.connection.send(data)
        except EOFError as error:
            raise OSError('Connection closed while sending') from error

    def recv(self, size, timeout):
        try:
            chunk = self.connection.recv(size, timeout=timeout)
        except EOFError:
            return b''
        # A tube returns empty bytes on timeout and raises EOFError on close.
        if not chunk:
            raise TimeoutError('pwntools receive timed out')
        return chunk
`;

const pythonRuntime = (transport: string): string => String.raw`
import argparse
import base64
import codecs
import json
import math
import re
import string
import sys
import time

${transport}

CONFIG = json.loads(CONFIG_JSON)


def solve(context):
    """Implement challenge logic here. Captures persist within each round.

    context['round'] is 1-based, context['response'] is the latest frame.
    Hex/base64 captures are bytes; regexAll captures are lists.
    Return bytes (preserved verbatim) or a value to send with a trailing LF.
    """
    raise NotImplementedError("Implement solve(context) before using a solve action")


class SolverError(Exception):
    pass


def compile_regex(pattern):
    # Preview uses JavaScript. Python Unicode classes/anchors/lookbehind differ.
    # Accept named groups/backreferences in either engine's spelling.
    pattern = re.sub(r'\(\?<([A-Za-z_]\w*)>', r'(?P<\1>', pattern)
    pattern = re.sub(r'\\k<([A-Za-z_]\w*)>', r'(?P=\1)', pattern)
    return re.compile(pattern)


class BufferedClient:
    def __init__(self, transport, timeout, max_buffer, verbose=False):
        self.transport = transport
        self.timeout = timeout
        self.max_buffer = max_buffer
        self.verbose = verbose
        self.buffer = bytearray()
        self.closed = False

    def close(self):
        self.transport.close()

    def send(self, data):
        if self.verbose:
            print('tx:', repr(data), file=sys.stderr)
        self.transport.send(data, self.timeout)

    def receive(self, mode, pattern):
        if mode == 'none':
            return b''
        deadline = time.monotonic() + self.timeout
        compiled = compile_regex(pattern) if mode == 'regex' else None
        delimiter = pattern.encode('utf-8') if mode == 'until' else b'\n'
        count = int(pattern) if mode == 'bytes' else None
        while True:
            end = None
            decode_error = None
            if mode in ('until', 'line'):
                position = self.buffer.find(delimiter)
                if position >= 0:
                    end = position + len(delimiter)
            elif mode == 'bytes':
                if len(self.buffer) >= count:
                    end = count
            elif mode == 'regex':
                try:
                    # Ignore only an incomplete trailing UTF-8 sequence while
                    # awaiting fragmentation; returned frames decode strictly.
                    text = codecs.getincrementaldecoder('utf-8')().decode(bytes(self.buffer), final=self.closed)
                except UnicodeDecodeError as error:
                    decode_error = error
                    text = bytes(self.buffer[:error.start]).decode('utf-8')
                match = compiled.search(text)
                if match:
                    if match.start() == match.end():
                        raise SolverError('Receive regex matched an empty string')
                    end = len(text[:match.end()].encode('utf-8'))
                elif decode_error is not None:
                    raise SolverError('Invalid UTF-8 in regex frame: ' + str(decode_error))
            elif mode == 'eof' and self.closed:
                end = len(self.buffer)
            if end is not None:
                frame = bytes(self.buffer[:end])
                del self.buffer[:end]
                return frame
            if self.closed:
                raise SolverError('Unexpected EOF waiting for ' + mode + ' ' + repr(pattern) + '; partial frame=' + repr(bytes(self.buffer)))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SolverError('Read timeout waiting for ' + mode + ' ' + repr(pattern) + '; partial frame=' + repr(bytes(self.buffer)))
            # Bound unread storage, not the entire socket stream. A completed
            # frame is consumed above before considering the bound.
            capacity = self.max_buffer - len(self.buffer)
            if capacity <= 0 and mode != 'eof':
                raise SolverError('maxBuffer exceeded waiting for ' + mode + '; partial frame=' + repr(bytes(self.buffer)))
            try:
                chunk = self.transport.recv(min(65536, max(1, capacity)), remaining)
            except TimeoutError as error:
                raise SolverError('Read timeout waiting for ' + mode + ' ' + repr(pattern) + '; partial frame=' + repr(bytes(self.buffer))) from error
            if not chunk:
                self.closed = True
                continue
            if self.verbose:
                print('rx:', repr(chunk), file=sys.stderr)
            if len(self.buffer) + len(chunk) > self.max_buffer:
                raise SolverError('maxBuffer exceeded waiting for EOF; partial frame=' + repr(bytes(self.buffer)) + '; extra=' + repr(chunk))
            self.buffer.extend(chunk)


def evaluate(operator, value, frame):
    if operator == 'always':
        return True
    if operator == 'contains':
        return value in frame
    if operator == 'notContains':
        return value not in frame
    if operator == 'equals':
        return frame == value
    if operator == 'notEquals':
        return frame != value
    if operator == 'startsWith':
        return frame.startswith(value)
    if operator == 'endsWith':
        return frame.endswith(value)
    if operator == 'regex':
        return compile_regex(value).search(frame) is not None
    if operator == 'notRegex':
        return compile_regex(value).search(frame) is None
    if operator == 'empty':
        return not frame
    if operator == 'notEmpty':
        return bool(frame)
    raise SolverError('Unknown condition operator: ' + repr(operator))


def reject_constant(value):
    raise SolverError('Non-finite JSON number: ' + value)


def parse_json(value):
    return json.loads(value, parse_constant=reject_constant)


def convert(value, kind):
    if kind == 'json':
        return parse_json(value) if isinstance(value, str) else value
    if kind == 'text':
        return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    text = value.strip() if isinstance(value, str) else str(value)
    if kind == 'int':
        if not re.fullmatch(r'[+-]?[0-9]+', text):
            raise SolverError('Not a decimal integer: ' + repr(text))
        return int(text, 10)
    if kind == 'float':
        if not re.fullmatch(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?', text):
            raise SolverError('Not a decimal float: ' + repr(text))
        number = float(text)
        if not math.isfinite(number):
            raise SolverError('Float must be finite')
        return number
    if kind == 'hex':
        if not re.fullmatch(r'(?:[0-9a-fA-F]{2}\s*)*', text, re.ASCII):
            raise SolverError('Not hexadecimal byte pairs: ' + repr(text))
        return bytes.fromhex(text)
    if kind == 'base64':
        if not re.fullmatch(r'(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?', text):
            raise SolverError('Not strict padded base64: ' + repr(text))
        return base64.b64decode(text, validate=True)
    raise SolverError('Unknown conversion: ' + repr(kind))


def capture_value(capture, frame):
    kind = capture['kind']
    group = capture['group'] or '0'
    if group.isascii() and group.isdigit():
        group = int(group)

    def selected(match):
        try:
            value = match.group(group)
        except (IndexError, KeyError) as error:
            raise SolverError('Missing regex group: ' + repr(group)) from error
        if value is None:
            raise SolverError('Regex group did not participate: ' + repr(group))
        return value

    if kind == 'whole':
        value = frame
    elif kind == 'regex':
        match = compile_regex(capture['pattern']).search(frame)
        if match is None:
            raise SolverError('Capture regex did not match')
        value = selected(match)
    elif kind == 'regexAll':
        matches = list(compile_regex(capture['pattern']).finditer(frame))
        if not matches:
            raise SolverError('Capture regex did not match')
        return [convert(selected(match), capture['convert']) for match in matches]
    elif kind == 'split':
        values = compile_regex(capture['pattern']).split(frame)
        index = int(capture['group'])
        if index >= len(values) or values[index] is None:
            raise SolverError('Missing split index: ' + str(index))
        value = values[index]
    elif kind == 'json':
        value = parse_json(frame)
        if capture['group']:
            for part in capture['group'].split('.'):
                if isinstance(value, list):
                    if not re.fullmatch(r'0|[1-9][0-9]*', part) or int(part) >= len(value):
                        raise SolverError('Missing JSON array index: ' + part)
                    value = value[int(part)]
                elif isinstance(value, dict) and part in value:
                    value = value[part]
                else:
                    raise SolverError('Missing JSON path segment: ' + part)
    else:
        raise SolverError('Unknown capture parser: ' + repr(kind))
    return convert(value, capture['convert'])


def render(template, context):
    # Only named fields; no attribute/index traversal, conversion or format code.
    for _, field, spec, conversion in string.Formatter().parse(template):
        if field is not None and (not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', field) or spec or conversion):
            raise SolverError('Only {name} placeholders are supported')
    try:
        return template.format_map(context)
    except KeyError as error:
        raise SolverError('Missing template value: ' + str(error)) from error


def run_action(client, action, context):
    kind = action['kind']
    if kind == 'solve':
        value = solve(context)
        if value is None:
            raise SolverError('solve(context) returned None; return a value or bytes')
        payload = value if isinstance(value, bytes) else bytes(value) if isinstance(value, (bytearray, memoryview)) else str(value).encode('utf-8')
        client.send(payload + b'\n')
        return False
    value = render(action['value'], context)
    if kind == 'sendline':
        client.send(value.encode('utf-8') + b'\n')
    elif kind == 'send':
        client.send(value.encode('utf-8'))
    elif kind == 'sendHex':
        if not re.fullmatch(r'(?:[0-9a-fA-F]{2}\s*)*', value.strip(), re.ASCII):
            raise SolverError('sendHex requires hexadecimal byte pairs')
        client.send(bytes.fromhex(value))
    elif kind == 'log':
        print(value, file=sys.stderr)
    elif kind == 'stop':
        if value:
            print(value, file=sys.stderr)
        return True
    else:
        raise SolverError('Unknown action: ' + repr(kind))
    return False


def execute(client, rounds):
    for round_number in range(1, rounds + 1):
        context = {'round': round_number, 'response': ''}
        for step_number, step in enumerate(CONFIG['steps'], 1):
            location = 'Round ' + str(round_number) + ', step ' + str(step_number) + ' (' + step['name'] + ')'
            try:
                frame = client.receive(step['receive'], step['pattern']).decode('utf-8', errors='strict')
                context['response'] = frame
                failed = [check for check in step['checks'] if not evaluate(check['operator'], check['value'], frame)]
                if failed:
                    if step['onFailure'] == 'skip':
                        if client.verbose:
                            print(location + ': checks failed; skipping captures/actions', file=sys.stderr)
                        continue
                    raise SolverError('Frame checks failed: ' + repr(failed) + '; response=' + repr(frame))
                for capture in step['captures']:
                    try:
                        context[capture['name']] = capture_value(capture, frame)
                    except (SolverError, ValueError, TypeError, IndexError, re.error) as error:
                        raise SolverError('Capture ' + repr(capture['name']) + ': ' + str(error)) from error
                for action in step['actions']:
                    if evaluate(action['operator'], action['condition'], frame):
                        if run_action(client, action, context):
                            return
            except (SolverError, OSError, UnicodeError, ValueError, TypeError, NotImplementedError, re.error) as error:
                raise SolverError(location + ': ' + str(error)) from error
    # Deliberately do not drain: a persistent service may never close. Add an
    # explicit receive=eof step when a final banner must be consumed.


def main():
    parser = argparse.ArgumentParser(description=CONFIG['name'])
    parser.add_argument('--host', default=CONFIG['host'])
    parser.add_argument('--port', type=int, default=CONFIG['port'])
    parser.add_argument('--timeout', type=float, default=CONFIG['timeout'], help='whole-frame timeout in seconds')
    parser.add_argument('--rounds', type=int, default=CONFIG['rounds'])
    parser.add_argument('-v', '--verbose', action='store_true', help='log raw rx/tx bytes to stderr')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    if not math.isfinite(args.timeout) or not 0 < args.timeout <= 86400:
        parser.error('--timeout must be finite, positive and at most 86400 seconds')
    if not 1 <= args.rounds <= 1000000000:
        parser.error('--rounds must be between 1 and 1000000000')
    client = None
    try:
        transport = Transport(args.host, args.port, args.timeout)
        client = BufferedClient(transport, args.timeout, CONFIG['maxBuffer'], args.verbose)
        execute(client, args.rounds)
        return 0
    except (SolverError, OSError) as error:
        print('Error: ' + str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('Interrupted', file=sys.stderr)
        return 130
    finally:
        if client is not None:
            client.close()


if __name__ == '__main__':
    sys.exit(main())
`;
