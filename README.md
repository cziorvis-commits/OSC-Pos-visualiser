# OSC Position Visualiser

Live 3D view of tracking positions received as OSC or PSN (PosiStageNet). It's built for Naostage but works with any OSC or PSN sender.

```
Naostage ──UDP OSC (:9111)──────────────┐
         ──PSN multicast (236.10.10.10:56565)─┴▶ bridge (Node) ──WebSocket──▶ browser (three.js, :8181)
```

Browsers can't receive UDP, so a small Node bridge listens for OSC and PSN and relays them to the page.
Everything runs locally, including three.js, so the show network needs no internet.

## Start it (no commands)

1. Install **Node.js LTS** from <https://nodejs.org>. You only need to do this once; nothing else is needed.
2. Double-click the launcher:
   - **Mac:** `Start Visualiser.command`
     The first time, macOS may block it. Right-click it, choose **Open**, then **Open** again.
   - **Windows:** `Start Visualiser.bat`
     If SmartScreen appears, click **More info**, then **Run anyway**.
3. The visualiser opens in your browser. Keep the small terminal window open while you use it; close that window to stop.
   On a Mac with the menu bar app installed (see below), the launcher opens the app instead and closes its terminal window.

If you double-click the launcher while the visualiser is already running, it just opens the page again.
Other devices on the network can open the `http://<laptop-ip>:8181` address shown in the window.

### Mac menu bar app (no terminal)

`npm run app` builds `dist/OSC Visualiser.app` (it needs Xcode or the Command Line Tools). Drag it to Applications.
The app runs the bridge in the background and lives in the menu bar. It still needs Node.js installed.

- The window opens at launch. Close it and the app stays in the menu bar; full screen is ⌃⌘F or the green button.
- The menu bar menu opens with a small top-down plan for a quick check: the floor (downstage edge brighter), every tracker
  as a dot with its name, stale ones grey. Click it for the full view.
- The menu also shows OSC and PSN status (click one to switch it on or off), and has Show Visualiser, Show Full Screen,
  Open in Browser, Copy Link for Other Devices, Show config.json, Show Bridge Log, Restart Bridge, **Open at Login** and Quit.
- The first time it runs, allow **Local Network** access when macOS asks. Without it no OSC or PSN arrives.
- The app keeps its own `config.json` in `~/Library/Application Support/OSC Visualiser/`, starting as a copy of the one it was built with.
  The bridge log is in `~/Library/Logs/OSC Visualiser/bridge.log`.
- Quitting the app stops its bridge. If a bridge from the launcher is already running, the app uses that one instead.
- After changing the code, run `npm run app` again and replace the copy in Applications.

### For developers

```bash
npm start            # same as the launcher
npm run sim          # sends 5 fake moving trackers to 127.0.0.1:9111
npm run sim -- --psn # the same trackers as PSN to 236.10.10.10:56565
npm test
```

To change where the simulator sends, run `npm run sim -- <host> <port> <trackers> <rateHz>` (after `--psn` if used). The app has no npm dependencies.

## Network setup (Naostage)

Naostage is at **10.115.20.36**. In Naostage's OSC output, set the destination to the
**IP of the laptop running the bridge**, on port **9111** (`oscPort` in `config.json`).
The launcher window prints the laptop's IPs. Make sure the OS firewall allows inbound UDP on 9111.

### PSN

The bridge also listens for PSN on multicast **236.10.10.10**, port **56565**. These are Naostage's defaults and need no
destination IP; the laptop just has to be on the same network (the control Wi-Fi).
It joins the group on every network interface and checks again every 5 s, so it's fine if Wi-Fi connects after start-up or drops out.
The window prints `PSN: joined 236.10.10.10 on en0 …` for each interface.
On macOS the first run may ask whether `node` may accept incoming connections: click **Allow**.

Each PSN tracker shows up as the address `/psn/<id>/pos` and gets the id `psn:<id>`, so it never merges with an OSC tracker of the same number.
Its label is the tracker name Naostage sends; `names` in config.json overrides it, for example `{ "psn:1": "Lead" }`.
Positions are used as sent: Kratos sends z as height, which already matches the stage axes. Use `transform` if anything is flipped.

### Table

Click **Table** for the exact live values of every tracker: name and id, input (OSC or PSN), the mapping it matched, the sender's IP,
x, y and z in stage metres to 0.1 mm, its real update rate, and how long since the last update. Stale rows grey out.
**Freeze** holds the values so you can read or copy them; **Clear** forgets trackers that have stopped.

