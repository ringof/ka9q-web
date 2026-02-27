# Plan: Independent System Status Page

## Goal

Create a standalone service that monitors the health of the entire SDR stack
and presents a single status page showing what's working, what's broken, and
what needs attention. This runs independently of ka9q-web so it works even
when the radio server itself is down.

---

## Checks to Implement

| # | Check | Method | OK state | Problem states |
|---|-------|--------|----------|----------------|
| 1 | Leo Bodnar GPSDO present | USB VID:PID `1dd2:2443` via `/sys/bus/usb/devices` | Device found | Device missing |
| 2 | GPSDO GPS fix | Query gpsd on `localhost:2947` (JSON protocol) | 2D or 3D fix (mode 2/3) | No fix (mode 0/1), gpsd not running |
| 3 | RX888 present | USB VID `04b4`, PID `00f1` or `00f3` | PID `00f1` (operating) | PID `00f3` (DFU/stuck), absent |
| 4 | ka9q-radio service | `systemctl is-active radiod@rx888-web` | active (running) | inactive, failed, activating (restart loop) |
| 5 | hf.local multicast resolvable | `avahi-resolve -n hf.local` to check mDNS name resolution | Resolves to multicast address | Name not found, avahi unavailable |
| 6 | Connected users | HTTP fetch ka9q-web `/status`, count sessions (gated: only if ka9q-web reachable) | Count returned | ka9q-web unreachable → show "N/A" |

---

## Architecture

```
Browser ──► system-status service (:8084)
                │
                ├── reads /sys/bus/usb/devices/  (USB checks)
                ├── connects to gpsd :2947       (GPS fix)
                ├── runs systemctl               (service check)
                ├── runs avahi-resolve              (mDNS name resolution)
                └── fetches ka9q-web :8082/status (connected users, gated)
```

- **Standalone Python service** using Flask (same stack as admin dashboard)
- **No authentication** — this is a health/status page, not admin
- **Polls every 10 seconds** in a background thread, caches results
- **Auto-refreshing HTML page** with a dark theme matching the SDR UI
- **JSON API endpoint** (`/api/status`) for programmatic access
- **Port 8084** (avoids conflicts with 8080 admin, 8081 prod, 8082 dev)

---

## Files to Create

```
status/
├── system_status.py        # Flask app — background poller, status checks, routes
├── system_status.html      # Jinja2 template — dark-themed status dashboard
├── system_status.css       # Stylesheet (dark theme, status indicators)
├── system_status.conf.example  # Default configuration
├── ka9q-system-status.service  # systemd unit
├── requirements.txt        # Python deps: flask, requests
└── setup-gpsd.md           # gpsd installation and configuration guide
```

---

## Implementation Steps

### Step 1: gpsd Setup Guide (`status/setup-gpsd.md`)

Write documentation for setting up gpsd with the Leo Bodnar GPSDO:
- Install gpsd (`sudo apt install gpsd gpsd-clients`)
- Identify the device path (`dmesg` / `ls /dev/ttyACM*`)
- Configure `/etc/default/gpsd` with the device path
- Enable and start the gpsd service
- Verify with `cgps` or `gpsmon`
- Verify fix status with `gpspipe -w`

### Step 2: Configuration (`status/system_status.conf.example`)

```ini
[status]
port = 8084
poll_interval = 10

# ka9q-web status endpoint
ka9q_url = http://localhost:8082/status

# systemd service name for ka9q-radio
radiod_service = radiod@rx888-web

# USB device identifiers
gpsdo_vid = 1dd2
gpsdo_pid = 2443
rx888_vid = 04b4
rx888_pid_operating = 00f1
rx888_pid_dfu = 00f3

# gpsd connection
gpsd_host = 127.0.0.1
gpsd_port = 2947
```

### Step 3: Status Checker (`status/system_status.py`)

Main Flask application with:

1. **USB device check** — scan `/sys/bus/usb/devices/*/idVendor` and
   `idProduct` files (no external deps, no subprocess). Return
   `present`/`absent` and for RX888 distinguish `operating`/`dfu`/`absent`.

2. **gpsd check** — open a TCP socket to `localhost:2947`, send
   `?WATCH={"enable":true}`, read one TPV sentence, parse mode field.
   Use a short timeout (2s). Return `3d_fix`, `2d_fix`, `no_fix`,
   `gpsd_down`. No external Python library needed — just `socket` + `json`.

3. **systemd check** — `subprocess.run(['systemctl', 'is-active', service])`
   plus `subprocess.run(['systemctl', 'show', '-p', 'NRestarts', service])`
   to detect restart loops. Return `running`, `failed`, `restarting`,
   `inactive`.

