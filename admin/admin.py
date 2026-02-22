#!/usr/bin/env python3
#
# KA9Q Web SDR Admin Dashboard
#
# Copyright (C) 2025-2026 W1EUJ
#
# Part of ka9q-web, a web interface for ka9q-radio.
# Based on ka9q-web by John Melton, G0ORX (N6LYT).
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
"""KA9Q Web SDR Admin Dashboard.

Standalone Flask service that polls the ka9q-web /status endpoint,
tracks connections in SQLite, performs IP geolocation, and serves a
password-protected admin dashboard.
"""

import configparser
import ipaddress
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from html.parser import HTMLParser

import requests
from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_CONF = {
    "password": "changeme",
    "ka9q_url": "http://localhost:8081/status",
    "port": "8082",
    "poll_interval": "5",
    "db_path": "/var/lib/ka9q-web/admin.db",
    "history_limit": "500",
    "secret_key": "change-this-to-something-random",
}

config = configparser.ConfigParser()
config.read_dict({"admin": DEFAULT_CONF})
conf_path = os.environ.get("KA9Q_ADMIN_CONF", "/etc/ka9q-web/admin.conf")
config.read(conf_path)

cfg = config["admin"]

# ---------------------------------------------------------------------------
# Flask application
# ---------------------------------------------------------------------------

app = Flask(
    __name__,
    template_folder=os.path.dirname(os.path.abspath(__file__)),
    static_folder=os.path.dirname(os.path.abspath(__file__)),
    static_url_path="/static",
)
app.secret_key = cfg.get("secret_key")

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

DB_PATH = cfg.get("db_path")
HISTORY_LIMIT = cfg.getint("history_limit")


def get_db():
    """Return a new SQLite connection (one per thread / request)."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    """Create tables if they don't exist."""
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_ip TEXT NOT NULL,
            ssrc INTEGER NOT NULL,
            freq_range TEXT,
            frequency INTEGER,
            center_frequency INTEGER,
            bins INTEGER,
            bin_width INTEGER,
            audio_active INTEGER DEFAULT 0,
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL,
            disconnected_at TEXT,
            geo_city TEXT,
            geo_country TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_conn_active
            ON connections(client_ip, ssrc, disconnected_at);

        CREATE TABLE IF NOT EXISTS geo_cache (
            ip TEXT PRIMARY KEY,
            city TEXT,
            country TEXT,
            looked_up_at TEXT NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# HTML status page parser
# ---------------------------------------------------------------------------


class StatusTableParser(HTMLParser):
    """Parse the ka9q-web /status HTML table into a list of dicts."""

    def __init__(self):
        super().__init__()
        self._in_td = False
        self._in_th = False
        self._row = []
        self._rows = []
        self._headers = []
        self._current_data = ""

    def handle_starttag(self, tag, attrs):
        if tag == "td":
            self._in_td = True
            self._current_data = ""
        elif tag == "th":
            self._in_th = True
            self._current_data = ""
        elif tag == "tr":
            self._row = []

    def handle_endtag(self, tag):
        if tag == "td":
            self._in_td = False
            self._row.append(self._current_data.strip())
        elif tag == "th":
            self._in_th = False
            self._headers.append(self._current_data.strip())
        elif tag == "tr" and self._row:
            self._rows.append(list(self._row))

    def handle_data(self, data):
        if self._in_td or self._in_th:
            self._current_data += data

    def get_sessions(self):
        """Return parsed sessions as a list of dicts."""
        results = []
        for row in self._rows:
            if len(row) < 8:
                continue
            results.append(
                {
                    "client": row[0],
                    "ssrc": int(row[1]) if row[1].lstrip("-").isdigit() else 0,
                    "freq_range": row[2],
                    "frequency": int(row[3]) if row[3].lstrip("-").isdigit() else 0,
                    "center_frequency": (
                        int(row[4]) if row[4].lstrip("-").isdigit() else 0
                    ),
                    "bins": int(row[5]) if row[5].isdigit() else 0,
                    "bin_width": int(row[6]) if row[6].isdigit() else 0,
                    "audio": row[7],
                }
            )
        return results


def parse_status_html(html):
    """Parse ka9q-web /status HTML and return session list."""
    parser = StatusTableParser()
    parser.feed(html)
    return parser.get_sessions()


def extract_ip(client_str):
    """Extract the IP address from the client field.

    The client field may be 'IP:port', '[IPv6]:port', bare IP, or a hostname.
    """
    client_str = client_str.strip()
    # IPv6 in brackets: [::1]:12345
    m = re.match(r"^\[([^\]]+)\](?::\d+)?$", client_str)
    if m:
        return m.group(1)
    # If it contains a colon, could be IPv6 or IP:port
    if ":" in client_str:
        # Try as plain IPv6 first
        try:
            ipaddress.ip_address(client_str)
            return client_str
        except ValueError:
            pass
        # IP:port — split on last colon
        host, _, port = client_str.rpartition(":")
        if port.isdigit():
            return host
    return client_str


# ---------------------------------------------------------------------------
# GeoIP lookup
# ---------------------------------------------------------------------------

_PRIVATE_NETS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]