### Choosing OSC, PSN or both

The **OSC** and **PSN** buttons next to the connection status switch each input on or off. The choice is saved to `inputs` in `config.json`.
Each button also shows that input's status (hover for the sender's IP):

| Look | Meaning |
| --- | --- |
| green, `50 Hz` | On and receiving |
| amber, `no data` | On and listening, but nothing has arrived for 2 s |
| red, `error` | Can't listen on that port (hover for the reason) |
| grey dashed, `off` / `off · 240 Hz available` | Switched off. If data is still arriving it shows the rate, so you know it's there to switch to |

At least one input stays on. Both always listen, so switching is instant and needs no restart.

## config.json

Changes take effect live, with no restart needed.

| Key | Meaning |
| --- | --- |
| `oscPort` / `httpPort` | UDP listen port / web UI port |
| `inputs` | Which protocols feed the view: `{ "osc": true, "psn": true }`. Set with the input toggles (see below) |
| `psn` | Multicast `group` and `port` for PSN input. Changes here need a restart |
| `stage` | `width`, `depth` and `height` in metres (default 3.66 × 3.66 LED floor). `origin` is the floor's reference point: `"downstage-centre"` or `"centre"`. `position` `[x,y]` is where that point sits in tracking coordinates and `rotation` is degrees anticlockwise seen from above; set them all with the **Floor** panel (see below) |
| `transform` | Maps incoming axes onto stage axes. `x`, `y` and `z` each take a value such as `"x"`, `"-y"` or `"z"`. Also takes `scale` (for example `0.001` for mm) and `offset` `[x,y,z]` |
| `mappings` | Which OSC addresses carry positions (see below) |
| `names` | Display names, for example `{ "1": "Lead", "psn:2": "Dancer A" }` |
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
- If the message carries no id at all, give the mapping a fixed one: `{ "address": "/pos/xyz", "id": "xyz", "args": ["x", "y", "z"] }`.
  Mappings that share an id (such as `/pos/x`, `/pos/y`, `/pos/z` and `/pos/xy`) merge into one tracker.
- SP Grid sends `/SP/posx`, `/SP/posy` and `/SP/posz` and is Y-up, so its y is mapped to stage z and its z to stage y, merged under the id `sp` (shown as **SP Grid**). Its `/SP/rot*` messages are ignored.

### Floor

The floor moves; tracker positions are always drawn exactly as received. To match the floor to the real one:

1. Click **Floor**. Type the real floor's **Width** and **Depth** if it isn't the default 3.66 × 3.66 m.
2. Stand a tracked performer on a known floor corner or the centre mark, and move the floor until it sits under them.
   Drag the floor, nudge it with the arrow keys (1 cm, Shift for 10 cm), rotate with `[` and `]` (1°, Shift for 15°), or type X, Y and Rotate.
3. Click **Save**. This writes the size, `position` and `rotation` into `config.json`, and every open page updates. **Revert** goes back to the last save.

## On-site checklist

1. Double-click the launcher and click **OSC monitor**.
2. Point Naostage at the laptop on port 9111, or turn on its PSN output. **Senders** should show `10.115.20.36`, and PSN appears as `/psn/<id>/pos`.
3. Addresses shown in red under **Addresses** have no mapping. Add mappings for the position addresses to `config.json`.
4. Walk a performer to known marks (centre, the downstage corners, upstage) and check the axes.
   Fix swaps or flips with `transform`. For example, if Naostage is Y-up, set `"y": "z", "z": "y"`.
5. Set the real floor size and line it up in the **Floor** panel, and add `names` for the performers.

## Layout

- `bridge/server.js`: receives UDP, sends WebSocket messages and serves the UI (`--open` launches the browser)
- `bridge/ws.js`: minimal built-in WebSocket server
- `bridge/osc.js`: OSC codec for messages and bundles, with no dependencies
- `bridge/psn.js`: PosiStageNet codec for tracker positions and names
- `bridge/mapper.js`: maps addresses to tracker positions and applies the axis transform
- `bridge/stage-file.js`: saves the **Floor** panel's size and placement into the `stage` block of `config.json`
- `bridge/simulator.js`: sends test OSC or PSN
- `macos/`: the menu bar app (`main.swift`), its `Info.plist`, icon and `build.sh`
- `public/`: the three.js UI (`scene.js`), the OSC monitor (`monitor.js`) and the Table view (`table.js`); `vendor/` holds three.js r160
