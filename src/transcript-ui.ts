import "./transcript.css";
import { uid } from "./model.ts";
import type { Conversion, Workflow } from "./model.ts";
import type { ConnectionSettings, TranscriptMark, TranscriptResult } from "./transcript-model.ts";
import { buildTranscriptWorkflow } from "./transcript.ts";

const STORAGE_KEY = "compwnicator.transcript.v1";
const MAX_TEXT = 200_000;
const MAX_MARKS = 500;
const conversions: readonly Conversion[] = ["text", "int", "float", "hex", "base64", "json"];
interface Draft { version: 1; text: string; marks: TranscriptMark[]; }
interface TranscriptOptions {
  getConnection: () => ConnectionSettings;
  onBuild: (workflow: Workflow) => void;
  notify: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readDraft(value: unknown): Draft | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.text !== "string" || value.text.length > MAX_TEXT || !Array.isArray(value.marks) || value.marks.length > MAX_MARKS) return null;
  const text = value.text;
  const marks: TranscriptMark[] = [];
  const ids = new Set<string>();
  for (const item of value.marks as unknown[]) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || item.id.length > 128 || ids.has(item.id) ||
      !Number.isInteger(item.start) || !Number.isInteger(item.end) || typeof item.start !== "number" || typeof item.end !== "number" || item.start < 0 || item.end <= item.start || item.end > text.length ||
      (item.kind !== "send" && item.kind !== "capture") || typeof item.appendNewline !== "boolean" ||
      typeof item.name !== "string" || item.name.length > 128 || typeof item.pattern !== "string" || item.pattern.length > 4096 ||
      typeof item.convert !== "string" || !conversions.includes(item.convert as Conversion)) return null;
    marks.push({ id: item.id, start: item.start, end: item.end, kind: item.kind, appendNewline: item.appendNewline, name: item.name, pattern: item.pattern, convert: item.convert as Conversion });
    ids.add(item.id);
  }
  marks.sort((a, b) => a.start - b.start);
  if (marks.some((mark, index) => index > 0 && mark.start < marks[index - 1]!.end)) return null;
  return { version: 1, text, marks };
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function excerpt(text: string, limit = 100): string {
  return JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text);
}

