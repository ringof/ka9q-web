# ka9q-web (W1EUJ fork)

A web interface for [ka9q-radio](https://github.com/ka9q/ka9q-radio),
originally by John Melton G0ORX. This fork adds the W1EUJ overlay UI and
an admin dashboard.

## What's in this repo

| Component | Description |
|---|---|
| `ka9q-web.c` | C web server — serves the radio UI over HTTP/WebSocket |
| `html/` | Frontend: `radio.html`, `radio.js`, spectrum, S-meter, CSS |
| `w1euj.js` | W1EUJ overlay — custom UI injected into `radio.html` |
| `admin/` | Python (Flask) admin dashboard — connection tracking, GeoIP |

---

## Production Install

For a full build-from-source install (ka9q-radio, Onion framework, ka9q-web),
see the [upstream build instructions](#upstream-build-instructions) at the
bottom of this file.

Once ka9q-web is installed and running:

```bash
# Start the radio backend
sudo systemctl start radiod@rx888-web

# Start ka9q-web (production, port 8081)
sudo systemctl start ka9q-web
```

Open `http://<host>:8081` in a browser.

For local development and testing, see [local-dev-test.md](local-dev-test.md).

---

## Developer Setup: Side-by-Side Instances

Run your development build alongside production on a different port. Both
join the same multicast group, so they receive identical streams. Open two
browser tabs and compare old vs new in real time.

| | Production | Development |
|---|---|---|
| Binary | `/usr/local/sbin/ka9q-web` | `./ka9q-web-dev` |
| Port | 8081 | 8082 |
| Resources | `/usr/local/share/ka9q-web/html/` | `./html/` |
| Service | `ka9q-web.service` | `ka9q-web-dev.service` |

### Prerequisites

The dev build links against object files from ka9q-radio. This repo
includes ka9q-radio as a git submodule, so the source is already present
after a recursive clone:

```bash
git clone --recursive https://github.com/ringof/ka9q-web.git
cd ka9q-web
```

If you already have the repo, initialize the submodule:

```bash
git submodule update --init
```

The Makefile defaults to `KA9Q_RADIO_DIR=ka9q-radio/src` (the submodule).
To use a different ka9q-radio source tree (e.g. a local checkout), override
on the command line:

```bash
make ka9q-web-dev KA9Q_RADIO_DIR=/path/to/ka9q-radio/src
```

### Build and run

```bash
make ka9q-web-dev

# Install the dev service (one time)
sudo cp ka9q-web-dev.service /etc/systemd/system/
sudo systemctl daemon-reload

# Start both
sudo systemctl start ka9q-web          # production on :8081
sudo systemctl start ka9q-web-dev      # development on :8082
```

Then open:
- `http://<host>:8081` — production (original code)
- `http://<host>:8082` — development (your changes)

### Rebuild cycle

```bash
make ka9q-web-dev
sudo systemctl restart ka9q-web-dev
```

The dev binary sets `RESOURCES_BASE_DIR=.`, so it reads `html/` from the
working directory. Edit JS/CSS/HTML in place and reload the browser.

### Note on control interaction

Both instances send control commands (tuning, mode) to the same multicast
group. If you tune on the dev instance, production listeners will see the
change too. This is fine for development; just be aware of it during live
comparisons.

---

## Admin Dashboard

A standalone Python service that polls ka9q-web's `/status` page, tracks
connections in SQLite, and performs GeoIP lookups.

### Quick start (developer-local)

```bash
cd admin
python3 -m venv venv
venv/bin/pip install -r requirements.txt
cp admin.conf.example admin.conf
```

Edit `admin.conf` — set `password` and `secret_key`:

```ini
[admin]
password = pick-something
ka9q_url = http://localhost:8082/status
db_path = ./admin.db
secret_key = any-random-string
```

```bash
KA9Q_ADMIN_CONF=admin.conf venv/bin/python admin.py
```

Open `http://localhost:8080`.

### Production install

```bash
# Set up the admin venv in the source tree
cd admin
python3 -m venv venv
venv/bin/pip install -r requirements.txt

# Create DB directory
sudo mkdir -p /var/lib/ka9q-web
sudo chown radio:radio /var/lib/ka9q-web

# Configure
cp admin.conf.example admin.conf
# edit admin.conf — set password and secret_key

# Install and start the service
sudo cp ka9q-admin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ka9q-admin
```

### Admin files

| File | Purpose |
|------|---------|
| `admin/admin.py` | Flask app, status poller, GeoIP, SQLite |
| `admin/admin.html` | Dashboard template (Jinja2) |
| `admin/admin.css` | Dark theme matching the W1EUJ overlay |
| `admin/admin.conf.example` | Default configuration |
| `admin/ka9q-admin.service` | systemd unit |
| `admin/requirements.txt` | Python dependencies |

### Configuration reference

All settings live in the `[admin]` section of `admin.conf`:

| Key | Default | Description |
|-----|---------|-------------|
| `password` | `changeme` | Dashboard login password |
| `ka9q_url` | `http://localhost:8082/status` | ka9q-web status page URL |
| `port` | `8080` | Dashboard listen port |
| `poll_interval` | `5` | Seconds between status polls |
| `db_path` | `/var/lib/ka9q-web/admin.db` | SQLite database path |
| `history_limit` | `500` | Max disconnected sessions kept |
| `secret_key` | `change-this-...` | Flask session signing key |

---

## Open Issues

See [issue.md](issue.md) for tracked issues, currently:
- Real client IP not visible behind Cloudflare Tunnel (fix requires C change)

---

## Custom Modes

ka9q-web supports custom demodulation modes via `presets.conf`
(`/usr/local/share/ka9q-radio/presets.conf`). Five extra mode slots are
available: WUSB, WLSB, USER1, USER2, USER3. Each must have a matching
lowercase tag in `presets.conf`.

Example — WUSB with a wider 3.5 kHz high filter:

```ini
[wusb]
demod = linear
samprate = 12k
low =  +50.0
high = +3.5k
pll = no
square = no
mono = yes
shift = 0
envelope = no
conj = no
hang-time = 1.1
recovery-rate = 20
```

The mode tag in `presets.conf` must be lowercase. Sample rates in ka9q-web
are 24k for FM, 12k for all other modes including I/Q.

---

## Upstream Build Instructions

These are the original G0ORX instructions for building ka9q-web from
source on a fresh system.

### 1. Build and install ka9q-radio

```bash
git clone https://github.com/ka9q/ka9q-radio.git
```

Detailed instructions: https://github.com/ka9q/ka9q-radio/blob/main/docs/INSTALL.md

### 2. Install Onion framework prerequisites

The Onion framework requires GnuTLS and libgcrypto for WebSocket SHA1:

Ubuntu 22.04 / 24.04:
```bash
sudo apt install libgnutls28-dev libgcrypt20-dev
```

Debian 12 (Bookworm):
```bash
sudo apt install libgnutls28-dev libgcrypt-dev
```

RHEL / CentOS / Fedora:
```bash
sudo dnf install gnutls-devel libgcrypt-devel
```

### 3. Build and install the Onion framework

Full build:
```bash
git clone https://github.com/davidmoreno/onion
cd onion && mkdir build && cd build
cmake ..
```

Light build (fewer dependencies):
```bash
cmake -DONION_USE_PAM=false -DONION_USE_PNG=false -DONION_USE_JPEG=false \
      -DONION_USE_XML2=false -DONION_USE_SYSTEMD=false -DONION_USE_SQLITE3=false \
      -DONION_USE_REDIS=false -DONION_USE_GC=false -DONION_USE_TESTS=false \
      -DONION_EXAMPLES=false -DONION_USE_BINDINGS_CPP=false ..
```

Verify that cmake output contains `-- SSL support is compiled in.`, then:

```bash
make
sudo make install
sudo ldconfig
```

### 4. Build and install ka9q-web

```bash
git clone --recursive https://github.com/ringof/ka9q-web.git
cd ka9q-web
make
sudo make install
sudo make install-config
```

The `--recursive` flag pulls in ka9q-radio as a submodule. If you want to
build against a different ka9q-radio source tree, override on the command
line:

```bash
make KA9Q_RADIO_DIR=/path/to/ka9q-radio/src
```

## References

- [Phil Karn KA9Q — ka9q-radio](https://github.com/ka9q/ka9q-radio)
- [John Melton G0ORX — ka9q-radio fork](https://github.com/g0orx/ka9q-radio)
- [Scott Newell — ka9q-web (upstream)](https://github.com/scottnewell/ka9q-web)
- [Onion web framework](https://github.com/davidmoreno/onion)

## Copyright and License

This project is licensed under the
[GNU General Public License v3.0](LICENSE) or later.

- ka9q-radio: (C) Phil Karn, KA9Q
- ka9q-web: (C) 2023-2025 John Melton, G0ORX (N6LYT)
- ka9q-web contributions: (C) 2025 WA2N, WA2ZKD (this fork's upstream)
- W1EUJ overlay and admin dashboard: (C) 2024-2026 W1EUJ
- spectrum.js: (C) 2019 Jeppe Ledet-Pedersen (MIT license)
- colormap.js: (C) 2013-2014 Andras Retzler, HA7ILM (OpenWebRX, GPL v3);
  (C) 2015-2024 John Seamons, ZL4VO/KF6VO