GEO_APIS = [
    {
        "url": "https://ipapi.co/{ip}/json/",
        "city": "city",
        "country": "country_code",
    },
    {
        "url": "https://get.geojs.io/v1/ip/geo/{ip}.json",
        "city": "city",
        "country": "country_code",
    },
    {
        "url": "http://ip-api.com/json/{ip}?fields=city,country,countryCode",
        "city": "city",
        "country": "countryCode",
    },
]


def _is_private(ip_str):
    try:
        addr = ipaddress.ip_address(ip_str)
        return any(addr in net for net in _PRIVATE_NETS)
    except ValueError:
        return False


def lookup_geo(ip_str):
    """Look up city/country for an IP. Returns (city, country) or (None, None).

    Checks SQLite cache first, tries three free APIs on miss.
    """
    if _is_private(ip_str):
        return "LAN", "LAN"

    conn = get_db()
    row = conn.execute(
        "SELECT city, country FROM geo_cache WHERE ip = ?", (ip_str,)
    ).fetchone()
    if row:
        conn.close()
        return row["city"], row["country"]

    city, country = None, None
    for api in GEO_APIS:
        try:
            resp = requests.get(api["url"].format(ip=ip_str), timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                city = data.get(api["city"]) or None
                country = data.get(api["country"]) or None
                if city or country:
                    break
        except Exception:
            continue

    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT OR REPLACE INTO geo_cache (ip, city, country, looked_up_at) "
        "VALUES (?, ?, ?, ?)",
        (ip_str, city, country, now),
    )
    conn.commit()
    conn.close()
    return city, country


# ---------------------------------------------------------------------------
# Status poller (background thread)
# ---------------------------------------------------------------------------

KA9Q_URL = cfg.get("ka9q_url")
POLL_INTERVAL = cfg.getint("poll_interval")


