# Setting Up gpsd for Leo Bodnar GPSDO

This guide covers installing and configuring `gpsd` to work with the
Leo Bodnar GPSDO so the system status monitor can report GPS fix status.

## Install gpsd

```bash
sudo apt install gpsd gpsd-clients
```

## Identify the Device

Plug in the Leo Bodnar GPSDO and find the serial device path:

```bash
dmesg | tail -20
# Look for: cdc_acm ... ttyACM0: USB ACM device
ls /dev/ttyACM*
```

The device is typically `/dev/ttyACM0`.

You can confirm it's the GPSDO by checking the USB vendor/product ID:

```bash
lsusb | grep 1dd2
# Should show: 1dd2:2443 Leo Bodnar Electronics Ltd
```

## Configure gpsd

Edit the gpsd defaults file:

```bash
sudo nano /etc/default/gpsd
```

Set these values (adjust the device path if different):

```
START_DAEMON="true"
USBAUTO="false"
DEVICES="/dev/ttyACM0"
GPSD_OPTIONS="-n"
```

The `-n` flag tells gpsd to start reading immediately without waiting
for a client connection.

## Enable and Start

```bash
sudo systemctl enable gpsd
sudo systemctl start gpsd
```

## Verify GPS Data

Use `cgps` for a live display:

```bash
cgps
```

Or `gpsmon` for raw NMEA sentences:

```bash
gpsmon
```

Or check the JSON stream directly:

```bash
gpspipe -w | head -20
```

Look for `"mode":3` (3D fix) or `"mode":2` (2D fix) in the TPV
messages. Mode 0 or 1 means no fix.

## Troubleshooting

**gpsd won't start:**
- Check device path: `ls -l /dev/ttyACM*`
- Check permissions: your user may need to be in the `dialout` group
- Check if another process has the device open: `fuser /dev/ttyACM0`

**No GPS fix:**
- The GPSDO needs a clear view of the sky (or a good antenna)
- A cold start can take several minutes to acquire satellites
- Check `cgps` — the satellite count and signal strength are shown

**gpsd is running but status monitor shows "gpsd down":**
- Verify gpsd is listening: `ss -tlnp | grep 2947`
- Test the connection: `gpspipe -w -n 5`
