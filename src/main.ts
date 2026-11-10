import "./style.css";
import { createWorkflow, newStep, operators, uid } from "./model.ts";
import type { Workflow, Step, Capture, Action, Check, Operator } from "./model.ts";
import { generatePython, validateWorkflow, previewStep, type PythonVariant } from "./generator.ts";
import { mountTranscript } from "./transcript-ui.ts";

const STORAGE_KEY = "compwnicator.workflow.v1";
const VARIANT_KEY = "compwnicator.python-variant.v1";
let pythonVariant: PythonVariant = "socket";
try { if (localStorage.getItem(VARIANT_KEY) === "pwntools") pythonVariant = "pwntools"; } catch { /* Socket output is the default. */ }
const outputFilename = (): string => pythonVariant === "pwntools" ? "solver_pwntools.py" : "solver.py";
const THEME_KEY = "compwnicator.theme.v1";
let theme = "dark";
try { if (localStorage.getItem(THEME_KEY) === "light") theme = "light"; } catch { /* Dark is the default. */ }
document.documentElement.dataset.theme = theme;
const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const icon = (name: string): string => {
  const paths: Record<string, string> = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
    arrow: '<path d="m9 5 7 7-7 7"/>',
    code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon: '<path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>',
    terminal: '<path d="m5 7 5 5-5 5m8 0h6"/>',
  };
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.code}</svg>`;
};
const options = (items: readonly (readonly [string, string])[], selected: string): string => items.map(([value, label]) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`).join("");
const operatorOptions = (selected: string): string => options(operators.map(({ value, label }) => [value, label]), selected);
const needsValue = (operator: Operator): boolean => !["always", "empty", "notEmpty"].includes(operator);
let persistenceWarning = "";
let initialNotice = "";
let workflow = createWorkflow();
function validation(value: unknown): string[] {
  try { return validateWorkflow(value); } catch { return ["This workflow could not be validated. Check its structure and field types."]; }
}
try {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const parsed: unknown = JSON.parse(stored);
    const errors = validation(parsed);
    if (errors.length === 0) workflow = parsed as Workflow;
    else initialNotice = "Your saved workflow was not valid. A new workflow has been loaded instead.";
  }
} catch { persistenceWarning = "Browser storage is unavailable or unreadable. Export JSON to keep your work."; }
let selectedId = workflow.steps[0]?.id ?? "";
let generated = "";
let workflowErrors: string[] = [];
let statusTimer: number | undefined;
const app = document.querySelector<HTMLDivElement>("#app")!;
const selectedStep = (): Step | undefined => workflow.steps.find((step) => step.id === selectedId);

