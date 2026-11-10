import { uid } from "../src/model.ts";
import type { TranscriptMark } from "../src/transcript-model.ts";

export const CONVERSATION = "Hello, weclome to server inc.\nPlease state your name: Bob\nHello bob, who whould you like to write to? Alice\nWhat would you like to write:\n1) Text message\n2) Audio\n3) Exit\n> 1\nEnter the message and end with EOF?\nHallo Alice,\nhere is bob.\nEOF\nThanks for the message. It has been sent. Good bye.\n";

export function conversationMarks(): TranscriptMark[] {
  const selections = [
    ["Please state your name: ", "Bob"],
    ["Hello bob, who whould you like to write to? ", "Alice"],
    ["\n> ", "1"],
    ["Enter the message and end with EOF?\n", "Hallo Alice,\nhere is bob.\nEOF\n"],
  ] as const;
  return selections.map(([prompt, value]) => {
    const start = CONVERSATION.indexOf(prompt) + prompt.length;
    const end = start + value.length;
    return { id: uid(), start, end, kind: "send", appendNewline: !value.endsWith("\n"), name: "", pattern: "", convert: "text" };
  });
}
