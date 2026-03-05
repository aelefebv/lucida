# Dev
## When you change Rust code (lucida-core/):

1. cargo test -p lucida-core — run from lucida-core/ dir (no workspace Cargo.toml at root)
1. cd lucida-web && npm run build:wasm — rebuild the wasm package

## When you change TypeScript code (lucida-web/):

Vite hot-reloads automatically if npm run dev is running, so nothing extra needed.

## In short, if you touch Rust, the sequence is:

```bash
cd lucida-core && cargo test
cd ../lucida-web && npm run build:wasm
cd ..
```

Then refresh the browser (or restart npm run dev if the wasm dependency isn't picked up).