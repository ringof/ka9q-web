# Local Development & Testing

Step-by-step instructions for building and running ka9q-web in development
mode alongside an existing production instance. The dev build uses the
ka9q-radio submodule included in this repo.

## Prerequisites

- A running ka9q-radio instance (e.g. `radiod@rx888-web`) with a multicast
  status stream
- Build dependencies: `libbsd-dev`, `libonion-dev`
- Python 3 (for the admin dashboard)

```bash
sudo apt install libbsd-dev libonion-dev python3-venv
```

## 1. Clone and build

```bash
git clone --recursive https://github.com/ringof/ka9q-web.git
cd ka9q-web
make ka9q-web-dev
```

The `--recursive` flag pulls in ka9q-radio as a submodule under
`ka9q-radio/`. The Makefile builds the required `.o` files from the
submodule automatically.

### Using a local ka9q-radio checkout instead

If you want to build against a separate ka9q-radio source tree (e.g. one
you're also developing), override `KA9Q_RADIO_DIR`:

```bash
make ka9q-web-dev KA9Q_RADIO_DIR=~/ka9q-radio/src
```

Make sure the ka9q-radio tree is already built (`multicast.o`, `status.o`,
`misc.o`, `decode_status.o`, `rtp.o` must exist in the source directory).

## 2. Set up the admin dashboard

```bash
cd admin
python3 -m venv venv
venv/bin/pip install -r requirements.txt
cp admin.conf.example admin.conf
# edit admin.conf — set password and secret_key
cd ..
```

## 3. Create the database directory

```bash
sudo mkdir -p /var/lib/ka9q-web
sudo chown radio:radio /var/lib/ka9q-web
```

## 4. Smoke-test the build

Before installing systemd services, verify the binary starts correctly by
running it in the foreground.

First, confirm nothing is already listening on port 8082:

```bash
ss -tlnp | grep 8082
```

No output means the port is free. Then run the dev binary directly:

```bash
./ka9q-web-dev -m hf.local -p 8082
```

Open `http://<host>:8082` in a browser. If the page loads, the build is
good. Press **Ctrl-C** to stop the process, then continue to the next step.

> **Tip:** If you see `Address already in use`, another process already holds
> port 8082. Use `ss -tlnp | grep 8082` to identify it.

## 5. Install and start services

```bash
sudo cp ka9q-web-dev.service /etc/systemd/system/
sudo cp admin/ka9q-admin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start ka9q-web-dev
sudo systemctl start ka9q-admin
```

**Note:** The service files contain absolute paths (e.g.
`WorkingDirectory`, `ExecStart`). Edit them if your checkout lives
somewhere other than the path specified in the `.service` files.

## 6. Verify

```bash
systemctl status ka9q-web-dev
systemctl status ka9q-admin
```

Then open in a browser:

| Instance | URL | Port |
|----------|-----|------|
| Production | `http://<host>:8081` | 8081 |
| Development | `http://<host>:8082` | 8082 |
| Admin dashboard | `http://<host>:8080` | 8080 |

## Rebuild cycle

After making changes to C code:

```bash
make ka9q-web-dev
sudo systemctl restart ka9q-web-dev
```

The dev binary sets `RESOURCES_BASE_DIR=.`, so it serves `html/` from the
working directory. For JS/CSS/HTML changes, just reload the browser — no
rebuild needed.

## Notes

- Both production and dev instances join the same multicast group. Tuning
  or mode changes on one instance will affect the other.
- The admin dashboard polls whichever ka9q-web instance is configured in
  `admin.conf` (`ka9q_url`). Point it at the dev instance (`:8082`) during
  development.