app.innerHTML = `
  <header class="app-header">
    <a class="brand" href="#" aria-label="Compwnicator home"><span class="brand-mark">${icon("terminal")}</span>compwnicator<span class="brand-period">.</span></a>
    <span class="header-caption">TCP → Python</span>
    <div class="header-right"><span class="local-badge" id="save-status"><span class="status-dot"></span>Saved in this browser</span><button class="icon-button theme-toggle" id="theme-toggle" aria-label="Switch to light theme" title="Switch to light theme">${icon("sun")}</button></div>
  </header>
  <main>
    <section class="workspace-heading" aria-labelledby="workspace-title">
      <div><span class="eyebrow">SOLVER BUILDER</span><h1 id="workspace-title">Build the conversation.</h1><p>Choose what to receive, capture what you need, and send a reply.</p></div>
      <div class="workspace-tools"><button class="button button-secondary" id="new-workflow">${icon("plus")}New workflow</button><button class="button button-secondary" id="import-button">${icon("upload")}Import</button><button class="button button-secondary" id="export-button">${icon("download")}Export JSON</button><input type="file" id="import-file" accept=".json,application/json" hidden /></div>
    </section>
    <div id="notice" role="status" class="notice" hidden></div>
    <section class="connection-card" aria-labelledby="connection-title">
      <div class="connection-heading"><span class="section-icon">${icon("terminal")}</span><div><h2 id="connection-title">Challenge connection</h2><p>Used by your Python script</p></div></div>
      <div class="connection-fields">
        <label class="field host-field"><span>Host</span><input id="host" data-workflow-field="host" type="text" autocomplete="off" spellcheck="false" /></label>
        <label class="field"><span>Port</span><input id="port" data-workflow-field="port" type="number" min="1" max="65535" /></label>
        <label class="field"><span>Rounds</span><input id="rounds" data-workflow-field="rounds" type="number" min="1" step="1" /></label>
      </div>
      <details class="connection-advanced"><summary>Advanced settings</summary><div class="advanced-fields">
        <label class="field"><span>Timeout <small>seconds</small></span><input id="timeout" data-workflow-field="timeout" type="number" min="0.01" step="any" /></label>
        <label class="field buffer-field"><span>Buffer limit <small>bytes</small></span><input id="maxBuffer" data-workflow-field="maxBuffer" type="number" min="1" step="1" /></label>
      </div></details>
    </section>
    <div class="workspace-navigation"><div class="mode-tabs" role="tablist" aria-label="Builder views">
      <button id="tab-workflow" class="mode-tab" role="tab" aria-selected="true" aria-controls="panel-workflow" data-view="workflow">${icon("plus")}Workflow builder</button>
      <button id="tab-transcript" class="mode-tab" role="tab" aria-selected="false" aria-controls="panel-transcript" data-view="transcript" tabindex="-1">${icon("terminal")}Paste a conversation</button>
      <button id="tab-python" class="mode-tab" role="tab" aria-selected="false" aria-controls="panel-python" data-view="python" tabindex="-1">${icon("code")}Generated Python<span class="tab-dot" id="python-status" aria-hidden="true"></span></button>
    </div><span class="workspace-hint">Your script updates as you build</span></div>
    <div id="panel-workflow" role="tabpanel" aria-labelledby="tab-workflow" class="workbench">
      <aside class="step-rail" aria-labelledby="steps-title"><div class="rail-footer"><label for="workflow-name">Workflow name</label><input id="workflow-name" data-workflow-field="name" type="text" placeholder="Untitled workflow" /></div><div class="rail-heading"><h2 id="steps-title">Steps</h2><span id="step-count" class="count-badge"></span></div><p class="rail-description">Run from top to bottom.</p><nav id="step-list" aria-label="Workflow steps"></nav><button class="add-step" id="add-step">${icon("plus")}Add step</button><div class="round-note"><span class="round-symbol" aria-hidden="true">↻</span><div><strong id="round-summary"></strong><p>Captured values are shared across steps within each round.</p></div></div></aside>
      <section class="editor-panel" aria-label="Selected step editor"><div id="step-editor"></div></section>
    </div>
    <div id="panel-transcript" role="tabpanel" aria-labelledby="tab-transcript" hidden></div>
    <section id="panel-python" class="output-panel" role="tabpanel" aria-labelledby="tab-python" hidden><div class="output-heading"><div><span class="eyebrow">READY TO MAKE IT YOURS</span><h2 id="output-title">Your Python solver</h2><p>Download the script and add your challenge logic in <code>solve(context)</code>.</p></div><div class="output-actions"><button class="button button-secondary" id="copy-button">${icon("copy")}Copy Python</button><button class="button button-primary" id="download-button">${icon("download")}Download solver.py</button></div></div><div class="output-options"><label class="field" for="python-variant"><span>Python library</span><select id="python-variant"><option value="socket">Standard library · sockets</option><option value="pwntools">pwntools</option></select></label><p id="dependency-note">No Python packages to install.</p></div><div id="validation-errors" class="validation-errors" role="status" hidden></div><div class="code-toolbar"><span>${icon("code")} <span id="output-filename">solver.py</span></span><div class="output-meta"><span id="runtime-label">Python 3 · standard library</span><span id="line-count"></span></div></div><pre class="code-view" tabindex="0" aria-label="Generated Python source"><code id="python-code"></code></pre><div class="output-bottom"><code class="run-command" id="run-command">$ python3 solver.py</code><p>Captures, <code>round</code>, and the latest <code>response</code> are available in <code>solve(context)</code>.</p></div></section>
    <div class="builder-bottom"><span id="workflow-status" role="status"></span><button class="button button-primary" id="review-python">Review Python${icon("arrow")}</button></div>
    <footer class="app-footer"><span>${icon("shield")}Your work stays in this browser. The downloaded script connects to your challenge.</span><span>Compwnicator · TCP solver builder</span></footer>
  </main><div id="toast" class="toast" role="status" aria-live="polite"></div>`;

