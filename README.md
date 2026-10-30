# WiFi Rainbow

[中文说明](docs/README.zh-CN.md) · [User manual](docs/manual.en.md) · [使用手册](docs/manual.zh-CN.md) · [Code signing policy](docs/CODE_SIGNING_POLICY.md)

A small Wi-Fi analyzer for Windows. It scans the access points around you and shows per-band signal arcs, channel occupancy, co-/adjacent-channel interference and a channel recommendation, plus what your own adapter is connected to and which security it actually negotiated.

Rust + Tauri 2 + plain HTML/JS, no third-party runtime beyond the WebView2 that ships with Windows. It never connects to the network and collects no data.

![Inspector view](docs/images/en-inspector.png)

## Download

Installer on the [Releases](https://github.com/yunnysunny/wifi-rainbow/releases) page: `WiFi-Rainbow_<version>_x64-setup.exe`. Per-user install into `%LOCALAPPDATA%\WiFi Rainbow\`, no administrator rights needed.

Code signing: the project has applied to the [SignPath Foundation](https://signpath.org/)'s free code-signing program for open-source software. Until the application is approved, release installers are **unsigned** and SmartScreen will warn on first run. Details and current status in the [code signing policy](docs/CODE_SIGNING_POLICY.md).

Requirements: Windows 10 / 11 x64, a wireless adapter, the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 11).

## Features

**Inspector**
- 2.4 / 5 / 6 GHz signal charts: arc width = channel width, height = signal strength; arcs fully covered by a stronger AP are dashed
- 3-minute signal history, or an event list of what changed between scans: appeared / gone / signal drop / channel change / width change
- AP table: SSID, BSSID, dBm, quality, channel, band, width, PHY, security, AKM, clients, air time, trend; sortable, filter by SSID / BSSID / alias
- Group by router: `Home` / `Home-5G` style multi-BSSID routers fold into one expandable row
- The connected AP is marked and shows the negotiated auth / cipher / link rate
- Aliases and a watch list (watched networks get history curves by default)
- Export the table as CSV; export PNG as charts only or the whole window

**Channels**
- Spectrum occupancy per band
- Co-/adjacent-channel overlap, carrier-to-interference ratio (CIR), main interferers
- Channel scores and a recommended channel per band (5 GHz avoids DFS)
- Hover a channel: APs on it turn blue, overlapping interferers turn amber, the rest dim

**AP details drawer**
- Signal / quality / estimated distance / vendor, 3-minute sparkline, interference profile
- Every radio field: band, channel, frequency, width, PHY, IE length, security, AKM, cipher, clients, channel utilization

**Settings**
- Hidden-SSID filter, minimum signal, band switches, refresh interval, scan adapter (when you have several)
- Chinese / English UI, switches instantly
- Dark / light / follow-system theme; optional minimize-to-tray on close (keeps scanning, tray menu to restore or quit)

See the [user manual](docs/manual.en.md) for screenshots of every view.

## How it gets the data

Everything comes from the Windows Native Wifi API (`wlanapi.dll`: `WlanScan` → `WlanGetNetworkBssList`, current connection via `WlanQueryInterface`) through zero-dependency Rust FFI. Channel width, security mode and BSS Load are not API fields; they are parsed from the beacon's Information Elements (HT / VHT / HE / RSN / WPA) in Rust.

Windows has no monitor mode, so this is polling (about one scan every two seconds at best) and cannot see transient bursts. The interference model only sums overlapping power; it does not simulate CSMA contention. Distance is a simplified log-distance estimate and only good for comparison.

Tested on an Intel AX200. The memory layout of the IE pool returned by the driver was reverse-engineered (the `ulIeOffset` field is not trustworthy); with another adapter vendor, run `WLAN_IE_DUMP=1 cargo run -p wlan-core --bin wlanscan` first and check the IE chains look sane.

## Building from source

Rust stable (1.80+) and the [Tauri 2 prerequisites for Windows](https://tauri.app/start/prerequisites/) (Visual Studio C++ build tools, WebView2).

```powershell
cd rust
cargo build                      # debug: target/debug/wifi-rainbow.exe
cargo install tauri-cli --version "^2" --locked
cargo tauri build                # installer: target/release/bundle/nsis/WiFi-Rainbow_*_x64-setup.exe
```

The front end lives in `rust/ui/` and is embedded into the exe at build time, so rebuild after editing it.

Command-line probe (same parser as the UI):

```powershell
cargo run -p wlan-core --bin wlanscan
```

## Tests

- `npm test` (or `node tests/changes.test.js`): unit tests for the change tracker. Runs in CI.
- `cargo clippy --workspace --all-targets -- -D warnings`. Runs in CI.
- UI smoke test: write a view name (`inspector` / `channels` / `detail` / `settings` / `group` / `events` / `conn` / `export` / `en` …) into `%LOCALAPPDATA%\WiFiRainbow\selftest` and start the program; it runs a dozen probes against the real adapter, logs to `%LOCALAPPDATA%\WiFiRainbow\ui.log` and parks on that view. Needs a real adapter, so not in CI. Delete the marker file afterwards.
- Demo mode: `demo:<view>` (or `demo:en-<view>`) in the same file shows a synthetic set of networks; the manual screenshots come from it.

Development notes, known limits and the backlog are in [TODO.md](TODO.md) (Chinese).

## Documentation site

`tools/build-docs.mjs` turns `docs/` into a static site with a product home page and a shared navigation menu (Home · Manual · Code signing · Download · GitHub · language switch):

```powershell
npm install
npm run docs         # -> site/
```

| Page | Path |
|---|---|
| Home (English) | `site/index.html` |
| Home (Chinese) | `site/zh-CN/index.html` |
| Manual (English) | `site/manual/index.html` |
| Manual (Chinese) | `site/zh-CN/manual/index.html` |
| Code signing policy | `site/code-signing.html` |

It is meant for Cloudflare Pages: connect the repository, set the build command to `npm ci && npm run docs` and the output directory to `site`. No other configuration is needed; the pages reference no external resources.

## Privacy

The program makes no network connections and transfers no information to any system. Settings, aliases and the watch list are stored in the local WebView2 profile; the UI log is written to `%LOCALAPPDATA%\WiFiRainbow\ui.log`; CSV / PNG exports go wherever you put them.

## License

[MIT](LICENSE)
