# OSC Position Visualiser

Live 3D view of tracking positions received as OSC. It's built for Naostage but works with any OSC sender.

```
Naostage ──UDP OSC──▶ bridge (Node, :9010) ──WebSocket──▶ browser (three.js, :8080)
```

Browsers can't receive UDP, so a small Node bridge listens for OSC and relays it to the page.
Everything runs locally, including three.js, so the show network needs no internet.

## Start it (no commands)

1. Install **Node.js LTS** from <https://nodejs.org>. You only need to do this once; nothing else is needed.
2. Double-click the launcher:
   - **Mac:** `Start Visualiser.command`
     The first time, macOS may block it. Right-click it, choose **Open**, then **Open** again.
   - **Windows:** `Start Visualiser.bat`
     If SmartScreen appears, click **More info**, then **Run anyway**.
3. The visualiser opens in your browser. Keep the small terminal window open while you use it; close that window to stop.

If you double-click the launcher while the visualiser is already running, it just opens the page again.
Other devices on the network can open the `http://<laptop-ip>:8080` address shown in the window.

### For developers

```bash
npm start            # same as the launcher
npm run sim          # sends 5 fake moving trackers to 127.0.0.1:9010
npm test
```

To change where the simulator sends, run `npm run sim -- <host> <port> <trackers> <rateHz>`. The app has no npm dependencies.

## Network setup (Naostage)

Naostage is at **10.115.20.36**. In Naostage's OSC output, set the destination to the
**IP of the laptop running the bridge**, on port **9010** (`oscPort` in `config.json`).
The launcher window prints the laptop's IPs. Make sure the OS firewall allows inbound UDP on 9010.

## config.json

Changes take effect live, with no restart needed.

| Key | Meaning |
| --- | --- |
| `oscPort` / `httpPort` | UDP listen port / web UI port |
| `stage` | `width`, `depth` and `height` in metres. `origin` is `"downstage-centre"` (y runs from 0 at the downstage edge) or `"centre"` |
| `transform` | Maps incoming axes onto stage axes. `x`, `y` and `z` each take a value such as `"x"`, `"-y"` or `"z"`. Also takes `scale` (for example `0.001` for mm) and `offset` `[x,y,z]` |
| `mappings` | Which OSC addresses carry positions (see below) |
| `names` | Display names, for example `{ "1": "Lead", "2": "Dancer A" }` |
| `trailSeconds` / `staleMs` | Trail length, and how long a tracker can go without data before it greys out |

Stage axes: **x** runs across the stage, **y** is depth (upstage is positive) and **z** is height.

### Mappings

```json
{ "address": "/tracker/{id}/pos", "args": ["x", "y", "z"] }
```

- `{id}` captures that address segment as the tracker id. `*` matches any one segment.
- `args` names each OSC argument in order: `"x"`, `"y"`, `"z"`, `"id"`, or `null` to skip it.
- Per-axis messages (`/tracker/1/x`, `/tracker/1/y` and so on) are merged per tracker.
- If the id is in an argument rather than the address, use `{ "address": "/pos", "args": ["id", "x", "y", "z"] }`.

## On-site checklist

1. Double-click the launcher and click **OSC monitor**.
2. Point Naostage at the laptop on port 9010. **Senders** should show `10.115.20.36`.
3. Addresses shown in red under **Addresses** have no mapping. Add mappings for the position addresses to `config.json`.
4. Walk a performer to known marks (centre, the downstage corners, upstage) and check the axes.
   Fix swaps or flips with `transform`. For example, if Naostage is Y-up, set `"y": "z", "z": "y"`.
5. Set `stage` to the real stage size and add `names` for the performers.

## Layout

- `bridge/server.js`: receives UDP, sends WebSocket messages and serves the UI (`--open` launches the browser)
- `bridge/ws.js`: minimal built-in WebSocket server
- `bridge/osc.js`: OSC codec for messages and bundles, with no dependencies
- `bridge/mapper.js`: maps addresses to tracker positions and applies the axis transform
- `bridge/simulator.js`: sends test OSC
- `public/`: the three.js UI (`scene.js`) and the OSC monitor (`monitor.js`); `vendor/` holds three.js r160
