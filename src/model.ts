export type ReceiveMode = "until" | "line" | "regex" | "bytes" | "eof" | "none";
export type ParserKind = "regex" | "regexAll" | "split" | "json" | "whole";
export type Conversion = "text" | "int" | "float" | "hex" | "base64" | "json";
export type Operator = "always" | "contains" | "notContains" | "equals" | "notEquals" | "startsWith" | "endsWith" | "regex" | "notRegex" | "empty" | "notEmpty";
export type ActionKind = "sendline" | "send" | "sendHex" | "solve" | "log" | "stop";
export interface Capture { id: string; name: string; kind: ParserKind; pattern: string; group: string; convert: Conversion; }
export interface Check { id: string; operator: Operator; value: string; }
export interface Action { id: string; kind: ActionKind; value: string; operator: Operator; condition: string; }
export interface Step { id: string; name: string; receive: ReceiveMode; pattern: string; sample: string; captures: Capture[]; checks: Check[]; onFailure: "stop" | "skip"; actions: Action[]; }
export interface Workflow { version: 1; name: string; host: string; port: number; timeout: number; maxBuffer: number; rounds: number; steps: Step[]; }
export const uid = (): string => crypto.randomUUID();
export const operators: { value: Operator; label: string }[] = [
  { value: "always", label: "Always" }, { value: "contains", label: "Contains" },
  { value: "notContains", label: "Does not contain" }, { value: "equals", label: "Equals" },
  { value: "notEquals", label: "Does not equal" }, { value: "startsWith", label: "Starts with" },
  { value: "endsWith", label: "Ends with" }, { value: "regex", label: "Matches regex" },
  { value: "notRegex", label: "Does not match regex" }, { value: "empty", label: "Is empty" },
  { value: "notEmpty", label: "Is not empty" },
];
export const newStep = (): Step => ({ id: uid(), name: "New step", receive: "until", pattern: "> ", sample: "Welcome to the challenge\n> ", captures: [], checks: [], onFailure: "stop", actions: [{ id: uid(), kind: "sendline", value: "1", operator: "always", condition: "" }] });
export function createWorkflow(): Workflow {
  return { version: 1, name: "Untitled workflow", host: "localhost", port: 1337, timeout: 10, maxBuffer: 1048576, rounds: 1, steps: [newStep()] };
}
