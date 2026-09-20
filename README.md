# Pulse System Monitor

Lightweight desktop system monitor for tracking CPU, memory, storage, network activity, processes, and system health in real time.

## Overview

When a computer slows down, most tools tell you *that* something is wrong — 89% memory used — without telling you *what*. Pulse answers the second question.

It reads live metrics from the machine every two seconds, groups running processes by application, and runs a small rules engine over the result to produce plain-language findings like "Memory usage is high. Microsoft Edge is the largest consumer at 2.1 GB."

Every number in the interface is read from the operating system. There is no sample data, no simulation, and no network service behind it.

## Features

- **CPU** — live utilization with a rolling sparkline, core count, and a short-window average that smooths out momentary spikes.
- **Memory** — used and free bytes with a usage sparkline, based on *active* memory rather than the near-100% figure that includes filesystem cache.
- **Storage** — capacity and free space for the volume that actually fills up (see [Architecture](#architecture)).
- **Network** — round-trip latency, the active interface, connection state, and live throughput.
- **Processes** — top applications by CPU or memory, grouped by application bundle so a browser's 28 helper processes read as one row, not 28, and a helper is credited to the app that ships it rather than to its own name.
- **Diagnostics** — the rules engine that turns those readings into findings, sorted problems-first, each one naming the process responsible where there is one.
- **Trends** — a rolling 30-minute window lets the engine reason about direction, not just position: memory climbing steadily, a single app that only ever grows, load that has persisted rather than spiked.
- **Event log** — every stretch of time a resource spent unhealthy is recorded, so a spike that happened while you were away is still there when you come back.

## Screenshots

**Dashboard**

![Pulse dashboard showing CPU, memory, storage and network cards above a grouped process list](docs/screenshot-dashboard.png)

**Diagnostics**

![System diagnostics panel listing storage and memory warnings above healthy CPU and network checks](docs/screenshot-diagnostics.png)

## Technology

| Layer | Choice |
| --- | --- |
| Shell | Electron 44 |
| Runtime | Node.js |
| Interface | HTML, CSS, vanilla JavaScript — no framework, no build step |
| System data | [`systeminformation`](https://github.com/sebhildebrandt/systeminformation) |

Two runtime dependencies, no database, no accounts, no cloud services.

## Installation

Requires Node.js 18 or newer.

```bash
git clone https://github.com/Oluwa2006/pulse-system-monitor.git
cd pulse-system-monitor
npm install
npm start
```

### Tests

```bash
npm test
```

62 tests on Node's built-in runner, no test framework needed. They cover the rules engine, the regression maths, the event log, and the two platform quirks below — the parts where a bug is silent, producing confident wrong advice rather than a crash.

To check the data layer without launching the interface:

```bash
npm run probe
```

This prints one real snapshot — metrics, grouped processes, and the diagnostics verdict — straight to the terminal.

## Architecture

```
src/
├── main/
│   ├── main.js        Electron entry: window, 2s polling loop, IPC
│   ├── metrics.js     Reads the machine; the only module touching the OS
│   └── preload.js     contextBridge — exposes exactly three functions
├── history/
│   ├── history.js     Rolling window, per-app series, least-squares trends
│   └── events.js      Episode log: when each resource went bad, and for how long
├── diagnostics/
│   └── diagnostics.js Pure rules engine: snapshot (+ history) in, findings out
└── renderer/
    ├── index.html
    ├── styles.css
    └── renderer.js    Presentation only; no Node access
```

**Data flow.** `main.js` polls `metrics.js` every two seconds, records the snapshot into `history.js`, passes both through `diagnostics.js`, folds the verdict into `events.js`, and sends the result to the renderer over IPC. The renderer draws it. Data moves in one direction only.

**Trends need evidence.** A slope alone is not a trend. `history.js` fits a least-squares line and reports R² alongside it, and a finding is only raised when the series has at least 20 samples spanning 5 minutes with a fit of 0.6 or better. A steep slope with a poor fit is a spiky workload; a moderate slope with a tight fit is a leak. Falling series are never reported, however cleanly they fit — freeing memory is not a problem.

**Process isolation.** The renderer runs with `contextIsolation: true` and `nodeIntegration: false`, behind a Content Security Policy. Its entire interface to the system is the three functions in `preload.js`.

**Diagnostics own the thresholds.** The engine tags each finding with the resource it concerns, and the renderer colors each card from that verdict. Thresholds live in exactly one place.

**Process names lie.** Grouping is done on the outermost `.app` bundle in a process's path, not on its name. ChatGPT ships helper processes named `Codex`, and VS Code's binary is just `Code` — grouping on names invents an application that is not installed and misses the one that is. Helpers nest their own bundles inside their parent's, so the first `.app` scanning left to right is the real application. Platforms without bundles fall back to cleaning up the process name.

Three details worth knowing, because all are easy to get wrong:

- **Memory** reports `active`, not `used`. On macOS `used` counts filesystem cache and sits near 100% permanently, which is true and useless.
- **Storage** reports `/System/Volumes/Data` on macOS rather than `/`. macOS seals the system volume, so reading `/` returns a comfortable-looking 50%-full 24 GB volume while the disk the user is actually filling sits at 94%. It is still labelled `/` in the interface, because that is what it is to the person using it.

**Outbound traffic.** Latency is measured with a single ICMP ping every five seconds. That is the only network request Pulse makes.

## Future Improvements

- Back off polling while the window is hidden. The interval lives in the main process, which Chromium does not throttle, so a minimized Pulse samples at full rate.
- Menu-bar tray with live CPU and a notification on critical findings.
- Per-core CPU breakdown, GPU utilization, temperature and fan sensors.
- Packaged installers via `electron-builder`.
