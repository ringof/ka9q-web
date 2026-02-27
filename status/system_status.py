#!/usr/bin/env python3
#
# KA9Q SDR System Status Monitor
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
"""KA9Q SDR System Status Monitor.

Standalone Flask service that monitors the health of the entire SDR stack:
USB devices (GPSDO, RX888), GPS fix via gpsd, radiod service state,
hf.local multicast resolution via avahi-resolve, and connected users
(gated on ka9q-web reachability).
"""

import configparser
import json
import logging
import os
import re
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from html.parser import HTMLParser

# Configure logging early so startup errors are visible in journalctl
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("system_status")

try:
    import requests
except ImportError:
    log.error("Missing dependency: requests (pip install requests)")
    sys.exit(1)

try:
    from flask import Flask, jsonify, render_template
except ImportError:
    log.error("Missing dependency: flask (pip install flask)")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_CONF = {
    "port": "8084",
    "poll_interval": "5",
    "ka9q_url": "http://localhost:8082/status",
    "radiod_service": "radiod@rx888-web",
    "gpsdo_vid": "1dd2",
    "gpsdo_pid": "2443",
    "rx888_vid": "04b4",
    "rx888_pid_operating": "00f1",
    "rx888_pid_dfu": "00f3",
    "gpsd_host": "127.0.0.1",
    "gpsd_port": "2947",
    "mcast_name": "hf.local",
}

config = configparser.ConfigParser()
config.read_dict({"status": DEFAULT_CONF})
conf_path = os.environ.get("KA9Q_STATUS_CONF", "/etc/ka9q-web/system_status.conf")
config.read(conf_path)

cfg = config["status"]

# ---------------------------------------------------------------------------
# Flask application
# ---------------------------------------------------------------------------

app = Flask(
    __name__,
    template_folder=os.path.dirname(os.path.abspath(__file__)),
    static_folder=os.path.dirname(os.path.abspath(__file__)),
    static_url_path="/static",
)

# ---------------------------------------------------------------------------
# Shared state — written by poller thread, read by request handlers
# ---------------------------------------------------------------------------

_status_lock = threading.Lock()
_status_cache = {
    "timestamp": None,
    "overall": "unknown",
    "checks": {},
}


def _set_status(checks):
    """Update the cached status atomically."""
    statuses = [c["status"] for c in checks.values()]
    if any(s == "error" for s in statuses):
        overall = "down"
    elif any(s == "warning" for s in statuses):
        overall = "degraded"
    else:
        overall = "operational"

    now = datetime.now(timezone.utc).isoformat()
    with _status_lock:
        _status_cache["timestamp"] = now
        _status_cache["overall"] = overall
        _status_cache["checks"] = dict(checks)


def _get_status():
    """Return a snapshot of the cached status."""
    with _status_lock:
        return {
            "timestamp": _status_cache["timestamp"],
            "overall": _status_cache["overall"],
            "checks": dict(_status_cache["checks"]),
        }


# ---------------------------------------------------------------------------
# Check 1: GPSDO USB presence
# ---------------------------------------------------------------------------

USB_SYS_PATH = "/sys/bus/usb/devices"


def _read_usb_attr(device_path, attr):
    """Read a sysfs USB attribute, return stripped string or None."""
    path = os.path.join(device_path, attr)
    try:
        with open(path) as f:
            return f.read().strip()
    except (OSError, IOError):
        return None


def check_gpsdo_usb():
    """Check if Leo Bodnar GPSDO is present on USB."""
    target_vid = cfg.get("gpsdo_vid")
    target_pid = cfg.get("gpsdo_pid")

    try:
        for entry in os.listdir(USB_SYS_PATH):
            dev_path = os.path.join(USB_SYS_PATH, entry)
            vid = _read_usb_attr(dev_path, "idVendor")
            pid = _read_usb_attr(dev_path, "idProduct")
            if vid == target_vid and pid == target_pid:
                bus = _read_usb_attr(dev_path, "busnum") or "?"
                return {
                    "status": "ok",
                    "detail": f"Leo Bodnar GPSDO found (bus {bus})",
                }
    except OSError:
        pass

    return {"status": "error", "detail": "Leo Bodnar GPSDO not found on USB"}


# ---------------------------------------------------------------------------
# Check 2: GPS fix via gpsd
# ---------------------------------------------------------------------------


