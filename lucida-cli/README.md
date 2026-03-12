# lucida-cli

CLI client for `lucida-server`. Connects over WebSocket, inspects state, and controls the viewport.

## Install

```
cargo install --path .
```

## Usage

```
lucida-cli [--server <url>] [--peer <id>] [--steer <id>] <command>
```

By default connects to `ws://localhost:9876`. Use `--server` to override.

Use `--peer <id>` to start from a specific peer's viewport instead of defaults.

Use `--steer <id>` to make a browser client follow the CLI before sending a viewport command. This is the common way to remote-control a browser from the CLI.

## Commands

### Inspect

```sh
# Print document state and connected peers
lucida-cli state

# Print the chunk plan for the current viewport
lucida-cli visible-chunks
```

### Viewport

```sh
# Pan the viewport
lucida-cli pan --dx 100 --dy 50

# Zoom by a factor (2.0 = zoom in 2x, works in both 2D and 3D)
lucida-cli zoom --factor 2.0

# Set absolute zoom level (2D only)
lucida-cli set-zoom --value 4.0

# Set camera center
lucida-cli center --x 500 --y 300

# Set z/t/c slice
lucida-cli slice --axis z --index 42
lucida-cli slice --axis t --index 5
lucida-cli slice --axis c --index 1

# Set contrast window
lucida-cli contrast --min 100 --max 5000

# Set gamma
lucida-cli gamma --gamma 0.8

# Rotate 3D camera (degrees by default)
lucida-cli rotate --theta 45 --phi 30

# Or use radians
lucida-cli rotate --theta 0.5 --phi 0.3 --radians

# Switch to 2D/3D mode
lucida-cli set-mode-2d
lucida-cli set-mode-3d
```

### Remote control

Use `--steer` to take control of a browser client's viewport:

```sh
# Make browser (peer 1) follow the CLI, then pan
lucida-cli --steer 1 pan --dx 200

# Switch browser to 3D mode
lucida-cli --steer 1 set-mode-3d

# Standalone steer (just make the browser follow, no viewport change)
lucida-cli steer --client 1
```

The `--steer` flag sends a `Steer` message that makes the target client follow the CLI's peer. When the CLI then sends a presence update and disconnects, the browser imports the viewport state and stops following automatically.

### Example workflow

Open a dataset in the browser, then control it from the terminal:

```sh
# 1. Find the browser's peer ID
lucida-cli state | jq '.peers[] | {client_id, layers: (.layer_order | length)}'
# → the peer with layers > 0 is the browser (e.g. peer 0)

# 2. Switch the browser to 3D mode
lucida-cli --steer 0 --peer 0 set-mode-3d

# 3. Zoom out (works in both 2D and 3D)
lucida-cli --steer 0 --peer 0 zoom --factor 0.5

# 4. Adjust contrast
lucida-cli --steer 0 --peer 0 contrast --min 64 --max 191

# 5. Switch back to 2D and navigate to a specific slice
lucida-cli --steer 0 --peer 0 set-mode-2d
lucida-cli --steer 0 --peer 0 slice --axis z --index 170
```

Each command connects, steers the browser to follow the CLI, sends the viewport update, and disconnects. The `--peer 0` flag reads the browser's current viewport so changes are applied relative to its state.
