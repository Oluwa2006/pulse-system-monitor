# Pulse System Monitor

[![tests](https://github.com/Oluwa2006/pulse-system-monitor/actions/workflows/tests.yml/badge.svg)](https://github.com/Oluwa2006/pulse-system-monitor/actions/workflows/tests.yml)

Lightweight desktop system monitor for tracking CPU, memory, storage, network activity, processes, and system health in real time.

## Overview

When a computer slows down, most tools tell you *that* something is wrong — 89% memory used — without telling you *what*. Pulse answers the second question.

It reads live metrics from the machine every two seconds, groups running processes by application, and runs a small rules engine over the result to produce plain-language findings like "Memory usage is high. Microsoft Edge is the largest consumer at 2.1 GB."

Every number in the interface is read from the operating system. There is no sample data, no simulation, and no network service behind it.

## Features

- **CPU** — live utilization with a rolling sparkline, a short-window average that smooths out momentary spikes, and a per-core sensor bar for every physical core.
- **Memory** — used and free bytes with a usage sparkline, based on *active* memory rather than the near-100% figure that includes filesystem cache.
- **Storage** — capacity and free space for the volume that actually fills up (see [Architecture](#architecture)).
- **Network** — round-trip latency, the active interface, connection state, and live throughput.
- **Processes** — top applications by CPU or memory, grouped by application bundle so a browser's 28 helper processes read as one row, not 28, and a helper is credited to the app that ships it rather than to its own name.
- **Diagnostics** — the rules engine that turns those readings into findings, sorted problems-first, each one naming the process responsible where there is one.
- **Trends** — a rolling 30-minute window lets the engine reason about direction, not just position: memory climbing steadily, a single app that only ever grows, load that has persisted rather than spiked.
- **Event log** — every stretch of time a resource spent unhealthy is recorded, so a spike that happened while you were away is still there when you come back.
- **Load profile** — CPU, memory and storage plotted together on one radar, with the last eight samples left on screen faintly so drift shows as a spread rather than a number.

## Screenshots

**Dashboard — diagnostics feed**

![Pulse dashboard in lime on black: status bar, CPU memory storage and network readouts with gauges, per-core sensor bars, grouped process table, load-profile radar, and a diagnostics feed](docs/screenshot-dashboard.png)

**Activity feed — event log**

![The same dashboard with the activity feed switched to events, showing two ongoing episodes with their durations](docs/screenshot-diagnostics.png)

The hostname is redacted in both shots. Everything else is live data from the machine they were taken on.

## Technology

| Layer | Choice |
| --- | --- |
| Shell | Electron 44 |
| Runtime | Node.js |
| Interface | HTML, CSS, vanilla JavaScript — no framework, no build step |
| Charts | Hand-drawn inline SVG — sparklines, gauge arcs and the radar are all built from raw geometry |
| System data | [`systeminformation`](https://github.com/sebhildebrandt/systeminformation) |

Two runtime dependencies, no database, no accounts, no cloud services.

## Installation

### Download (macOS)

[**Download the latest release**](https://github.com/Oluwa2006/pulse-system-monitor/releases/latest) — take the `arm64` build for Apple Silicon or the `x64` build for Intel.

Builds are signed with a Developer ID certificate and notarised by Apple, so the app opens normally with no security prompt.

If you are building from source without a certificate, the result is signed ad-hoc instead and macOS will stop it. On macOS 15 and later the old right-click → *Open* trick no longer works — use **System Settings → Privacy & Security → Open Anyway**, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Pulse.app
```

### From source

Requires Node.js 20 or newer.

```bash
git clone https://github.com/Oluwa2006/pulse-system-monitor.git
cd pulse-system-monitor
npm install
npm start
```

### Building installers

```bash
npm run dist
```

Produces both architectures as `.dmg` files in `dist/`. The app icon is generated from `build/icon.html` with `npm run icon`; electron-builder converts it to `.icns` at package time.

### Tests

```bash
npm test
```

96 tests on Node's built-in runner — no test framework, with `jsdom` as the only test-time dependency, there to give the renderer a DOM. They run on every push against Node 20, 22 and 24 on both Linux and macOS.

Coverage is concentrated where a bug is *silent* rather than loud:

- **Rules engine, trend maths, event log** — a mistake here produces confident wrong advice instead of a crash.
- **Platform quirks** — the macOS data volume and the bundle resolution described below, both pinned so they cannot quietly regress.
- **Renderer** — mounted exactly as shipped: the real `index.html` and `renderer.js` run in jsdom behind a stubbed preload bridge, so any load-time error fails the suite. That guards a bug that actually happened: a temporal-dead-zone throw at load left every reading on the dashboard as a placeholder dash while the styling still looked entirely correct.

**What these tests cannot see.** jsdom has no layout engine, so nothing about size, overflow, or how a stretched `viewBox` distorts its own text is visible to them. Two of the three renderer bugs found while building the interface were exactly that kind, and both were caught by looking at the running application. Screenshots are the check there, not assertions — and that is a real limit, not a rounding error.

To check the data layer without launching the interface:

```bash
npm run probe
```

This prints one real snapshot — metrics, grouped processes, and the diagnostics verdict — straight to the terminal.

### Platform support

Pulse is developed and used on macOS, and that is the only platform where the
running application has been verified end to end. The rest is stated honestly
rather than implied:

| Platform | State |
| --- | --- |
| macOS | **Verified.** Every feature exercised against real hardware, including the two platform quirks below. |
| Linux | **Partially verified.** The unit tests run on Linux in CI on every push, but the assembled application has never been launched there. |
| Windows | **Unverified.** The volume picker has a `C:` branch and nothing else has been exercised. Treat it as untested. |

The platform-specific surface is small and confined to `metrics.js` — process
grouping and volume selection — so the gap is narrow, but it is a real gap.

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

- Back off polling while the window is hidden. The interval lives in the main process, which Chromium does not throttle, so a minimised Pulse samples at full rate.
- Menu-bar tray with live CPU and a notification on critical findings.
- GPU utilisation, temperature and fan sensors, alongside the existing per-core readings.
- Tests for layout. The renderer suite runs in jsdom, which has no layout engine, so size and overflow bugs are still caught only by looking at the running app.
- Verify the Linux build end to end. The unit tests run there in CI, but the assembled application has never been launched on it.