4. **hf.local multicast check** — run `avahi-resolve -n hf.local` to
   verify the multicast group name resolves via mDNS. This confirms that
   radiod has registered the name and the multicast group is advertised.
   Return `resolvable`/`not_found`/`avahi_unavailable`.

5. **ka9q-web + connected users check** — gated on ka9q-web being
   reachable. HTTP GET to `/status` endpoint, parse the HTML for session
   count. If ka9q-web is unreachable (check #4 in systemd shows radiod
   down, or connection refused), skip this check and show "N/A — ka9q-web
   not running". Only attempt the HTTP fetch if we have reason to believe
   ka9q-web is up.

5. **Background poller thread** — runs all checks on a configurable
   interval, stores results in a thread-safe dict. The web handler reads
   from this cache (never blocks on checks).

6. **Routes:**
   - `GET /` — renders `system_status.html` with current status
   - `GET /api/status` — returns JSON status blob

### Step 4: HTML Template (`status/system_status.html`)

Dark-themed status dashboard:
- Title: "SDR System Status"
- One card/row per check with:
  - Component name
  - Status indicator (green circle = OK, red = error, yellow = warning)
  - Detail text (e.g., "3D fix, 8 satellites" or "Device in DFU mode")
  - Last checked timestamp
- Overall summary banner: "All systems operational" / "N issues detected"
- Auto-refresh every 10 seconds via meta tag or JavaScript fetch
- Connected users count displayed prominently
- Mobile-responsive layout

### Step 5: Stylesheet (`status/system_status.css`)

Dark theme matching the existing SDR UI and admin dashboard:
- Dark background (`#1a1a2e` or similar)
- Green/yellow/red status indicators
- Monospace font for technical values
- Responsive grid layout for status cards

### Step 6: systemd Service (`status/ka9q-system-status.service`)

```ini
[Unit]
Description=KA9Q SDR System Status Monitor
After=network-online.target

[Service]
Type=simple
User=radio
Group=radio
ExecStart=/path/to/status/venv/bin/python system_status.py
WorkingDirectory=/path/to/status
Environment=KA9Q_STATUS_CONF=system_status.conf
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## Dependencies

Only standard Python + Flask + requests (same as admin dashboard):
- `flask`
- `requests`

All system checks use stdlib only:
- USB: read `/sys/bus/usb/devices/` (os.listdir + open)
- gpsd: `socket` + `json` (stdlib)
- systemd: `subprocess` (stdlib)
- mDNS: `subprocess` calling `avahi-resolve` (requires `avahi-utils` package)

---

## Status Response Format (JSON API)

```json
{
  "timestamp": "2026-02-27T15:30:00Z",
  "overall": "degraded",
  "checks": {
    "gpsdo_present": {
      "status": "ok",
      "detail": "Leo Bodnar GPSDO found on USB bus 1"
    },
    "gps_fix": {
      "status": "ok",
      "detail": "3D fix"
    },
    "rx888": {
      "status": "error",
      "detail": "Device in DFU mode (PID 00f3) — firmware not loaded"
    },
    "radiod": {
      "status": "ok",
      "detail": "radiod@rx888-web active, 0 restarts"
    },
    "hf_local": {
      "status": "ok",
      "detail": "hf.local resolves via mDNS"
    },
    "ka9q_web": {
      "status": "ok",
      "detail": "ka9q-web reachable, 3 connected users"
    }
  }
}
```

`overall` is `operational` if all checks pass, `degraded` if any are
`warning`, `down` if any are `error`.

---

## What This Plan Does NOT Include

- **No modifications to ka9q-web.c** — this is a standalone service
- **No modifications to admin.py** — separate concern
- **No gpsd installation** — the plan includes a setup guide, but gpsd
  must be installed by the user since it involves hardware-specific
  device paths
- **No direct multicast listener** — `hf.local` availability is checked
  via `avahi-resolve` (mDNS name resolution), which is lightweight and
  doesn't require joining multicast groups or parsing packet streams
- **Gated checks** — connected user count (from ka9q-web `/status`) is
  only attempted when ka9q-web is confirmed reachable; shows "N/A" otherwise

---

## Deployment

```bash
cd status
python3 -m venv venv
venv/bin/pip install -r requirements.txt
cp system_status.conf.example system_status.conf
# edit system_status.conf if needed

# Test locally
KA9Q_STATUS_CONF=system_status.conf venv/bin/python system_status.py
# Open http://localhost:8084

# Install service
sudo cp ka9q-system-status.service /etc/systemd/system/
# Edit service file paths to match your installation
sudo systemctl daemon-reload
sudo systemctl enable --now ka9q-system-status
```