type View = "workflow" | "transcript" | "python";
function setView(view: View, focus = false): void {
  for (const name of ["workflow", "transcript", "python"] as const) {
    const active = name === view;
    const tab = document.querySelector<HTMLButtonElement>(`#tab-${name}`)!;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    document.querySelector<HTMLElement>(`#panel-${name}`)!.hidden = !active;
    if (active && focus) tab.focus();
  }
  document.querySelector<HTMLElement>(".builder-bottom")!.hidden = view === "python";
}
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(tab => {
  tab.addEventListener("click", () => setView(tab.dataset.view as View));
});
document.querySelector(".mode-tabs")!.addEventListener("keydown", event => {
  const key = (event as KeyboardEvent).key;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
  event.preventDefault();
  const views: View[] = ["workflow", "transcript", "python"];
  const current = views.findIndex(view => document.querySelector(`#tab-${view}`)!.getAttribute("aria-selected") === "true");
  const next = key === "Home" ? 0 : key === "End" ? 2 : (current + (key === "ArrowRight" ? 1 : -1) + views.length) % views.length;
  setView(views[next]!, true);
});
document.querySelector("#review-python")!.addEventListener("click", () => {
  setView("python", true);
  document.querySelector(".workspace-navigation")!.scrollIntoView({ block: "start" });
});
function renderTheme(): void {
  const button = document.querySelector<HTMLButtonElement>("#theme-toggle")!;
  const label = `Switch to ${theme === "dark" ? "light" : "dark"} theme`;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = icon(theme === "dark" ? "sun" : "moon");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0c1017" : "#f3f5f8");
}
document.querySelector("#theme-toggle")!.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* Theme still works for this session. */ }
  renderTheme();
});
renderTheme();

