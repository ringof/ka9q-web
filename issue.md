# Issue: Real Client IP Not Visible Behind Cloudflare Tunnel

## Problem

When ka9q-web runs behind a Cloudflare Tunnel, the `/status` page and admin
dashboard show `127.0.0.1` for every connected client instead of the real IP.
This is because `ka9q-web.c` uses `onion_request_get_client_description(req)`,
which returns the TCP peer address — always the local `cloudflared` daemon.

## Verified

Cloudflare Tunnel **does** forward the real IP in HTTP headers. Confirmed
via `tcpdump` on loopback:

```
CF-Connecting-IP: 68.111.134.73
X-Forwarded-For: 68.111.134.73
X-Real-IP: 68.111.134.73
```

The data is there; the C code just doesn't read it.

## Proposed Fix

In `ka9q-web.c` line 906, check for proxy headers before falling back to
the socket peer address:

```c
// check proxy headers first (Cloudflare Tunnel, nginx, etc.)
const char *real_ip = onion_request_get_header(req, "CF-Connecting-IP");
if (!real_ip)
    real_ip = onion_request_get_header(req, "X-Forwarded-For");
if (!real_ip)
    real_ip = onion_request_get_client_description(req);
strlcpy(sp->client, real_ip, sizeof(sp->client));
```

`onion_request_get_header()` is part of the Onion library's public API
(`onion/request.h`).

## Considerations

- **Header trust**: `X-Forwarded-For` can be spoofed by clients connecting
  directly. In the Cloudflare Tunnel setup this is safe because all traffic
  arrives through `cloudflared` on loopback. If ka9q-web is also exposed
  directly, a config option or compile-time flag to enable/disable header
  trust may be warranted.
- **X-Forwarded-For format**: Can contain a comma-separated chain
  (`client, proxy1, proxy2`). Only the first entry should be used.
- **Scope**: This is a change to the upstream ka9q-web C codebase, not the
  admin dashboard. The admin dashboard will automatically benefit once
  `/status` reports correct IPs.

---

# Development Workflow: Side-by-Side Instances

## Overview

Run the production ka9q-web and a development build simultaneously on
different ports. Both join the same multicast group, so they receive
identical streams. This lets you (or others) open two browser tabs and
compare old vs new in real time.

| | Production | Development |
|---|---|---|
| Binary | `/usr/local/sbin/ka9q-web` | `/home/user/ka9q-web/ka9q-web-dev` |
| Port | 8081 | 8082 |
| Resources | `/usr/local/share/ka9q-web/html/` | `/home/user/ka9q-web/html/` |
| Service | `ka9q-web.service` | `ka9q-web-dev.service` |

## Build

```bash
cd /home/user/ka9q-web
make ka9q-web-dev
```

This produces a debug binary with `RESOURCES_BASE_DIR=.`, so it reads
`html/` from the working directory. Edit JS/CSS/HTML in place; just
reload the browser.

## Run

```bash
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

## Rebuild cycle

```bash
make ka9q-web-dev
sudo systemctl restart ka9q-web-dev
```

## Note on control interaction

Both instances send control commands (tuning, mode) to the same multicast
group. If you tune on the dev instance, production listeners will see the
change too. This is fine for development; just be aware of it during
live comparisons.
