# Status Page Improvements Plan

## Changes

### 1. GPS-FIX: Show detailed GPS info
**File:** `status/system_status.py` — `check_gps_fix()`

Extract from the TPV sentence: latitude (`lat`), longitude (`lon`), time (`time`), and from SKY sentence: number of satellites used (`nSat`/`uSat`). Display these in the detail string as proof of GPS quality.

Approach: After getting the TPV, also look for a SKY sentence for sat count. Include lat/lon/time/sats in the detail text.

### 2. RX888: Match both VID and PID
**File:** `status/system_status.py` — `check_rx888_usb()`

Currently the code matches on VID `04b4` first, then checks PIDs. The problem is other Cypress/Infineon devices share that VID, causing false matches. Fix: only match when BOTH VID and PID match a known RX888 PID (`00f1` operating or `00f3` DFU). Skip devices that match VID but have an unknown PID (don't report them as warnings).

### 3. RADIOD: 'activating' = RED
**File:** `status/system_status.py` — `check_radiod_service()`

Change the `activating` state from `"warning"` to `"error"`. This indicates a restart loop which is effectively down.

### 4. ka9q-web not reachable = RED
**File:** `status/system_status.py` — `check_ka9q_web()`

Change ConnectionError, Timeout, and RequestException from `"warning"` to `"error"`. If ka9q-web is unreachable, it's a hard failure.

### 5. Update every 5 seconds
**Files:** `status/system_status.py` (default config), `status/system_status.html` (JS interval + footer text)

- Change `poll_interval` default from `"10"` to `"5"`
- Change JS `setInterval` from `10000` to `5000`
- Update footer text from `10s` to `5s`
