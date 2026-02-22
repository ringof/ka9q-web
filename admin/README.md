# KA9Q-WEB Admin Dashboard — Developer Setup

A standalone status dashboard that reads the ka9q-web `/status` page.
No changes to ka9q-web are required.

## Prerequisites

- Python 3.8+
- A running ka9q-web instance (local or remote)

## Quick Start

```bash
# Pull just the admin directory
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/ringof/ka9q-web.git ka9q-admin
cd ka9q-admin
git sparse-checkout set admin
cd admin

# Install dependencies
pip install flask requests

# Copy and edit the config
cp admin.conf.example admin.conf
```

Edit `admin.conf` — at minimum set these three values:

```ini
[admin]
password = pick-something
ka9q_url = http://localhost:8081/status
db_path = ./admin.db
secret_key = any-random-string
```

Set `ka9q_url` to wherever your ka9q-web `/status` page is reachable.

```bash
# Run it
KA9Q_ADMIN_CONF=admin.conf python admin.py
```

Open `http://localhost:8082` in a browser.

## What It Does

- Polls `/status` every 5 seconds (read-only HTTP GET)
- Tracks connections and disconnections in a local SQLite file
- Looks up client IPs via free GeoIP APIs
- Serves a password-protected dashboard on port 8082

## Files

| File | Purpose |
|------|---------|
| `admin.py` | Flask app, status poller, GeoIP, SQLite |
| `admin.html` | Dashboard template (Jinja2) |
| `admin.css` | Dark theme matching the W1EUJ overlay |
| `admin.conf.example` | Default configuration |
| `ka9q-admin.service` | systemd unit (production install only) |
| `requirements.txt` | Python dependencies |

## Configuration Reference

All settings live in the `[admin]` section of `admin.conf`:

| Key | Default | Description |
|-----|---------|-------------|
| `password` | `changeme` | Dashboard login password |
| `ka9q_url` | `http://localhost:8081/status` | ka9q-web status page URL |
| `port` | `8082` | Dashboard listen port |
| `poll_interval` | `5` | Seconds between status polls |
| `db_path` | `/var/lib/ka9q-web/admin.db` | SQLite database path |
| `history_limit` | `500` | Max disconnected sessions kept |
| `secret_key` | `change-this-...` | Flask session signing key |
