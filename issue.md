# Open Issues

## Real Client IP Not Visible Behind Cloudflare Tunnel

### Problem

When ka9q-web runs behind a Cloudflare Tunnel, the `/status` page and admin
dashboard show `127.0.0.1` for every connected client instead of the real IP.
This is because `ka9q-web.c` uses `onion_request_get_client_description(req)`,
which returns the TCP peer address — always the local `cloudflared` daemon.

### Verified

Cloudflare Tunnel **does** forward the real IP in HTTP headers. Confirmed
via `tcpdump` on loopback:

```
CF-Connecting-IP: 68.111.134.73
X-Forwarded-For: 68.111.134.73
X-Real-IP: 68.111.134.73
```

The data is there; the C code just doesn't read it.

### Proposed Fix

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

### Considerations

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