function notify(message: string): void {
  const toast = document.querySelector<HTMLDivElement>("#toast")!;
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => toast.classList.remove("visible"), 5500);
}
function renderNotice(message = initialNotice): void {
  const notice = document.querySelector<HTMLDivElement>("#notice")!;
  notice.textContent = [message, persistenceWarning].filter(Boolean).join(" ");
  notice.hidden = !notice.textContent;
}
function fillConnection(): void {
  for (const key of ["host", "port", "timeout", "rounds", "maxBuffer", "name"] as const) {
    const input = document.querySelector<HTMLInputElement>(`[data-workflow-field="${key}"]`)!;
    input.value = String(workflow[key]);
  }
}
function renderRail(): void {
  document.querySelector("#step-count")!.textContent = String(workflow.steps.length).padStart(2, "0");
  document.querySelector("#round-summary")!.textContent = `${workflow.rounds} ${workflow.rounds === 1 ? "round" : "rounds"}, same sequence`;
  const readLabels: Record<Step["receive"], string> = { until: "Wait for prompt", line: "Read a line", regex: "Match response", bytes: "Read bytes", eof: "Read to close", none: "Send first" };
  const actionLabels: Record<Action["kind"], string> = { sendline: "Send line", send: "Send text", sendHex: "Send bytes", solve: "Solve + send", log: "Print", stop: "Stop" };
  document.querySelector("#step-list")!.innerHTML = workflow.steps.map((step, index) => `<button class="step-item${step.id === selectedId ? " selected" : ""}" data-select-step="${esc(step.id)}"${step.id === selectedId ? ' aria-current="step"' : ""}><span class="step-number">${String(index + 1).padStart(2, "0")}</span><span class="step-item-copy"><strong>${esc(step.name || "Untitled step")}</strong><small>${readLabels[step.receive]}<span>→</span>${step.actions.length ? step.actions.map(action => actionLabels[action.kind]).join(", ") : "Continue"}</small></span>${icon("arrow")}</button>`).join("") || '<div class="rail-empty">No steps yet.<br />Add a step to get started.</div>';
}
function sectionHeader(number: string, title: string, subtitle: string, button = ""): string {
  return `<div class="section-heading"><span class="section-number">${number}</span><div><h3>${title}</h3><p>${subtitle}</p></div>${button}</div>`;
}
function renderEditor(): void {
  const step = selectedStep();
  const editor = document.querySelector("#step-editor")!;
  if (!step) {
    editor.innerHTML = `<div class="empty-editor"><span class="empty-symbol">${icon("code")}</span><span class="eyebrow">A CLEAN SLATE</span><h2>Start a conversation.</h2><p>Add your first step, choose how to receive a frame, and tell your solver what to send back.</p><button class="button button-primary" data-action="add-step">${icon("plus")}Add the first step</button><p class="small-note">Or paste a terminal conversation in the next tab.</p></div>`;
    return;
  }
  const index = workflow.steps.indexOf(step);
  const disclosures = new Map(Array.from(editor.querySelectorAll<HTMLDetailsElement>("details[data-disclosure]"), item => [item.dataset.disclosure, item.open]));
  const previousStep = editor.getAttribute("data-step-id");
  editor.setAttribute("data-step-id", step.id);
  const captureHints: Record<Capture["kind"], string> = { regex: "Extract one match. Group is a number or a named group.", regexAll: "Extract every regex match using the selected group.", split: "Split on a regex delimiter; select a zero-based part. Escape regex punctuation for a literal delimiter.", json: "Parse JSON; use a dot-separated path, or leave it blank for the whole value.", whole: "Capture the entire decoded frame; no pattern or group needed." };
  const receiveHints: Record<Step["receive"], string> = { until: "Receive through the exact delimiter, including it. The next bytes stay buffered.", line: "Receive one complete line, including its newline.", regex: "Receive through the end of a regex match. Use a complete prompt or frame.", bytes: "Receive exactly this many bytes, then decode as UTF-8.", eof: "Receive until the server closes the connection.", none: "Receive nothing. Continue immediately with an empty frame." };
  editor.innerHTML = `
    <div class="editor-titlebar"><div><span class="eyebrow">STEP ${String(index + 1).padStart(2, "0")} / ${String(workflow.steps.length).padStart(2, "0")}</span><label class="sr-only" for="step-name">Step name</label><input class="step-title-input" id="step-name" data-step-field="name" value="${esc(step.name)}" placeholder="Name this exchange" /></div><div class="step-tools"><button class="icon-button" data-action="move-up" title="Move step up" aria-label="Move step up"${index === 0 ? " disabled" : ""}>↑</button><button class="icon-button" data-action="move-down" title="Move step down" aria-label="Move step down"${index === workflow.steps.length - 1 ? " disabled" : ""}>↓</button><button class="icon-button" data-action="duplicate" title="Duplicate step" aria-label="Duplicate step">${icon("copy")}</button><button class="icon-button danger-button" data-action="delete-step" title="Delete step" aria-label="Delete step">${icon("trash")}</button></div></div>
    <div class="editor-content">
      <section class="editor-section">${sectionHeader("01", "Receive from the server", "Choose when to stop reading and continue to your reply.")}<div class="receive-fields"><label class="field"><span>Read method</span><select data-step-field="receive">${options([["until", "Until delimiter"], ["line", "One line"], ["regex", "Until regex match"], ["bytes", "Exact byte count"], ["eof", "Until connection closes"], ["none", "No receive"]], step.receive)}</select></label>${["until", "regex", "bytes"].includes(step.receive) ? `<label class="field pattern-field"><span>${step.receive === "bytes" ? "Byte count" : step.receive === "regex" ? "Python regex pattern" : "Exact delimiter"}</span><textarea class="mono boundary-input" data-step-field="pattern" rows="2" spellcheck="false" placeholder="${step.receive === "until" ? "> " : step.receive === "bytes" ? "64" : "([0-9a-f]+)\\r?\\n"}">${esc(step.pattern)}</textarea></label>` : ""}</div><p class="field-help">${receiveHints[step.receive]} ${step.receive === "until" ? "Delimiters are literal text, not escaped strings." : ""}</p><label class="field sample-field"><span>Sample server output <small>offline preview only</small></span><textarea class="mono" data-step-field="sample" rows="4" spellcheck="false" placeholder="Paste a complete server response…">${esc(step.sample)}</textarea></label></section>
      <section class="editor-section">${sectionHeader("02", "Send a reply", "Choose what your script sends after receiving this response.", `<button class="text-button" data-action="add-action">${icon("plus")}Add reply</button>`)}${step.actions.map((action, ai) => `<div class="item-card action-card"><div class="item-card-heading"><span>ACTION ${String(ai + 1).padStart(2, "0")}</span><button class="icon-button" data-action="remove-action" data-id="${esc(action.id)}" aria-label="Remove action ${ai + 1}">${icon("trash")}</button></div><label class="field"><span>Action</span><select data-action-field="kind" data-id="${esc(action.id)}">${options([["sendline", "Send text + newline"], ["send", "Send text · no newline"], ["sendHex", "Send raw hex bytes"], ["solve", "Call solve(context) + send line"], ["log", "Print to local terminal"], ["stop", "Stop solver successfully"]], action.kind)}</select></label>${!["solve", "stop"].includes(action.kind) ? `<label class="field action-value"><span>${action.kind === "sendHex" ? "Hex payload" : action.kind === "log" ? "Log message template" : "Response template"}</span><textarea rows="2" class="mono" data-action-field="value" data-id="${esc(action.id)}" spellcheck="false" placeholder="${action.kind === "sendHex" ? "deadbeef" : "{answer}"}">${esc(action.value)}</textarea></label>` : action.kind === "solve" ? '<div class="solve-call"><code>solve(context) → sendline(result)</code><p>Implement your challenge logic in the generated Python hook. It deliberately raises <code>NotImplementedError</code> until you do.</p></div>' : '<p class="field-help">End the workflow and close the connection cleanly.</p>'}<details class="action-condition"${action.operator !== "always" ? " open" : ""}><summary>Only send when… <span>${esc(operators.find(item => item.value === action.operator)?.label ?? "Always")}</span></summary><div class="condition-row"><span>Run when</span><label class="field"><span class="sr-only">Action ${ai + 1} condition operator</span><select data-action-field="operator" data-id="${esc(action.id)}">${operatorOptions(action.operator)}</select></label>${needsValue(action.operator) ? `<label class="field"><span class="sr-only">Action ${ai + 1} condition value</span><input class="mono" data-action-field="condition" data-id="${esc(action.id)}" value="${esc(action.condition)}" placeholder="Frame text or regex" spellcheck="false" /></label>` : ""}</div></details></div>`).join("") || '<p class="section-empty">Listen only. This step sends nothing back.</p>'}<p class="template-tip">Use <code>{name}</code> to insert a captured value. Escape literal braces with <code>{{</code> and <code>}}</code>.</p></section>
      <details class="editor-section optional-section" data-disclosure="captures"${step.captures.length ? " open" : ""}><summary><span class="optional-icon">+</span><span>Capture values<small>Extract variables for later replies or your solve function</small></span><span class="optional-count">${step.captures.length || "Optional"}</span></summary><div class="optional-content">${sectionHeader("", "Values to extract", "", `<button class="text-button" data-action="add-capture">${icon("plus")}Add capture</button>`)}<div class="capture-list">${step.captures.map((capture, ci) => `<div class="item-card capture-card"><div class="item-card-heading"><span>CAPTURE ${String(ci + 1).padStart(2, "0")}</span><button class="icon-button" data-action="remove-capture" data-id="${esc(capture.id)}" aria-label="Remove capture ${ci + 1}">${icon("trash")}</button></div><div class="two-columns"><label class="field"><span>Variable name</span><input class="mono" data-capture-field="name" data-id="${esc(capture.id)}" value="${esc(capture.name)}" placeholder="ciphertext" spellcheck="false" /></label><label class="field"><span>Parser</span><select data-capture-field="kind" data-id="${esc(capture.id)}">${options([["regex", "Regex · first match"], ["regexAll", "Regex · all matches"], ["split", "Split text"], ["json", "JSON path"], ["whole", "Whole frame"]], capture.kind)}</select></label></div><div class="capture-details">${!["whole", "json"].includes(capture.kind) ? `<label class="field"><span>${capture.kind === "split" ? "Delimiter regex" : "Python regex pattern"}</span><input class="mono" data-capture-field="pattern" data-id="${esc(capture.id)}" value="${esc(capture.pattern)}" spellcheck="false" /></label>` : ""}${capture.kind !== "whole" ? `<label class="field"><span>${capture.kind === "json" ? "JSON path" : capture.kind === "split" ? "Part index" : "Match group"}</span><input class="mono" data-capture-field="group" data-id="${esc(capture.id)}" value="${esc(capture.group)}" placeholder="${capture.kind === "json" ? "data.token" : "1"}" spellcheck="false" /></label>` : ""}<label class="field"><span>Convert to</span><select data-capture-field="convert" data-id="${esc(capture.id)}">${options([["text", "Text"], ["int", "Integer"], ["float", "Float"], ["hex", "Bytes · hex"], ["base64", "Bytes · base64"], ["json", "JSON value"]], capture.convert)}</select></label></div><p class="field-help">${captureHints[capture.kind]}</p></div>`).join("") || '<p class="section-empty">No values to extract? Leave this empty.</p>'}</div></div></details>
      <details class="editor-section optional-section" data-disclosure="checks"${step.checks.length ? " open" : ""}><summary><span class="optional-icon">✓</span><span>Validate the response<small>Stop or skip a step when the server sends something unexpected</small></span><span class="optional-count">${step.checks.length || "Optional"}</span></summary><div class="optional-content">${sectionHeader("", "Response checks", "", `<button class="text-button" data-action="add-check">${icon("plus")}Add check</button>`)}${step.checks.map((check, ci) => `<div class="inline-rule"><span class="rule-marker" aria-hidden="true">✓</span><label class="field"><span class="sr-only">Check ${ci + 1} operator</span><select data-check-field="operator" data-id="${esc(check.id)}">${operatorOptions(check.operator)}</select></label>${needsValue(check.operator) ? `<label class="field rule-value"><span class="sr-only">Check ${ci + 1} comparison value</span><input class="mono" data-check-field="value" data-id="${esc(check.id)}" value="${esc(check.value)}" placeholder="Expected text or pattern" spellcheck="false" /></label>` : '<span class="rule-value"></span>'}<button class="icon-button" data-action="remove-check" data-id="${esc(check.id)}" aria-label="Remove check ${ci + 1}">${icon("trash")}</button></div>`).join("") || '<p class="section-empty">No checks. Every received frame can continue.</p>'}<div class="failure-row"><label for="on-failure">If any check fails</label><select id="on-failure" data-step-field="onFailure">${options([["stop", "Stop solver with an error"], ["skip", "Skip this step’s captures + actions"]], step.onFailure)}</select></div><p class="field-help">Checks inspect the entire decoded frame. Negative checks need a complete frame, not a partial prompt.</p></div></details>
      <section class="preview-section" aria-labelledby="preview-title"><div class="preview-heading"><div><span class="preview-dot"></span><h3 id="preview-title">Sample preview</h3></div><span class="small-tag">OFFLINE</span></div><div id="preview-results" aria-live="polite"></div><p class="preview-caveat">Preview uses JavaScript regex, not Python <code>re</code>. Named groups, lookbehinds, flags, and other syntax may differ. Nothing is executed or sent.</p></section>
    <div class="editor-navigation"><span>Steps run in the order shown on the left.</span><button class="button button-secondary" data-action="next-step">${index < workflow.steps.length - 1 ? "Next step" : "Add next step"}${icon("arrow")}</button></div></div>`;
  if (previousStep === step.id) for (const details of editor.querySelectorAll<HTMLDetailsElement>("details[data-disclosure]")) {
    const open = disclosures.get(details.dataset.disclosure);
    if (open !== undefined) details.open = open;
  }
  renderPreview();
}
function displayValue(value: unknown): string {
  if (value instanceof Uint8Array) return `bytes: ${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (typeof value === "string") return JSON.stringify(value);
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}
function renderPreview(): void {
  const step = selectedStep();
  const container = document.querySelector("#preview-results");
  if (!step || !container) return;
  try {
    const preview = previewStep(step);
    const captures = Object.entries(preview.captures);
    container.innerHTML = `${preview.errors.length ? `<ul class="preview-errors">${preview.errors.map((error) => `<li>${esc(error)}</li>`).join("")}</ul>` : ""}${captures.length ? `<div class="preview-captures">${captures.map(([name, value]) => `<div><code>${esc(name)}</code><pre>${esc(displayValue(value))}</pre></div>`).join("")}</div>` : `<p class="preview-empty">${preview.errors.length ? "Adjust the sample or settings above to preview this step." : step.receive === "none" ? "This step sends first, without waiting for a server response." : "Sample matches the receive boundary. Add captures to extract values."}</p>`}${preview.checks.length ? `<div class="preview-checks">${preview.checks.map((check) => `<div class="preview-check ${check.passed ? "passed" : "failed"}"><span>${check.passed ? "✓" : "×"}</span><span>${esc(check.label)}</span><strong>${check.passed ? "PASS" : "FAIL"}</strong></div>`).join("")}</div>` : ""}`;
  } catch (error) { container.textContent = `Preview unavailable: ${error instanceof Error ? error.message : "Check your sample and patterns."}`; }
}
function updateDerived(persist = true): void {
  workflowErrors = validation(workflow);
  generated = "";
  if (workflowErrors.length === 0) {
    try { generated = generatePython(workflow, pythonVariant); }
    catch (error) { workflowErrors = [error instanceof Error ? error.message : "Python generation failed. Check your workflow."]; }
  }
  const errors = document.querySelector<HTMLDivElement>("#validation-errors")!;
  errors.hidden = workflowErrors.length === 0;
  errors.innerHTML = workflowErrors.length ? `<strong>Fix these settings to generate Python</strong><ul>${workflowErrors.map((error) => `<li>${esc(error)}</li>`).join("")}</ul>` : "";
  const filename = outputFilename();
  document.querySelector("#output-filename")!.textContent = filename;
  document.querySelector("#runtime-label")!.textContent = pythonVariant === "pwntools" ? "Python 3 · pwntools" : "Python 3 · standard library";
  document.querySelector("#dependency-note")!.innerHTML = pythonVariant === "pwntools" ? 'Install first: <code>python3 -m pip install pwntools</code>' : "No Python packages to install.";
  document.querySelector("#run-command")!.textContent = `$ python3 ${filename}`;
  document.querySelector("#download-button")!.innerHTML = `${icon("download")}Download ${filename}`;
  document.querySelector("#python-code")!.textContent = generated || "# Fix the workflow errors above to generate your solver.\n# Your edits stay in this workspace.";
  document.querySelector("#line-count")!.textContent = generated ? `${generated.trimEnd().split("\n").length} lines` : "Needs attention";
  document.querySelector<HTMLButtonElement>("#download-button")!.disabled = !generated || workflowErrors.length > 0;
  document.querySelector<HTMLButtonElement>("#copy-button")!.disabled = !generated || workflowErrors.length > 0;
  if (persist && workflowErrors.length === 0) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(workflow)); }
    catch { persistenceWarning = "Your browser could not save this workflow. Export JSON to keep your work."; renderNotice(); }
  }
  const ready = workflowErrors.length === 0;
  const status = document.querySelector<HTMLElement>("#workflow-status")!;
  status.classList.toggle("has-errors", !ready);
  status.innerHTML = ready ? `<span class="status-dot"></span>${workflow.steps.length} ${workflow.steps.length === 1 ? "step" : "steps"} · Python ready to download` : `${workflowErrors.length} ${workflowErrors.length === 1 ? "setting needs" : "settings need"} attention · Review Python for details`;
  document.querySelector("#python-status")!.classList.toggle("has-errors", !ready);
  const saveStatus = document.querySelector("#save-status")!;
  saveStatus.innerHTML = persistenceWarning ? "Browser storage unavailable" : ready ? '<span class="status-dot"></span>Saved in this browser' : "Invalid edits are not saved";
  renderRail();
  renderPreview();
}
function refresh(): void { fillConnection(); renderRail(); renderEditor(); updateDerived(); }
function download(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function replaceWorkflow(next: Workflow): void {
  workflow = next; selectedId = workflow.steps[0]?.id ?? "";
  initialNotice = ""; renderNotice(); refresh();
}
app.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement)) return;
  if (input.closest("#panel-transcript")) return;
  if (input.id === "python-variant") {
    pythonVariant = input.value === "pwntools" ? "pwntools" : "socket";
    try { localStorage.setItem(VARIANT_KEY, pythonVariant); } catch { /* Selection still works for this session. */ }
    updateDerived(false);
    return;
  }
  const value = input.value;
  const key = input.dataset.workflowField;
  if (key) {
    if (key === "host" || key === "name") workflow[key] = value;
    else if (key === "port" || key === "timeout" || key === "rounds" || key === "maxBuffer") workflow[key] = value.trim() === "" ? NaN : Number(value);
  } else {
    const step = selectedStep();
    if (!step) return;
    const stepKey = input.dataset.stepField;
    if (stepKey === "name" || stepKey === "pattern" || stepKey === "sample") step[stepKey] = value;
    if (stepKey === "receive") step.receive = value as Step["receive"];
    if (stepKey === "onFailure") step.onFailure = value as Step["onFailure"];
    const capture = step.captures.find((item) => item.id === input.dataset.id);
    const captureKey = input.dataset.captureField;
    if (capture && captureKey) {
      if (captureKey === "name" || captureKey === "pattern" || captureKey === "group") capture[captureKey] = value;
      if (captureKey === "kind") capture.kind = value as Capture["kind"];
      if (captureKey === "convert") capture.convert = value as Capture["convert"];
    }
    const check = step.checks.find((item) => item.id === input.dataset.id);
    if (check && input.dataset.checkField === "operator") check.operator = value as Check["operator"];
    if (check && input.dataset.checkField === "value") check.value = value;
    const action = step.actions.find((item) => item.id === input.dataset.id);
    const actionKey = input.dataset.actionField;
    if (action && actionKey) {
      if (actionKey === "value" || actionKey === "condition") action[actionKey] = value;
      if (actionKey === "operator") action.operator = value as Action["operator"];
      if (actionKey === "kind") action.kind = value as Action["kind"];
    }
  }
  updateDerived();
  if (input instanceof HTMLSelectElement && !key) renderEditor();
});
app.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
  if (!target) return;
  const selectId = target.dataset.selectStep;
  if (selectId) { selectedId = selectId; renderRail(); renderEditor(); return; }
  const action = target.dataset.action;
  if (target.id === "add-step" || action === "add-step") { const step = newStep(); workflow.steps.push(step); selectedId = step.id; renderEditor(); updateDerived(); document.querySelector<HTMLInputElement>("#step-name")?.focus(); return; }
  const step = selectedStep();
  if (!step || !action) return;
  const index = workflow.steps.indexOf(step);
  if (action === "next-step") {
    const next = workflow.steps[index + 1];
    if (next) selectedId = next.id;
    else { const added = newStep(); workflow.steps.push(added); selectedId = added.id; }
    renderEditor(); updateDerived();
    document.querySelector<HTMLInputElement>("#step-name")?.focus();
    return;
  }
  if (action === "move-up" && index > 0) { workflow.steps.splice(index, 1); workflow.steps.splice(index - 1, 0, step); }
  if (action === "move-down" && index < workflow.steps.length - 1) { workflow.steps.splice(index, 1); workflow.steps.splice(index + 1, 0, step); }
  if (action === "duplicate") {
    const copy: Step = { ...step, id: uid(), name: `${step.name} (copy)`, captures: step.captures.map((item) => ({ ...item, id: uid() })), checks: step.checks.map((item) => ({ ...item, id: uid() })), actions: step.actions.map((item) => ({ ...item, id: uid() })) };
    workflow.steps.splice(index + 1, 0, copy); selectedId = copy.id;
  }
  if (action === "delete-step") { workflow.steps.splice(index, 1); selectedId = workflow.steps[Math.min(index, workflow.steps.length - 1)]?.id ?? ""; }
  if (action === "add-capture") step.captures.push({ id: uid(), name: `value${step.captures.length + 1}`, kind: "regex", pattern: "(.+)", group: "1", convert: "text" });
  if (action === "remove-capture") step.captures = step.captures.filter((item) => item.id !== target.dataset.id);
  if (action === "add-check") step.checks.push({ id: uid(), operator: "contains", value: "" });
  if (action === "remove-check") step.checks = step.checks.filter((item) => item.id !== target.dataset.id);
  if (action === "add-action") step.actions.push({ id: uid(), kind: "sendline", value: "", operator: "always", condition: "" });
  if (action === "remove-action") step.actions = step.actions.filter((item) => item.id !== target.dataset.id);
  renderEditor(); updateDerived();
});
document.querySelector<HTMLButtonElement>("#download-button")!.addEventListener("click", () => {
  if (workflowErrors.length || !generated) { notify("Fix the workflow errors before downloading."); return; }
  download(generated, outputFilename(), "text/x-python;charset=utf-8"); notify(`${outputFilename()} downloaded. Implement solve(context) if your workflow uses it.`);
});
document.querySelector<HTMLButtonElement>("#copy-button")!.addEventListener("click", async () => {
  if (workflowErrors.length || !generated) return;
  try { await navigator.clipboard.writeText(generated); notify("Python copied to clipboard."); }
  catch {
    const range = document.createRange(); range.selectNodeContents(document.querySelector("#python-code")!);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    document.querySelector<HTMLElement>(".code-view")?.focus(); notify("Clipboard unavailable. Code selected — press Ctrl+C or ⌘C to copy.");
  }
});
document.querySelector<HTMLButtonElement>("#export-button")!.addEventListener("click", () => {
  if (workflowErrors.length) { notify("Fix the workflow errors before exporting JSON."); return; }
  download(`${JSON.stringify(workflow, null, 2)}\n`, "compwnicator.json", "application/json;charset=utf-8"); notify("Workflow exported. Import it here anytime.");
});
const importFile = document.querySelector<HTMLInputElement>("#import-file")!;
document.querySelector("#import-button")!.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("Workflow files must be smaller than 2 MB.");
    const parsed: unknown = JSON.parse(await file.text());
    const errors = validation(parsed);
    if (errors.length) throw new Error(`Import rejected: ${errors.slice(0, 4).join(" · ")}${errors.length > 4 ? ` · and ${errors.length - 4} more issues` : ""}`);
    if (!window.confirm("Replace the current workflow with this imported file? Export JSON first if you want to keep it.")) return;
    replaceWorkflow(parsed as Workflow); setView("workflow"); notify("Workflow imported and validated. Ready to edit.");
  } catch (error) { initialNotice = error instanceof Error ? error.message : "Import failed. Choose a valid Compwnicator JSON workflow."; renderNotice(); notify("Import failed. Your current workflow is unchanged."); }
  finally { importFile.value = ""; }
});
document.querySelector<HTMLButtonElement>("#new-workflow")!.addEventListener("click", () => {
  if (!window.confirm("Start a new workflow? Export JSON first to keep your current work.")) return;
  replaceWorkflow(createWorkflow());
  setView("workflow");
  notify("New workflow ready. Set your challenge connection and edit the first step.");
});
document.querySelector<HTMLSelectElement>("#python-variant")!.value = pythonVariant;
mountTranscript(document.querySelector<HTMLElement>("#panel-transcript")!, {
  getConnection: () => ({ host: workflow.host, port: workflow.port, timeout: workflow.timeout, maxBuffer: workflow.maxBuffer, rounds: workflow.rounds }),
  onBuild: next => { replaceWorkflow(next); setView("workflow", true); },
  notify,
});
fillConnection(); renderRail(); renderEditor(); updateDerived(); renderNotice();
