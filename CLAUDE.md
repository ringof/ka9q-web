# CLAUDE.md — Working Agreement for Claude Code

## Commit and Push Policy

- **Always ask before committing and pushing.** Never commit or push without explicit user approval.

## Planning Policy

- For tasks that generate multiple needs or planned changes, **write a plan first** and add it to a document (e.g., `PLAN.md` or a specifically named Markdown file) before beginning implementation.
- Get user approval on the plan before proceeding with changes.

## Change Documentation Requirements

Before any approved commit, provide the user — in the chat — with a **copy-pastable block** containing all of the following:

1. **Detailed description of the change** — what was changed and why.
2. **Build/update instructions** — how to build or update after applying the change. If the process is identical to the documented build instructions, state that explicitly. If it differs, provide the exact steps.
3. **Validation test** — a concrete procedure to demonstrate the change works as intended. If a runtime validation test is not feasible, provide a clear rationale explaining why code inspection is sufficient.
4. **Regression test** — a procedure or set of checks demonstrating that other functions of the code remain unaffected by the change.

## Issue Filing Policy

- **Always audit the codebase before filing issues.** Issue descriptions must be derived from actual findings, not speculation about what might be wrong.
- Never assume a problem exists — verify it with concrete evidence (grep, file reads, build output) before writing it up.

## GitHub Issues from Plans

- When a plan contains many changes/tasks, offer to generate a **run-once shell script** that uses the local `gh` CLI to populate each planned task as a GitHub issue in the repository.
- The script should be self-contained, idempotent where practical, and use `gh issue create` with appropriate titles, bodies, and labels derived from the plan document.

---

## Project Overview

