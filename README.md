# Compwnicator

A browser-based builder for Python scripts that communicate with TCP CTF challenges.

[Open the builder](https://compwnicator.max0l.dev)

## Usage

1. Set the challenge host and port.
2. Add receive/send steps, or paste a terminal conversation and mark the inputs you typed.
3. Add captures for values your script needs. Use `{name}` in replies or `solve(context)` for custom logic.
4. Open **Generated Python**, choose **sockets** or **pwntools**, and download the script. Implement `solve(context)` if your workflow uses it.

```sh
python3 solver.py --host localhost --port 1337
```

The socket variant requires only Python 3.9+. For the pwntools variant:

```sh
python3 -m pip install pwntools
python3 solver_pwntools.py --host localhost --port 1337
```

Workflows are saved in your browser and can be imported/exported as JSON. The downloaded script connects to the challenge from your machine.

## Development

Requires [Deno 2](https://deno.com/).

```sh
deno install --allow-scripts=npm:esbuild
deno task dev
```

Build with `deno task build`; output is written to `dist/`. Preview with `deno task preview`.

Tests run both generated variants against local TCP servers and require Python with pwntools:

```sh
python3 -m pip install -r tests/requirements.txt
deno task test
```
