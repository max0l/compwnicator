# Compwnicator

A lightweight, local-first visual builder for Python solvers for TCP/netcat CTF challenges. TypeScript + Vite, with Deno for development/builds and GitHub Pages for hosting. No backend, Docker, nginx, account, or runtime JavaScript dependencies.

## Run locally

Install [Deno 2](https://deno.com/), then:

```sh
deno install --allow-scripts=npm:esbuild
deno task dev
```

Open the URL printed by Vite (normally `http://localhost:5173`).

```sh
deno task build       # type-check and generate dist/
deno task preview     # serve the production build locally
python3 -m pip install -r tests/requirements.txt
deno task test        # both Python variants against loopback TCP servers
```

## Deploy on GitHub Pages

Push to `main` or `master`, then select **Settings → Pages → Build and deployment → GitHub Actions** in the repository. The workflow in `.github/workflows/` runs the loopback tests, builds `dist/`, and deploys the static site. Vite uses relative asset paths so the site works at a repository URL such as `https://USER.github.io/REPO/`. You can also serve `dist/` from another static host.

## Build a solver

The interface opens in dark mode. Use the theme button in the header to switch themes; your choice is remembered in this browser.

Use **Workflow builder** to edit steps, **Paste a conversation** to mark a transcript, and **Generated Python** to copy or download the script. In the builder, receive and reply settings are shown first. Expand **Capture values** or **Validate the response** when you need them. Timeout and buffer limits are under **Advanced settings** in the connection card.

1. Set the host, port, timeout, round count, and buffer limit. Define the receive and send steps in your conversation.
2. For each exchange, choose a **receive boundary**. A literal prompt handles servers that never send a newline. A line, regex, exact byte count, or EOF can frame other responses. Choose no receive for send-first protocols.
3. Paste representative server output into the sample field. Add multiple captures for values appearing in one response; use separate exchanges for sequential responses. Preview captures and checks locally.
4. Add checks to reject unexpected responses. A failed check either stops the solver or skips this exchange's captures/actions. Negative checks only make sense after a complete frame: absence of text is not a network delimiter.
5. Add ordered response actions, optionally conditional on the current response. Send a line, send raw UTF-8 text, send hex-encoded bytes, invoke your solving hook and send its result as a line, log, or stop.
6. Open **Generated Python**, select **Standard library · sockets** or **pwntools**, then copy or download the script. If using a solving hook, implement `solve(context)` in that file before running it.

### Python variants

The default socket variant downloads as `solver.py` and needs only the Python standard library. The optional pwntools variant downloads as `solver_pwntools.py` and uses [`remote()`](https://docs.pwntools.com/en/stable/tubes/sockets.html) for TCP connections. Both variants share the buffered receive logic, timeouts, buffer limits, captures, checks, actions, and `solve(context)` hook. The selected library is remembered in this browser; exported workflow JSON can generate either variant.

To run the pwntools script:

```sh
python3 -m pip install pwntools
python3 solver_pwntools.py --host 127.0.0.1 --port 1337
```

The adapter distinguishes a pwntools receive timeout (empty bytes) from connection closure (`EOFError`) so an incomplete frame fails consistently. See the [pwntools tube documentation](https://docs.pwntools.com/en/stable/tubes.html).

### Mark a pasted conversation

Open **Paste a conversation**, paste the terminal conversation, and select each span you typed. Mark it as **Send**, then review whether **Append Enter (LF)** is enabled. You can also select server values and mark them as captures. Build the workflow and edit its receive boundaries, parsers, and sends in the workflow editor.

For multiline input, select the complete payload, including a literal terminator such as `EOF\n` if your challenge requires it. Selected text is preserved, and a literal EOF line is sent as text.

```sh
python3 solver.py --host 127.0.0.1 --port 1337
python3 solver.py --help
```

Use only against challenges and services you are authorized to interact with. The website itself never opens a TCP connection to a challenge. Python runs on your machine and connects directly. The default socket variant requires no pip packages; the pwntools variant requires pwntools.

## Parsing and conditions

Capture sources: first regex match (numeric or named group), all regex matches, delimiter split/index, JSON dotted path, or the whole response. Conversions: text, integer, float, hex bytes, base64 bytes, and JSON. Regex-all captures produce lists. Captures are available to subsequent exchanges in the same round; each round starts with a fresh context.

Checks and conditional actions support: always, contains, does not contain, equals, does not equal, starts with, ends with, regex match, regex non-match, empty, and non-empty. Conditions operate on the entire current decoded frame, not on an individual capture.

Response templates use Python format syntax: `{capture_name}`, `{round}`, and `{response}`. Escape literal braces as `{{` and `}}`. Do not put Python expressions in templates. Missing captures and invalid conversions are errors, not silent empty strings. Binary values are intended for the solving hook; text interpolation of a bytes value uses Python's representation, not its raw bytes.

The offline preview runs JavaScript regular expressions. The solver runs Python `re`; flags, named groups, escapes, Unicode matching, and some advanced constructs differ. Keep patterns simple and verify advanced Python patterns in Python. Preview is not a network emulator. Server samples are examples only and are never sent to the challenge.

### Custom solving logic

`solve(context)` is separate from network I/O and parsing. It receives the named captures plus `round` (one-based) and `response` (the latest frame). It may return text, an integer, or bytes; its result is sent with a newline. This is where cipher-solving, arithmetic, or challenge-specific logic belongs. The default hook deliberately raises an explicit error instead of guessing an answer.

For example, with integer captures named `left` and `right`:

```python
def solve(context: dict[str, object]) -> int:
    return context["left"] + context["right"]
```

The generated template implements a fixed sequence repeated for the configured number of rounds, not arbitrary loops or a branching graph. Use conditional actions/checks or customize the generated Python when a challenge needs more complex control flow. Add an explicit final EOF exchange to collect a flag sent after the last response; no implicit drain waits indefinitely after the sequence.

## Network behavior and limits

The generated socket client preserves unread bytes between exchanges. Prompts can arrive fragmented, and multiple frames can arrive in one TCP packet. Reads are bounded by a monotonic timeout and configured buffer limit; EOF before an expected boundary is an error. Text is UTF-8. Exact byte framing counts bytes, not characters. Regular expressions should match a stable terminator rather than an unfinished prefix: a stream cannot tell whether a match will grow later.

The site stores your workflow in browser local storage, with JSON import/export for portability. Do not store secrets on a shared browser profile. Imported workflows are validated, but regexes remain user-authored computation: avoid catastrophic-backtracking patterns and untrusted huge samples. Exported files contain your workflow's configured values. Nothing is uploaded.

## Source layout

- `src/model.ts` — workflow types and initial step.
- `src/main.ts`, `src/style.css` — interactive editor and responsive UI.
- `src/transcript.ts`, `src/transcript-ui.ts` — transcript conversion and annotation UI.
- `src/generator.ts` — validation, offline preview, and Python generation.
- `tests/generator_test.ts` — generated Python exercised against real loopback TCP servers.
- `.github/workflows/pages.yml` — GitHub Pages build, test, and deployment.