export function mountTranscript(container: HTMLElement, options: TranscriptOptions): void {
  let draft: Draft = { version: 1, text: "", marks: [] };
  let notice = "";
  let storageWarning = "";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const restored = stored.length <= 8_000_000 ? readDraft(JSON.parse(stored) as unknown) : null;
      if (restored) draft = restored;
      else notice = "The saved transcript draft was malformed and was not loaded. Your workflow is unchanged.";
    }
  } catch { storageWarning = "Browser storage is unavailable or unreadable. Keep a copy of your transcript before leaving this page."; }
  const prefix = `tm-${uid()}`;
  container.classList.add("transcript");
  // Only static interface markup is HTML. All transcript and annotation content uses text nodes.
  container.innerHTML = `
    <section class="tm-intro" aria-labelledby="${prefix}-title">
      <div><span class="tm-eyebrow">PASTE · MARK · BUILD</span><h2 id="${prefix}-title">Build from your terminal conversation.</h2><p>Paste the full transcript, then select exactly what you typed. Everything else is treated as server output; roles are never guessed.</p></div>
    </section>
    <div class="tm-notice" data-tm="notice" role="status" hidden></div>
    <div class="tm-layout">
      <section class="tm-card tm-source" aria-labelledby="${prefix}-source-title">
        <div class="tm-card-heading"><h3 id="${prefix}-source-title">1. Paste & select</h3><span data-tm="count" class="tm-count"></span></div>
        <label class="tm-label" for="${prefix}-text">Terminal transcript</label>
        <textarea id="${prefix}-text" class="tm-textarea" data-tm="text" spellcheck="false" autocomplete="off" autocapitalize="off" maxlength="200000" aria-describedby="${prefix}-help ${prefix}-selection" placeholder="Paste your terminal output, including the inputs you typed…"></textarea>
        <p class="tm-help" id="${prefix}-help">Select each input you typed, then mark it as sent. Include every line of a multiline message. Maximum 200,000 characters.</p>
        <p class="tm-selection" id="${prefix}-selection" data-tm="selection" role="status">Select text above to annotate it.</p>
        <div class="tm-toolbar" role="group" aria-label="Mark selected transcript text">
          <button type="button" class="tm-button tm-button-send" data-tm="send" disabled>Mark as sent</button>
          <button type="button" class="tm-button tm-button-capture" data-tm="capture" disabled>Mark as capture</button>
          <button type="button" class="tm-button tm-button-quiet" data-tm="clear" disabled>Clear marks</button>
        </div>
        <details class="tm-instructions"><summary>How marking works</summary><ul><li>Mark every typed input as sent, including local terminal echo. Unmarked text becomes received server data. No names, menu choices, or message bodies are detected automatically.</li><li>Each send has an editable “Append Enter (LF)” checkbox. It starts on unless your selection already ends with a newline. A neighboring transcript newline is consumed as the local Enter echo when needed.</li><li>A selected <code>EOF</code> line is sent as literal text. Final server output does not imply the connection closed.</li><li>Capture only server output. Give it a variable name and conversion; an optional regex replaces the type-based default. No dynamic fields are guessed. Captures become editable parsers, not automatic substitutions into sends.</li><li>Editing the pasted text clears all marks to prevent stale offsets. Building replaces the editor workflow, using the connection settings above; you can edit every generated step afterward.</li></ul></details>
        <div class="tm-preview-heading"><h3>Marked transcript</h3><div class="tm-legend"><span class="tm-legend-send">Sent</span><span class="tm-legend-capture">Capture</span><span>Unmarked = received</span></div></div>
        <pre class="tm-highlight" data-tm="highlight" tabindex="0" aria-label="Read-only annotated transcript"></pre>
      </section>
      <aside class="tm-sidebar">
        <section class="tm-card" aria-labelledby="${prefix}-marks-title"><div class="tm-card-heading"><h3 id="${prefix}-marks-title">2. Review annotations</h3><span class="tm-count" data-tm="marks-count"></span></div><p class="tm-help">Listed in transcript order. Selections never overlap.</p><ol class="tm-annotations" data-tm="annotations"></ol></section>
        <section class="tm-card tm-derived" aria-labelledby="${prefix}-build-title"><div class="tm-card-heading"><h3 id="${prefix}-build-title">3. Build the workflow</h3></div><p class="tm-help">Live preview of receive boundaries and outgoing replies. Nothing is sent from this browser.</p><div class="tm-errors" data-tm="errors" role="status" hidden></div><ol class="tm-summary" data-tm="summary"></ol><button type="button" class="tm-button tm-button-primary" data-tm="build" disabled>Build workflow</button><p class="tm-help">The resulting Python and all receive, capture, and send settings remain editable in the workflow editor.</p></section>
      </aside>
    </div>`;
  function query<T extends HTMLElement>(name: string): T { return container.querySelector<T>(`[data-tm="${name}"]`)!; }
  const textarea = query<HTMLTextAreaElement>("text");
  textarea.value = draft.text;
  if (textarea.value !== draft.text) {
    draft.text = textarea.value;
    draft.marks = [];
    notice = "Saved line endings were normalized by the text editor. Marks were cleared so their offsets cannot drift.";
  }
  let selection = { start: 0, end: 0 };

  function renderNotice(): void {
    const node = query("notice");
    node.textContent = [notice, storageWarning].filter(Boolean).join(" ");
    node.hidden = !node.textContent;
  }
  function announce(message: string): void { notice = message; renderNotice(); }
  function persist(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(draft)); }
    catch { storageWarning = "This transcript draft could not be saved in browser storage. Keep a copy before leaving this page."; renderNotice(); }
  }
  function saveSelection(): void {
    selection = { start: textarea.selectionStart, end: textarea.selectionEnd };
    renderSelection();
  }
  function renderSelection(): void {
    const { start, end } = selection;
    const hasSelection = end > start;
    const overlaps = draft.marks.some((mark) => start < mark.end && end > mark.start);
    query("selection").textContent = hasSelection
      ? `Selected [${start}, ${end}) · ${end - start} UTF-16 characters: ${excerpt(draft.text.slice(start, end), 80)}${overlaps ? " — overlaps an existing mark; remove it first." : ""}`
      : "Select text above to annotate it. Offsets use UTF-16 positions; the end is exclusive.";
    const disabled = !hasSelection || overlaps || draft.marks.length >= MAX_MARKS;
    query<HTMLButtonElement>("send").disabled = disabled;
    query<HTMLButtonElement>("capture").disabled = disabled;
    query<HTMLButtonElement>("clear").disabled = draft.marks.length === 0;
  }
  function renderHighlight(): void {
    const preview = query("highlight");
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const mark of draft.marks) {
      fragment.append(document.createTextNode(draft.text.slice(cursor, mark.start)));
      const span = element("mark", `tm-mark tm-mark-${mark.kind}`, draft.text.slice(mark.start, mark.end));
      span.title = `${mark.kind === "send" ? "Sent" : `Capture: ${mark.name}`} [${mark.start}, ${mark.end})`;
      fragment.append(span);
      cursor = mark.end;
    }
    fragment.append(document.createTextNode(draft.text.slice(cursor) || (draft.text ? "" : "Your annotated transcript will appear here.")));
    preview.replaceChildren(fragment);
  }
  function derive(): TranscriptResult {
    try { return buildTranscriptWorkflow(draft.text, draft.marks, options.getConnection()); }
    catch (error) { return { workflow: null, errors: [error instanceof Error ? error.message : "The transcript could not be converted. Review the marks and connection settings."] }; }
  }
  function renderDerived(): TranscriptResult {
    const result = derive();
    const errors = query("errors");
    errors.replaceChildren();
    errors.hidden = result.errors.length === 0;
    if (result.errors.length) {
      errors.append(element("strong", "", "Needs attention"));
      const list = element("ul");
      for (const error of result.errors) list.append(element("li", "", error));
      errors.append(list);
    }
    const summary = query("summary");
    summary.replaceChildren();
    if (result.workflow && result.errors.length === 0) {
      for (const step of result.workflow.steps) {
        const item = element("li", "tm-summary-step");
        item.append(element("strong", "", step.name));
        const boundary = step.receive === "none" ? "No receive (send first)" : `${step.receive === "regex" ? "Receive through regex" : step.receive === "until" ? "Receive through delimiter" : `Receive: ${step.receive}`} ${excerpt(step.pattern, 120)}`;
        item.append(element("code", "tm-boundary", boundary));
        for (const capture of step.captures) item.append(element("span", "tm-summary-capture", `Capture ${capture.name} → ${capture.convert}`));
        for (const action of step.actions) {
          const description = action.kind === "send" || action.kind === "sendline" ? `${action.kind === "sendline" ? "Send + LF" : "Send"}: ${excerpt(action.value, 100)}` : action.kind === "log" ? "Log final server response (not socket EOF)" : action.kind;
          item.append(element("code", "tm-boundary", description));
        }
        summary.append(item);
      }
    } else summary.append(element("li", "tm-empty", "Mark at least one typed input as sent, then resolve the errors above to preview the workflow."));
    query<HTMLButtonElement>("build").disabled = !result.workflow || result.errors.length > 0;
    return result;
  }
  function renderAnnotations(): void {
    const list = query("annotations");
    list.replaceChildren();
    query("marks-count").textContent = `${draft.marks.length} / ${MAX_MARKS}`;
    if (!draft.marks.length) list.append(element("li", "tm-empty", "No annotations yet. Select a typed input and choose Mark as sent."));
    for (const [index, mark] of draft.marks.entries()) {
      const item = element("li", `tm-annotation tm-annotation-${mark.kind}`);
      const heading = element("div", "tm-annotation-heading");
      heading.append(element("strong", "", `${index + 1}. ${mark.kind === "send" ? "Sent input" : "Server capture"}`));
      const remove = element("button", "tm-button tm-button-quiet", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove annotation ${index + 1}`);
      remove.addEventListener("click", () => {
        draft.marks = draft.marks.filter((entry) => entry.id !== mark.id);
        refresh(); persist();
        const fallback = query<HTMLButtonElement>("clear");
        (draft.marks.length ? fallback : textarea).focus();
      });
      heading.append(remove);
      item.append(heading, element("span", "tm-offsets", `[${mark.start}, ${mark.end}) · ${mark.end - mark.start} characters`), element("pre", "tm-mark-excerpt", excerpt(draft.text.slice(mark.start, mark.end), 180)));
      const changed = (): void => { renderHighlight(); renderDerived(); persist(); };
      if (mark.kind === "send") {
        const label = element("label", "tm-checkbox");
        const checkbox = element("input");
        checkbox.type = "checkbox";
        checkbox.checked = mark.appendNewline;
        checkbox.addEventListener("change", () => { mark.appendNewline = checkbox.checked; changed(); });
        label.append(checkbox, document.createTextNode("Append Enter (LF)"));
        item.append(label);
      } else {
        const fields = element("div", "tm-capture-fields");
        const nameLabel = element("label", "tm-field");
        nameLabel.append(element("span", "", "Variable name"));
        const name = element("input");
        name.type = "text"; name.value = mark.name; name.maxLength = 128; name.spellcheck = false; name.autocomplete = "off";
        name.addEventListener("input", () => { mark.name = name.value; changed(); });
        nameLabel.append(name);
        const convertLabel = element("label", "tm-field");
        convertLabel.append(element("span", "", "Convert to"));
        const convert = element("select");
        for (const value of conversions) {
          const option = element("option", "", value === "hex" ? "hex bytes" : value === "base64" ? "base64 bytes" : value);
          option.value = value; option.selected = value === mark.convert; convert.append(option);
        }
        convert.addEventListener("change", () => { mark.convert = convert.value as Conversion; changed(); });
        convertLabel.append(convert);
        fields.append(nameLabel, convertLabel);
        const patternLabel = element("label", "tm-field tm-pattern-field");
        patternLabel.append(element("span", "", "Optional Python regex (selected value only)"));
        const pattern = element("input");
        pattern.type = "text"; pattern.value = mark.pattern; pattern.maxLength = 4096; pattern.spellcheck = false; pattern.autocomplete = "off"; pattern.placeholder = "Leave empty for type-based default";
        pattern.addEventListener("input", () => { mark.pattern = pattern.value; changed(); });
        patternLabel.append(pattern);
        item.append(fields, patternLabel, element("p", "tm-help", "The selection is the capture value. Surrounding server text anchors its parser. Python and browser regex syntax may differ."));
      }
      list.append(item);
    }
  }
  function refresh(): void {
    query("count").textContent = `${draft.text.length.toLocaleString()} / 200,000`;
    renderSelection(); renderHighlight(); renderAnnotations(); renderDerived(); renderNotice();
  }
  function addMark(kind: TranscriptMark["kind"]): void {
    const { start, end } = selection;
    if (end <= start || end > draft.text.length) { announce("Select the exact text in the transcript first."); return; }
    if (draft.marks.length >= MAX_MARKS) { announce(`A transcript can have at most ${MAX_MARKS} annotations.`); return; }
    if (draft.marks.some((mark) => start < mark.end && end > mark.start)) { announce("Annotations cannot overlap. Remove the existing mark before selecting that text again."); return; }
    let captureIndex = 1;
    while (draft.marks.some((mark) => mark.kind === "capture" && mark.name === `capture_${captureIndex}`)) captureIndex++;
    draft.marks.push({ id: uid(), start, end, kind, appendNewline: !draft.text.slice(start, end).endsWith("\n"), name: kind === "capture" ? `capture_${captureIndex}` : "", pattern: "", convert: "text" });
    draft.marks.sort((a, b) => a.start - b.start);
    notice = `${kind === "send" ? "Sent input" : "Capture"} marked at [${start}, ${end}). Review its settings in the annotation list.`;
    refresh(); persist();
  }
  for (const event of ["select", "keyup", "mouseup", "touchend", "blur"] as const) textarea.addEventListener(event, saveSelection);
  textarea.addEventListener("paste", (event) => {
    const pasted = event.clipboardData?.getData("text");
    if (pasted !== undefined && textarea.value.length - (textarea.selectionEnd - textarea.selectionStart) + pasted.replace(/\r\n?/g, "\n").length > MAX_TEXT) {
      event.preventDefault();
      announce("Paste blocked: the transcript would exceed 200,000 characters. Your current text and marks were kept.");
    }
  });
  textarea.addEventListener("input", () => {
    if (textarea.value.length > MAX_TEXT) {
      textarea.value = draft.text;
      announce("Input blocked: the transcript cannot exceed 200,000 characters. Your previous text and marks were kept.");
      saveSelection(); return;
    }
    if (textarea.value === draft.text) return;
    const hadMarks = draft.marks.length > 0;
    draft.text = textarea.value; draft.marks = [];
    selection = { start: textarea.selectionStart, end: textarea.selectionEnd };
    notice = hadMarks ? "Transcript edited: all annotations were cleared to prevent stale selection offsets. Mark the typed inputs again." : "";
    refresh(); persist();
  });
  query("send").addEventListener("click", () => addMark("send"));
  query("capture").addEventListener("click", () => addMark("capture"));
  query("clear").addEventListener("click", () => {
    draft.marks = []; notice = "All annotations cleared. The pasted transcript is unchanged.";
    refresh(); persist(); textarea.focus();
  });
  query("build").addEventListener("click", () => {
    const result = renderDerived();
    if (!result.workflow || result.errors.length) { announce("Resolve the transcript errors before building. Your text and marks are unchanged."); return; }
    options.onBuild(result.workflow);
  });
  // Connection controls live outside this component. Re-derive with their current values,
  // and always derive again on build so hidden mode toggles cannot leave stale settings.
  document.addEventListener("input", (event) => {
    if (event.target instanceof Node && !container.contains(event.target)) renderDerived();
  });
  container.addEventListener("focusin", (event) => {
    if (event.target === query("build")) renderDerived();
  });
  refresh();
}
