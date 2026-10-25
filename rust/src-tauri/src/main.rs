#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

// ---------------------------------------------------------------- Inspector DTO

#[derive(Serialize)]
struct ApDto {
    ssid: String,
    bssid: String,
    rssi: i32,
    quality: u32,
    freq_mhz: u32,
    band: String,
    channel: Option<u16>,
    width_mhz: u16,
    phy: String,
    security: String,
    akm: String,
    cipher: Option<String>,
    stations: Option<u16>,
    utilization: Option<u8>,
    iface: String,
    ie_bytes: usize,
}

#[derive(Serialize)]
struct IfaceDto {
    guid: String,
    description: String,
    state: String,
}

/// 当前连接（实际协商出来的 AKM / cipher / 速率），一块网卡一条。
#[derive(Serialize)]
struct ConnDto {
    iface_guid: String,
    iface: String,
    profile: String,
    ssid: String,
    bssid: String,
    phy: String,
    quality: u32,
    rx_mbps: f32,
    tx_mbps: f32,
    auth: String,
    cipher: String,
    one_x: bool,
}

// ---------------------------------------------------------------- 基础命令

fn app_dir() -> PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("WiFiRainbow")
}

/// ui.log 超过这个体积就轮转成 ui.log.1（只留一代）。之前只追加不裁剪。
const LOG_ROTATE_BYTES: u64 = 1024 * 1024;

fn rotate_log(path: &PathBuf) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.len() < LOG_ROTATE_BYTES {
        return;
    }
    let old = path.with_extension("log.1");
    let _ = std::fs::remove_file(&old);
    let _ = std::fs::rename(path, &old);
}

/// 前端把启动/报错写进日志，方便在看不到窗口的时候确认 UI 真的跑起来了。
#[tauri::command]
fn ui_log(level: String, message: String) -> Result<(), String> {
    let dir = app_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("ui.log");
    rotate_log(&path);
    let line = format!("{:<5} {}\n", level.to_uppercase(), message.replace('\n', " "));
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// 存在 %LOCALAPPDATA%\WiFiRainbow\selftest 时，前端会跑一遍烟雾测试；
/// 文件内容可选作为“停在哪个视图”的指令（channels / detail / inspector…），方便截图核对。
#[tauri::command]
fn selftest() -> Option<String> {
    std::fs::read_to_string(app_dir().join("selftest"))
        .ok()
        .map(|s| s.trim().to_string())
}

// ---------------------------------------------------------------- 导出

/// 零依赖 base64 解码（标准字母表，允许无 padding）。导出 PNG 时前端把 dataURL 的正文传过来。
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u32, String> {
        Ok(match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a') as u32 + 26,
            b'0'..=b'9' => (c - b'0') as u32 + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return Err(format!("非法 base64 字符 0x{c:02x}")),
        })
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace() && *b != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, b) in chunk.iter().enumerate() {
            acc |= val(*b)? << (18 - 6 * i);
        }
        let n = chunk.len();
        if n >= 2 {
            out.push((acc >> 16) as u8);
        }
        if n >= 3 {
            out.push((acc >> 8) as u8);
        }
        if n == 4 {
            out.push(acc as u8);
        }
    }
    Ok(out)
}

fn downloads_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .ok()
        .map(|p| PathBuf::from(p).join("Downloads"))
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| app_dir().join("export"))
}

/// 把一份导出写到「下载」目录（没有就落到 %LOCALAPPDATA%\WiFiRainbow\export），返回完整路径。
/// `encoding` 为 `base64` 时 `data` 按 base64 解码（PNG），否则按 UTF-8 文本原样写（CSV）。
/// 文件名只取 basename，防止前端传路径穿越。
#[tauri::command]
fn export_file(name: String, data: String, encoding: Option<String>) -> Result<String, String> {
    let safe: String = name
        .chars()
        .map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c })
        .collect();
    let safe = safe.trim().trim_matches('.').to_string();
    if safe.is_empty() {
        return Err("文件名为空".into());
    }
    let dir = downloads_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe);
    let bytes = if encoding.as_deref() == Some("base64") {
        base64_decode(&data)?
    } else {
        data.into_bytes()
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------- 扫描

#[tauri::command]
fn list_interfaces() -> Result<Vec<IfaceDto>, String> {
    wlan_core::interfaces()
        .map(|v| {
            v.iter()
                .map(|i| IfaceDto {
                    guid: i.guid.to_string(),
                    description: i.description.clone(),
                    state: i.state_label().to_string(),
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

/// `iface` 为空 / 缺省扫全部网卡；给 GUID 就只扫那一块（设置里「扫描网卡」）。
#[tauri::command]
async fn scan_now(wait_ms: Option<u64>, iface: Option<String>) -> Result<Vec<ApDto>, String> {
    let wait = Duration::from_millis(wait_ms.unwrap_or(2200));
    let aps = tauri::async_runtime::spawn_blocking(move || wlan_core::scan_on(wait, iface.as_deref()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    Ok(aps
        .into_iter()
        .map(|a| ApDto {
            ssid: a.ssid,
            bssid: a.bssid,
            rssi: a.rssi_dbm,
            quality: a.quality,
            freq_mhz: a.freq_mhz,
            band: a.band.label().to_string(),
            channel: a.channel,
            width_mhz: a.width_mhz,
            phy: a.phy.label().to_string(),
            security: a.security.label().to_string(),
            akm: a.akm.join(","),
            cipher: a.cipher.map(|c| c.to_string()),
            stations: a.station_count,
            utilization: a.channel_utilization,
            iface: a.interface,
            ie_bytes: a.ie_bytes,
        })
        .collect())
}

/// 每块已连接网卡的实况（`netsh wlan show interfaces` 那一套）。没连上就是空数组。
#[tauri::command]
fn current_connection() -> Result<Vec<ConnDto>, String> {
    wlan_core::current_connections()
        .map(|v| {
            v.into_iter()
                .map(|c| ConnDto {
                    iface_guid: c.interface_guid,
                    iface: c.interface,
                    profile: c.profile,
                    ssid: c.ssid,
                    bssid: c.bssid,
                    phy: c.phy.label().to_string(),
                    quality: c.quality,
                    rx_mbps: c.rx_mbps,
                    tx_mbps: c.tx_mbps,
                    auth: c.auth.to_string(),
                    cipher: c.cipher.to_string(),
                    one_x: c.one_x,
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_interfaces,
            scan_now,
            current_connection,
            export_file,
            ui_log,
            selftest
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