def check_gps_fix():
    """Query gpsd for GPS fix status with detailed position/sat info."""
    host = cfg.get("gpsd_host")
    port = cfg.getint("gpsd_port")

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(3)
        sock.connect((host, port))

        # gpsd sends a VERSION line on connect; read and discard it
        sock.recv(1024)

        # Request a data report
        sock.sendall(b'?WATCH={"enable":true,"json":true}\n')

        # Collect TPV and SKY sentences
        tpv = None
        sky = None
        buf = b""
        for _ in range(15):
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
            for line in buf.split(b"\n"):
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if msg.get("class") == "TPV" and tpv is None:
                    tpv = msg
                elif msg.get("class") == "SKY" and sky is None:
                    sky = msg
            if tpv and sky:
                break

        sock.close()

        if tpv is None:
            return {"status": "warning", "detail": "gpsd responding, no TPV data yet"}

        mode = tpv.get("mode", 0)

        # Build detail parts
        parts = []
        if mode >= 3:
            parts.append("3D fix")
        elif mode == 2:
            parts.append("2D fix")
        else:
            parts.append("No fix (acquiring)")

        lat = tpv.get("lat")
        lon = tpv.get("lon")
        if lat is not None and lon is not None:
            parts.append(f"{lat:.5f}, {lon:.5f}")

        gps_time = tpv.get("time")
        if gps_time:
            # Shorten ISO timestamp to HH:MM:SS
            parts.append(f"time {gps_time[11:19]}Z" if len(gps_time) >= 19 else f"time {gps_time}")

        if sky:
            # nSat = total visible, uSat = used in fix
            n_used = sky.get("uSat", sky.get("nSat"))
            if n_used is not None:
                parts.append(f"{n_used} sats")

        detail = " | ".join(parts)

        if mode >= 3:
            return {"status": "ok", "detail": detail}
        elif mode == 2:
            return {"status": "warning", "detail": detail}
        else:
            return {"status": "warning", "detail": detail}

    except socket.timeout:
        return {"status": "error", "detail": "gpsd connection timed out"}
    except ConnectionRefusedError:
        return {"status": "error", "detail": "gpsd not running (connection refused)"}
    except OSError as e:
        return {"status": "error", "detail": f"gpsd error: {e}"}


# ---------------------------------------------------------------------------
# Check 3: RX888 USB presence
# ---------------------------------------------------------------------------


def check_rx888_usb():
    """Check if RX888 is present on USB by matching both VID and PID."""
    target_vid = cfg.get("rx888_vid")
    pid_operating = cfg.get("rx888_pid_operating")
    pid_dfu = cfg.get("rx888_pid_dfu")

    try:
        for entry in os.listdir(USB_SYS_PATH):
            dev_path = os.path.join(USB_SYS_PATH, entry)
            vid = _read_usb_attr(dev_path, "idVendor")
            pid = _read_usb_attr(dev_path, "idProduct")
            if vid != target_vid:
                continue
            # Only match known RX888 PIDs; skip other Cypress/Infineon devices
            bus = _read_usb_attr(dev_path, "busnum") or "?"
            if pid == pid_operating:
                return {
                    "status": "ok",
                    "detail": f"RX888 operating (bus {bus})",
                }
            elif pid == pid_dfu:
                return {
                    "status": "error",
                    "detail": f"RX888 in DFU mode (bus {bus}) — firmware not loaded",
                }
    except OSError:
        pass

    return {"status": "error", "detail": "RX888 not found on USB"}


# ---------------------------------------------------------------------------
# Check 4: radiod systemd service
# ---------------------------------------------------------------------------


def check_radiod_service():
    """Check radiod systemd service status."""
    service = cfg.get("radiod_service")

    try:
        result = subprocess.run(
            ["systemctl", "is-active", service],
            capture_output=True, text=True, timeout=5,
        )
        state = result.stdout.strip()

        # Get restart count
        result2 = subprocess.run(
            ["systemctl", "show", "-p", "NRestarts", service],
            capture_output=True, text=True, timeout=5,
        )
        restarts_line = result2.stdout.strip()
        match = re.search(r"NRestarts=(\d+)", restarts_line)
        restarts = int(match.group(1)) if match else 0

        if state == "active":
            detail = f"{service} active"
            if restarts > 0:
                detail += f", {restarts} restart(s)"
                return {"status": "warning", "detail": detail}
            return {"status": "ok", "detail": detail}
        elif state == "activating":
            return {
                "status": "error",
                "detail": f"{service} activating (restart loop?), {restarts} restart(s)",
            }
        elif state == "failed":
            return {
                "status": "error",
                "detail": f"{service} failed, {restarts} restart(s)",
            }
        else:
            return {
                "status": "error",
                "detail": f"{service} {state}",
            }

    except FileNotFoundError:
        return {"status": "error", "detail": "systemctl not found"}
    except subprocess.TimeoutExpired:
        return {"status": "error", "detail": "systemctl timed out"}
    except OSError as e:
        return {"status": "error", "detail": f"systemctl error: {e}"}


# ---------------------------------------------------------------------------
# Check 5: hf.local mDNS resolution
# ---------------------------------------------------------------------------


