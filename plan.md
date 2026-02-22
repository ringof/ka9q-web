# ka9q-web Admin Service — Implementation Plan

## Overview

A standalone Python (Flask) service that polls the existing ka9q-web `/status`
endpoint, tracks connection history in SQLite, performs server-side IP
geolocation, and serves a password-protected admin dashboard styled to match
the W1EUJ overlay dark theme.

## File Structure

Six files, all under `admin/`:

```
admin/
  admin.py             — Flask app, background poller, HTML scraper, GeoIP, SQLite (single module)
  admin.html           — Jinja2 template: login form + dashboard (current users + history)
  admin.css            — Styling extracted from w1euj.js color palette
  admin.conf.example   — Example configuration file
  ka9q-admin.service   — systemd unit file
  requirements.txt     — flask, requests
```

## Components (all in admin.py, ~300 lines)

### Configuration

Read from `/etc/ka9q-web/admin.conf` (INI format, Python `configparser`):

```ini
[admin]
password = changeme
ka9q_url = http://localhost:8081/status
port = 8082
poll_interval = 5
db_path = /var/lib/ka9q-web/admin.db
history_limit = 500
```

### SQLite Schema

Two tables, created on startup:

```sql
CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_ip TEXT NOT NULL,
    ssrc INTEGER NOT NULL,
    frequency INTEGER,
    mode TEXT,
    audio_active INTEGER DEFAULT 0,
    first_seen TEXT NOT NULL,         -- ISO 8601 UTC
    last_seen TEXT NOT NULL,
    disconnected_at TEXT,             -- NULL while connected
    geo_city TEXT,
    geo_country TEXT
);

CREATE TABLE IF NOT EXISTS geo_cache (
    ip TEXT PRIMARY KEY,
    city TEXT,
    country TEXT,
    looked_up_at TEXT NOT NULL
);
```

### Status Poller

A daemon thread that runs every `poll_interval` seconds:

1. GET `http://localhost:8081/status`, parse the HTML table
2. For each session, key on `(client_ip, ssrc)`
3. If key exists with `disconnected_at IS NULL` — update `last_seen`, frequency, audio
4. If key is new — insert row, trigger GeoIP lookup
5. Any active rows NOT in the latest poll — set `disconnected_at = now`

The HTML table columns (from ka9q-web.c lines 789-809):
client, ssrc, frequency range, frequency, center frequency, bins, bin width, audio

Edge cases:
- `client` field may be `IP:port`, bare IP, or hostname — split on last `:` carefully (IPv6)
- When `nsessions == 0`, the page has no table rows
- Mode (`requested_preset`) is in the session struct but NOT exposed by `/status` — show "—" until a future `/status.json` endpoint is added

### GeoIP Lookup

Following the KiwiSDR pattern — rotate through three free APIs with a 5-second
timeout, cache results in SQLite:

1. `https://ipapi.co/{ip}/json/` (~1000 req/day free)
2. `https://get.geojs.io/v1/ip/geo/{ip}.json`
3. `http://ip-api.com/json/{ip}?fields=city,country,countryCode` (45 req/min free)

Skip private IPs (10.x, 192.168.x, 172.16-31.x, 127.x) — label as "LAN".

Cache is in `geo_cache` table so lookups persist across restarts. Each unique
IP is looked up only once.

### Flask App

Three routes:

- `GET /` — if not authenticated, show login form; otherwise show dashboard
- `POST /login` — check password against config, set session cookie
- `GET /api/current` — JSON of current connections (for JS auto-refresh)

Authentication: single shared password from config file, stored in Flask
session cookie. No username needed. Matches KiwiSDR's admin auth model.

### Dashboard (admin.html)

Single Jinja2 template with two states:

**Not authenticated:** simple password form (styled dark).

**Authenticated:** two sections:

```
+--------------------------------------------------+
|  KA9Q-WEB ADMIN                [Logout]     UTC  |
+--------------------------------------------------+
|  CURRENT USERS (3)                                |
|  IP         | Location      | Freq    | Duration |
|  1.2.3.4    | Portland, US  | 14.074  | 1:23:45  |
|  ...                                              |
+--------------------------------------------------+
|  CONNECTION HISTORY                               |
|  IP         | Location      | Freq    | Connected|
|  5.6.7.8    | London, GB    | 7.255   | 45m      |
|  ...                                              |
+--------------------------------------------------+
```

Auto-refreshes the "Current Users" table every 5 seconds via `fetch('/api/current')`
— no full page reload. History section loads on page load only.

Frequency displayed as MHz with 3 decimal places (gold, monospace).
Green dot for active audio, gray for inactive.

### Styling (admin.css)

Exact values from w1euj.js inline CSS:

| Token           | Value     | Source            |
|-----------------|-----------|-------------------|
| Background      | `#000`    | w1euj.js line 74  |
| Panel bg        | `#575757` | line 105          |
| Card bg         | `#3a3a3a` | line 178          |
| Button bg       | `#373737` | line 136          |
| Text primary    | `#fff`    | line 74           |
| Text secondary  | `#ccc`    | line 133          |
| Freq gold       | `#e8c000` | line 127          |
| Active green    | `#44cc44` | line 354          |
| Link blue       | `#6af`    | line 180          |
| Font main       | DejaVu Sans, Verdana | line 73 |
| Font mono       | Consolas, monospace  | line 127 |
| Font size       | 13px      | line 74           |
| Border radius   | 6px       | line 136          |

### systemd Service (ka9q-admin.service)

```ini
[Unit]
Description=KA9Q Web SDR Admin Dashboard
After=network-online.target
Wants=ka9q-web.service

[Service]
Type=simple
User=radio
Group=radio
ExecStart=/opt/ka9q-admin/venv/bin/python admin.py
WorkingDirectory=/opt/ka9q-admin
Environment=KA9Q_ADMIN_CONF=/etc/ka9q-web/admin.conf
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Runs as `radio:radio` (same as ka9q-web). SQLite database at
`/var/lib/ka9q-web/admin.db`.

## Installation

```bash
# Install files
sudo mkdir -p /opt/ka9q-admin /etc/ka9q-web /var/lib/ka9q-web
sudo cp admin/admin.py admin/admin.html admin/admin.css /opt/ka9q-admin/
sudo python3 -m venv /opt/ka9q-admin/venv
sudo /opt/ka9q-admin/venv/bin/pip install flask requests

# Configure
sudo cp admin/admin.conf.example /etc/ka9q-web/admin.conf
sudo vi /etc/ka9q-web/admin.conf   # set password

# Enable service
sudo cp admin/ka9q-admin.service /etc/systemd/system/
sudo chown -R radio:radio /opt/ka9q-admin /var/lib/ka9q-web
sudo systemctl daemon-reload
sudo systemctl enable --now ka9q-admin
```

## Build Order

1. SQLite init + connection tracking functions
2. HTML scraper for `/status`
3. GeoIP with rotation + SQLite cache
4. Flask app: auth, routes, poller thread
5. Template + CSS
6. systemd service file + example config
7. Test end-to-end

## Thread Safety

SQLite connections are not thread-safe. The poller thread and Flask request
handlers each create their own short-lived connections. The database is
small and low-traffic, so this is fine without connection pooling.

## Future Enhancement

Add a `/status.json` endpoint to ka9q-web.c (~30 lines) to return structured
JSON including `requested_preset` (mode). The scraper can try JSON first,
fall back to HTML:

```python
def fetch_sessions():
    try:
        return requests.get(url.replace("/status", "/status.json")).json()["sessions"]
    except Exception:
        return parse_status_html(requests.get(url).text)
```