**ka9q-web** is a web interface for [ka9q-radio](https://github.com/ka9q/ka9q-radio), a software-defined radio (SDR) receiver stack. Originally by John Melton G0ORX, this fork (W1EUJ) adds a custom overlay UI and a Python admin dashboard.

The system provides a browser-based SDR receiver with spectrum/waterfall display, audio streaming via WebSocket (Opus-encoded), and multicast-based communication with the ka9q-radio backend.

### Repository: `ringof/ka9q-web`

---

## Architecture

```
Browser (radio.html + JS)
    │
    ├── HTTP ──────► ka9q-web (C server, Onion framework)
    │                    │
    └── WebSocket ──►    ├── spectrum data (binary)
                         ├── audio data (Opus/PCM)
                         └── control commands (tuning, mode)
                              │
                              ▼
                         ka9q-radio (radiod)
                         via multicast UDP
```

**Traffic path in production:**
```
User → Cloudflare Tunnel → cloudflared → nginx (:8080) → ka9q-web (:8073)
```

---

## Directory Structure

```
ka9q-web/
├── ka9q-web.c              # C web server (~2100 lines) — the core binary
├── Makefile                 # Build system (GNU Make)
├── html/                   # Frontend assets served by ka9q-web
│   ├── radio.html          # Main radio UI page
│   ├── radio.js            # Core radio logic (WebSocket, controls, audio)
│   ├── spectrum.js          # Spectrum/waterfall display (canvas-based)
│   ├── overlay.js           # W1EUJ overlay UI (custom controls layer)
│   ├── smeter.js            # S-meter display
│   ├── pcm-player.js        # PCM audio playback via Web Audio API
│   ├── colormap.js          # Waterfall color maps
│   ├── opus-decoder.min.js  # Opus audio decoder (WebAssembly)
│   ├── optionsDialog.html   # Options modal
│   ├── status.html          # Status/connections page
│   ├── style.css            # Main stylesheet
│   └── favicon.ico
├── admin/                   # Python (Flask) admin dashboard
│   ├── admin.py             # Flask app — status polling, GeoIP, SQLite
│   ├── admin.html           # Dashboard template (Jinja2)
│   ├── admin.css            # Dark theme CSS
│   ├── admin.conf.example   # Default configuration
│   ├── ka9q-admin.service   # systemd unit
│   └── requirements.txt     # Python deps: flask, requests
├── config/                  # Sample radiod configuration
│   └── radiod@rx888-web.conf
├── ka9q-radio/              # Git submodule — ka9q-radio source
├── ka9q-web.service         # systemd unit (production, port 8081)
├── ka9q-web-dev.service     # systemd unit (development, port 8082)
├── update-w1euj.sh          # Deploy script for overlay.js
├── issue.md                 # Tracked issues
├── local-dev-test.md        # Developer setup guide
├── radiod.commit            # Pinned ka9q-radio commit hash
└── LICENSE                  # GPL v3
```

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Server | C (GNU C11), [Onion web framework](https://github.com/davidmoreno/onion) |
| Frontend | Vanilla JavaScript (no framework), HTML5 Canvas, Web Audio API |
| Audio | Opus codec (WebAssembly decoder), PCM via WebSocket |
| Admin | Python 3, Flask, SQLite, Jinja2 |
| Build | GNU Make |
| Radio backend | ka9q-radio (multicast UDP, linked as .o files) |
| Deployment | systemd services, nginx reverse proxy, Cloudflare Tunnel |

---

## Build Instructions

### Prerequisites

```bash
sudo apt install libbsd-dev libonion-dev python3-venv
```

The ka9q-radio source is included as a git submodule.

### Clone

```bash
git clone --recursive https://github.com/ringof/ka9q-web.git
cd ka9q-web
```

If already cloned without `--recursive`:
```bash
git submodule update --init
```

### Build targets

| Command | Output | Resources from | Use |
|---------|--------|----------------|-----|
| `make` | `ka9q-web` | `/usr/local/share/ka9q-web/html/` | Production |
| `make ka9q-web-dev` | `ka9q-web-dev` | `./html/` (local) | Development |

To use a different ka9q-radio source tree:
```bash
make ka9q-web-dev KA9Q_RADIO_DIR=/path/to/ka9q-radio/src
```

### Install (production)

```bash
sudo make install          # binary + html assets
sudo make install-config   # radio config to /etc/radio
```

### Dev rebuild cycle

```bash
make ka9q-web-dev
sudo systemctl restart ka9q-web-dev
```

For JS/CSS/HTML changes in `html/`, just reload the browser — no rebuild needed.

---

## Running

### Ports

| Instance | Port | Binary |
|----------|------|--------|
| Production | 8081 | `/usr/local/sbin/ka9q-web` |
| Development | 8082 | `./ka9q-web-dev` |
| Admin dashboard | 8080 | `admin/admin.py` |

### Command-line usage

```bash
./ka9q-web-dev -m hf.local -p 8082
```

- `-m`: multicast group name (e.g., `hf.local`)
- `-p`: HTTP listen port

### Smoke test

```bash
ss -tlnp | grep 8082          # ensure port is free
./ka9q-web-dev -m hf.local -p 8082
# Open http://<host>:8082 — verify spectrum/waterfall renders
```

---

## Key Conventions

### Commit messages

- Imperative mood, sentence case: `Add feature`, `Fix bug`, `Remove dead code`
- Short first line (under ~72 characters)
- No conventional-commits prefix (no `feat:`, `fix:`, etc.)
- Examples from history: `Fix overlay frequency display revert and FM mode audio`, `Add low-risk draggable passband edge handles in overlay`

### Branching

- `master` is the default branch
- Feature branches: `claude/<description>-<id>` or `codex/<description>-<id>`
- PRs merge into `master`

### Code style

- **C**: GNU C11 (`-std=gnu11`), `pthread` for concurrency, `strlcpy`/`libbsd` for safe string ops
- **JavaScript**: Vanilla JS, no modules/bundler, no framework. Files are loaded via `<script>` tags in `radio.html`
- **Python**: Flask with Jinja2 templates, `configparser` for config, SQLite for persistence

### Compiler flags

Production: `-DNDEBUG=1 -O3 -march=native -Wall -funsafe-math-optimizations`
Debug/dev: `-g`

---

## Important Notes for AI Assistants

### Binary protocol awareness

The C server (`ka9q-web.c`) communicates with the browser via a custom binary WebSocket protocol. Changes to the binary message format require matching updates in both `ka9q-web.c` and `html/radio.js`. Past issues have been caused by protocol mismatches — always verify both sides when modifying the protocol.

### Multicast side effects

Both production and dev instances join the same multicast group. Tuning or mode changes sent from either instance affect all listeners. This is expected behavior but worth noting during testing.

### ka9q-radio submodule

The `ka9q-radio/` directory is a git submodule pinned to a specific commit (tracked in `radiod.commit`). The Makefile builds `.o` files from the submodule (`multicast.o`, `status.o`, `misc.o`, `decode_status.o`, `rtp.o`) and links them into `ka9q-web`.

### File size awareness

- `ka9q-web.c`: ~2100 lines (the entire server in one file)
- `radio.js`: ~4700 lines (core frontend logic)
- `spectrum.js`: ~3400 lines (spectrum/waterfall rendering)
- `overlay.js`: ~1700 lines (W1EUJ overlay UI)

These are large single-file components. Read relevant sections before making changes.

### No test suite

This project does not have automated tests. Validation is done manually by running the dev instance and verifying behavior in a browser (spectrum rendering, audio playback, tuning, mode switching). The smoke test in `local-dev-test.md` is the closest thing to a test procedure.

### Secrets and sensitive files

Never commit these files:
- `admin/admin.conf` (contains passwords and secret keys)
- `admin/*.db` (SQLite databases)
- `private/` directory
- `.env` files

These are already in `.gitignore`.