def check_mcast_mdns():
    """Check if the multicast group name resolves via mDNS."""
    mcast_name = cfg.get("mcast_name")

    try:
        result = subprocess.run(
            ["avahi-resolve", "-n", mcast_name],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            addr = result.stdout.strip().split()[-1] if result.stdout.strip() else ""
            return {
                "status": "ok",
                "detail": f"{mcast_name} resolves ({addr})",
            }
        else:
            stderr = result.stderr.strip()
            return {
                "status": "error",
                "detail": f"{mcast_name} not found via mDNS"
                          + (f": {stderr}" if stderr else ""),
            }
    except FileNotFoundError:
        return {
            "status": "error",
            "detail": "avahi-resolve not found (install avahi-utils)",
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "detail": "avahi-resolve timed out"}
    except OSError as e:
        return {"status": "error", "detail": f"avahi-resolve error: {e}"}


# ---------------------------------------------------------------------------
# Check 6: ka9q-web reachability + connected users (gated)
# ---------------------------------------------------------------------------


class _SessionCountParser(HTMLParser):
    """Minimal parser to extract session count from ka9q-web /status."""

    def __init__(self):
        super().__init__()
        self._in_b = False
        self._text = ""
        self.session_count = None
        self.row_count = 0

    def handle_starttag(self, tag, attrs):
        if tag == "b":
            self._in_b = True
            self._text = ""
        elif tag == "tr":
            self.row_count += 1

    def handle_endtag(self, tag):
        if tag == "b":
            self._in_b = False
            m = re.search(r"Sessions:\s*(\d+)", self._text)
            if m:
                self.session_count = int(m.group(1))

    def handle_data(self, data):
        if self._in_b:
            self._text += data


def check_ka9q_web():
    """Check ka9q-web reachability and count connected users.

    This check is gated: if the HTTP request fails, we report ka9q-web
    as unreachable rather than treating it as a hard error on user count.
    """
    url = cfg.get("ka9q_url")

    try:
        resp = requests.get(url, timeout=5)
        if resp.status_code != 200:
            return {
                "status": "warning",
                "detail": f"ka9q-web returned HTTP {resp.status_code}",
            }

        parser = _SessionCountParser()
        parser.feed(resp.text)

        if parser.session_count is not None:
            n = parser.session_count
            users = "user" if n == 1 else "users"
            return {
                "status": "ok",
                "detail": f"ka9q-web reachable, {n} connected {users}",
            }
        else:
            return {
                "status": "ok",
                "detail": "ka9q-web reachable, session count unknown",
            }

    except requests.ConnectionError:
        return {
            "status": "error",
            "detail": "ka9q-web not reachable (connection refused)",
        }
    except requests.Timeout:
        return {
            "status": "error",
            "detail": "ka9q-web not reachable (timed out)",
        }
    except requests.RequestException as e:
        return {
            "status": "error",
            "detail": f"ka9q-web error: {e}",
        }


# ---------------------------------------------------------------------------
# Background poller
# ---------------------------------------------------------------------------


def _run_all_checks():
    """Run all status checks and update the cache."""
    checks = {}
    checks["gpsdo_present"] = check_gpsdo_usb()
    checks["gps_fix"] = check_gps_fix()
    checks["rx888"] = check_rx888_usb()
    checks["radiod"] = check_radiod_service()
    checks["hf_local"] = check_mcast_mdns()

    # Gate ka9q-web check: only attempt if radiod is not in error state
    radiod_status = checks["radiod"]["status"]
    if radiod_status == "error":
        checks["ka9q_web"] = {
            "status": "warning",
            "detail": "N/A — radiod not running",
        }
    else:
        checks["ka9q_web"] = check_ka9q_web()

    _set_status(checks)


def poller():
    """Background thread: run checks on a configurable interval."""
    interval = cfg.getint("poll_interval")
    while True:
        try:
            _run_all_checks()
        except Exception:
            log.exception("Poller error")
        time.sleep(interval)


# ---------------------------------------------------------------------------
# Flask routes
# ---------------------------------------------------------------------------

# Human-readable names for each check, in display order
CHECK_LABELS = [
    ("gpsdo_present", "Leo Bodnar GPSDO"),
    ("gps_fix", "GPS Fix"),
    ("rx888", "RX888 Receiver"),
    ("radiod", "radiod Service"),
    ("hf_local", "hf.local Multicast"),
    ("ka9q_web", "ka9q-web / Users"),
]


@app.route("/")
def index():
    status = _get_status()
    return render_template(
        "system_status.html",
        status=status,
        check_labels=CHECK_LABELS,
    )


@app.route("/api/status")
def api_status():
    return jsonify(_get_status())


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    log.info("Starting system status monitor")
    log.info("Config file: %s", conf_path)
    log.info("Listening on port %s, poll interval %ss", cfg.get("port"), cfg.get("poll_interval"))

    # Run checks once synchronously so the first page load has data
    try:
        _run_all_checks()
        log.info("Initial checks complete, overall: %s", _get_status()["overall"])
    except Exception:
        log.exception("Initial checks failed (will retry in poller)")

    t = threading.Thread(target=poller, daemon=True)
    t.start()

    port = cfg.getint("port")
    log.info("Starting Flask on 0.0.0.0:%d", port)
    app.run(host="0.0.0.0", port=port, debug=False)


if __name__ == "__main__":
    main()
