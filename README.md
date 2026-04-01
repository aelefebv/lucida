# Dev
Check the GLOSSARY.md for terminology.

## Quick start
### Terminal 1:
``` bash
(cd lucida-core && cargo test)
cargo run -p lucida-server
```

### Terminal 2:
``` bash
(cd lucida-web && npm run build:wasm)
(cd lucida-web && npm run dev)
```

## Specifics

### When you change Rust code (lucida-core/):

1. `cargo test -p lucida-core`
1. `cd lucida-web && npm run build:wasm` — rebuild the wasm package

### When you change TypeScript code (lucida-web/):

Vite hot-reloads automatically if `npm run dev` is running, so nothing extra needed.

### When you change Python code (lucida-py/):

```bash
cd lucida-py && maturin develop
```

## In short, if you touch Rust, the sequence is:

```bash
cargo test -p lucida-core
cd lucida-web && npm run build:wasm
cd ..
```

Then refresh the browser (or restart `npm run dev` if the wasm dependency isn't picked up).

## Running the full stack (multi-user)

Three processes need to be running:

```bash
# Terminal 1: relay server
cargo run -p lucida-server

# Terminal 2: web dev server
cd lucida-web && npm run dev

# Terminal 3 (optional): Python
cd lucida-py && maturin develop
python -c "from lucida import Viewer; v = Viewer(); v.start(); v.pan(200, 0)"
```

To test multi-user sync:
1. Start the relay server and web dev server.
2. Open the dataset in two browser tabs.
3. Pan in one tab — the other tab should follow.
4. From Python: `v.pan(200, 0)` — both browser tabs should update.