def poll_status():
    """Periodically fetch /status and update the database."""
    while True:
        try:
            resp = requests.get(KA9Q_URL, timeout=10)
            if resp.status_code != 200:
                time.sleep(POLL_INTERVAL)
                continue

            current_sessions = parse_status_html(resp.text)
            now = datetime.now(timezone.utc).isoformat()

            conn = get_db()

            # Build set of currently-seen keys
            seen_keys = set()
            for s in current_sessions:
                ip = extract_ip(s["client"])
                ssrc = s["ssrc"]
                key = (ip, ssrc)
                seen_keys.add(key)

                # Check for existing active connection
                row = conn.execute(
                    "SELECT id FROM connections "
                    "WHERE client_ip = ? AND ssrc = ? AND disconnected_at IS NULL",
                    (ip, ssrc),
                ).fetchone()

                audio = 1 if s["audio"] == "Enabled" else 0

                if row:
                    conn.execute(
                        "UPDATE connections SET last_seen = ?, frequency = ?, "
                        "center_frequency = ?, freq_range = ?, bins = ?, "
                        "bin_width = ?, audio_active = ? WHERE id = ?",
                        (
                            now,
                            s["frequency"],
                            s["center_frequency"],
                            s["freq_range"],
                            s["bins"],
                            s["bin_width"],
                            audio,
                            row["id"],
                        ),
                    )
                else:
                    city, country = lookup_geo(ip)
                    conn.execute(
                        "INSERT INTO connections "
                        "(client_ip, ssrc, freq_range, frequency, "
                        "center_frequency, bins, bin_width, audio_active, "
                        "first_seen, last_seen, geo_city, geo_country) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            ip,
                            ssrc,
                            s["freq_range"],
                            s["frequency"],
                            s["center_frequency"],
                            s["bins"],
                            s["bin_width"],
                            audio,
                            now,
                            now,
                            city,
                            country,
                        ),
                    )

            # Mark disconnected sessions
            active_rows = conn.execute(
                "SELECT id, client_ip, ssrc FROM connections "
                "WHERE disconnected_at IS NULL"
            ).fetchall()
            for row in active_rows:
                if (row["client_ip"], row["ssrc"]) not in seen_keys:
                    conn.execute(
                        "UPDATE connections SET disconnected_at = ? WHERE id = ?",
                        (now, row["id"]),
                    )

            conn.commit()
            conn.close()

            # Prune old history
            prune_history()

        except Exception as e:
            app.logger.warning("Poller error: %s", e)

        time.sleep(POLL_INTERVAL)


def prune_history():
    """Keep only the most recent HISTORY_LIMIT disconnected rows."""
    conn = get_db()
    conn.execute(
        "DELETE FROM connections WHERE disconnected_at IS NOT NULL "
        "AND id NOT IN ("
        "  SELECT id FROM connections WHERE disconnected_at IS NOT NULL "
        "  ORDER BY disconnected_at DESC LIMIT ?"
        ")",
        (HISTORY_LIMIT,),
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Flask routes
# ---------------------------------------------------------------------------


@app.route("/")
def index():
    if not session.get("authenticated"):
        return render_template("admin.html", authenticated=False)

    conn = get_db()
    current = conn.execute(
        "SELECT * FROM connections WHERE disconnected_at IS NULL "
        "ORDER BY first_seen DESC"
    ).fetchall()
    history = conn.execute(
        "SELECT * FROM connections WHERE disconnected_at IS NOT NULL "
        "ORDER BY disconnected_at DESC LIMIT ?",
        (HISTORY_LIMIT,),
    ).fetchall()
    conn.close()

    return render_template(
        "admin.html",
        authenticated=True,
        current=current,
        history=history,
        now_utc=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
    )


@app.route("/login", methods=["POST"])
def login():
    password = request.form.get("password", "")
    if password == cfg.get("password"):
        session["authenticated"] = True
    return redirect(url_for("index"))


@app.route("/logout")
def logout():
    session.pop("authenticated", None)
    return redirect(url_for("index"))


@app.route("/api/current")
def api_current():
    if not session.get("authenticated"):
        return jsonify({"error": "unauthorized"}), 401

    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM connections WHERE disconnected_at IS NULL "
        "ORDER BY first_seen DESC"
    ).fetchall()
    conn.close()

    result = []
    now = datetime.now(timezone.utc)
    for r in rows:
        first = datetime.fromisoformat(r["first_seen"])
        duration = now - first
        hours, remainder = divmod(int(duration.total_seconds()), 3600)
        minutes, seconds = divmod(remainder, 60)

        result.append(
            {
                "client_ip": r["client_ip"],
                "ssrc": r["ssrc"],
                "frequency": r["frequency"],
                "freq_range": r["freq_range"],
                "center_frequency": r["center_frequency"],
                "bins": r["bins"],
                "bin_width": r["bin_width"],
                "audio_active": bool(r["audio_active"]),
                "geo_city": r["geo_city"],
                "geo_country": r["geo_country"],
                "first_seen": r["first_seen"],
                "duration": f"{hours}:{minutes:02d}:{seconds:02d}",
            }
        )
    return jsonify(result)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    init_db()

    poller = threading.Thread(target=poll_status, daemon=True)
    poller.start()

    port = cfg.getint("port")
    app.run(host="0.0.0.0", port=port, debug=False)


if __name__ == "__main__":
    main()
