//! Windows Native Wifi 数据层。
//!
//! 直接 FFI 调 `wlanapi.dll`，不依赖任何 crate：
//! `WlanOpenHandle` → `WlanEnumInterfaces` → `WlanScan` → `WlanGetNetworkBssList`
//!
//! 关键点（Intel AX200 / Win11）：
//! 1. `WLAN_BSS_ENTRY` 定长 360 字节，条目数组之后紧跟 IE 池。
//! 2. `ulIeOffset` 是**相对本条 `WLAN_BSS_ENTRY` 起点**的偏移（wlanapi.h 文档如此），
//!    不是相对整个列表；按 `entry + ulIeOffset` 取 IE，校验不过才退回「8 字节对齐累加 + 附近搜索」。
//! 3. `WlanScan` 是异步的：用 ACM 的 scan_complete / scan_fail 通知等扫描结束，`wait` 只是上限。
//!
//! 信道宽度与安全等级不在 API 字段里，必须自己解析 IE。宽度只看 **Operation** 类 IE
//! （HT Op 61 / VHT Op 192 / HE Op 255-36 / EHT Op 255-106），Capabilities 类 IE 只表示「支持」，不代表在用。

use std::ffi::c_void;
use std::fmt;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------- FFI

type Handle = isize;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Guid {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}

impl fmt::Display for Guid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let d = &self.data4;
        write!(
            f,
            "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            self.data1, self.data2, self.data3, d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]
        )
    }
}

#[repr(C)]
struct Dot11Ssid {
    u_ssid_length: u32,
    uc_ssid: [u8; 32],
}

#[repr(C)]
struct WlanRateSet {
    u_rate_set_length: u32,
    us_rate_set: [u16; 126],
}

/// 布局与 wlanapi.h 的 WLAN_BSS_ENTRY 一致（实测 sizeof = 360）。
#[repr(C)]
struct WlanBssEntry {
    dot11_ssid: Dot11Ssid,
    u_phy_id: u32,
    dot11_bssid: [u8; 6],
    dot11_bss_type: u32,
    dot11_bss_phy_type: u32,
    l_rssi: i32,
    u_link_quality: u32,
    b_in_reg_domain: u8,
    us_beacon_period: u16,
    ull_timestamp: u64,
    ull_host_timestamp: u64,
    us_capability_information: u16,
    ul_ch_center_frequency: u32,
    wlan_rate_set: WlanRateSet,
    ul_ie_offset: u32,
    ul_ie_size: u32,
}

#[repr(C)]
struct WlanBssList {
    dw_total_size: u32,
    dw_number_of_items: u32,
    wlan_bss_entries: [WlanBssEntry; 1],
}

#[repr(C)]
struct WlanInterfaceInfo {
    interface_guid: Guid,
    str_interface_description: [u16; 256],
    is_state: u32,
}

#[repr(C)]
struct WlanInterfaceInfoList {
    dw_number_of_items: u32,
    dw_index: u32,
    interface_info: [WlanInterfaceInfo; 1],
}

/// WlanQueryInterface(wlan_intf_opcode_current_connection) 返回的结构。
/// 布局与 wlanapi.h 一致：36 + 4 + 6(+2 pad) + 4 + 4 + 4 + 4 + 4 = 68 字节。
#[repr(C)]
struct WlanAssociationAttributes {
    dot11_ssid: Dot11Ssid,
    dot11_bss_type: u32,
    dot11_bssid: [u8; 6],
    dot11_phy_type: u32,
    u_dot11_phy_index: u32,
    wlan_signal_quality: u32,
    ul_rx_rate: u32,
    ul_tx_rate: u32,
}

#[repr(C)]
struct WlanSecurityAttributes {
    b_security_enabled: i32,
    b_one_x_enabled: i32,
    dot11_auth_algorithm: u32,
    dot11_cipher_algorithm: u32,
}

#[repr(C)]
struct WlanConnectionAttributes {
    is_state: u32,
    wlan_connection_mode: u32,
    str_profile_name: [u16; 256],
    wlan_association_attributes: WlanAssociationAttributes,
    wlan_security_attributes: WlanSecurityAttributes,
}

/// WLAN_NOTIFICATION_DATA
#[repr(C)]
struct WlanNotificationData {
    notification_source: u32,
    notification_code: u32,
    interface_guid: Guid,
    dw_data_size: u32,
    p_data: *const c_void,
}

type NotificationCallback = unsafe extern "system" fn(*const WlanNotificationData, *mut c_void);

const WLAN_NOTIFICATION_SOURCE_NONE: u32 = 0;
const WLAN_NOTIFICATION_SOURCE_ACM: u32 = 0x0000_0008;
const WLAN_NOTIFICATION_ACM_SCAN_COMPLETE: u32 = 7;
const WLAN_NOTIFICATION_ACM_SCAN_FAIL: u32 = 8;

const WLAN_CLIENT_VERSION_VISTA: u32 = 2;
const DOT11_BSS_TYPE_ANY: u32 = 3;
const WLAN_INTF_OPCODE_CURRENT_CONNECTION: u32 = 7;
/// ERROR_INVALID_STATE：网卡没连上时 WlanQueryInterface 就是这个码，不算错误
const ERROR_INVALID_STATE: u32 = 5023;

#[link(name = "wlanapi")]
extern "system" {
    fn WlanOpenHandle(
        dwClientVersion: u32,
        pReserved: *const c_void,
        pdwNegotiatedVersion: *mut u32,
        phClientHandle: *mut Handle,
    ) -> u32;
    fn WlanCloseHandle(hClientHandle: Handle, pReserved: *const c_void) -> u32;
    fn WlanFreeMemory(pMemory: *const c_void);
    fn WlanEnumInterfaces(
        hClientHandle: Handle,
        pReserved: *const c_void,
        ppInterfaceList: *mut *const WlanInterfaceInfoList,
    ) -> u32;
    fn WlanScan(
        hClientHandle: Handle,
        pInterfaceGuid: *const Guid,
        pDot11Ssid: *const Dot11Ssid,
        pIeData: *const c_void,
        pReserved: *const c_void,
    ) -> u32;
    fn WlanGetNetworkBssList(
        hClientHandle: Handle,
        pInterfaceGuid: *const Guid,
        pDot11Ssid: *const Dot11Ssid,
        dot11BssType: u32,
        bSecurityEnabled: i32,
        pReserved: *const c_void,
        ppWlanBssList: *mut *const WlanBssList,
    ) -> u32;
    fn WlanQueryInterface(
        hClientHandle: Handle,
        pInterfaceGuid: *const Guid,
        OpCode: u32,
        pReserved: *const c_void,
        pdwDataSize: *mut u32,
        ppData: *mut *const c_void,
        pWlanOpcodeValueType: *mut u32,
    ) -> u32;
    fn WlanRegisterNotification(
        hClientHandle: Handle,
        dwNotifSource: u32,
        bIgnoreDuplicate: i32,
        funcCallback: Option<NotificationCallback>,
        pCallbackContext: *mut c_void,
        pReserved: *const c_void,
        pdwPrevNotifSource: *mut u32,
    ) -> u32;
}

#[link(name = "kernel32")]
extern "system" {
    /// FILETIME 与 u64 小端布局一致（100ns，自 1601-01-01 UTC）
    fn GetSystemTimeAsFileTime(lpSystemTimeAsFileTime: *mut u64);
}

const _: () = assert!(std::mem::size_of::<WlanBssEntry>() == 360, "WLAN_BSS_ENTRY 布局变了");
const _: () = assert!(
    std::mem::size_of::<WlanAssociationAttributes>() == 68,
    "WLAN_ASSOCIATION_ATTRIBUTES 布局变了"
);
const _: () = assert!(
    std::mem::size_of::<WlanConnectionAttributes>() == 8 + 512 + 68 + 16,
    "WLAN_CONNECTION_ATTRIBUTES 布局变了"
);

// ---------------------------------------------------------------- 错误

#[derive(Debug)]
pub enum WlanError {
    Api { call: &'static str, code: u32 },
    NoInterfaces,
}

impl fmt::Display for WlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WlanError::Api { call, code } => write!(f, "{call} 失败，返回码 0x{code:08x}"),
            WlanError::NoInterfaces => write!(f, "没有可用的无线网卡"),
        }
    }
}

impl std::error::Error for WlanError {}

type Result<T> = std::result::Result<T, WlanError>;

// ---------------------------------------------------------------- 模型

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Band {
    B24,
    B5,
    B6,
    Unknown,
}

impl Band {
    pub fn label(self) -> &'static str {
        match self {
            Band::B24 => "2.4 GHz",
            Band::B5 => "5 GHz",
            Band::B6 => "6 GHz",
            Band::Unknown => "?",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phy {
    Dot11a,
    Dot11b,
    Dot11g,
    Dot11n,
    Dot11ac,
    Dot11ax,
    Dot11be,
    Dot11ad,
    Other(u32),
}

impl Phy {
    fn from_raw(raw: u32) -> Self {
        match raw {
            4 => Phy::Dot11a,
            5 => Phy::Dot11b,
            6 => Phy::Dot11g,
            7 => Phy::Dot11n,
            8 => Phy::Dot11ac,
            9 => Phy::Dot11ad,
            10 => Phy::Dot11ax,
            11 => Phy::Dot11be,
            other => Phy::Other(other),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Phy::Dot11a => "802.11a",
            Phy::Dot11b => "802.11b",
            Phy::Dot11g => "802.11g",
            Phy::Dot11n => "802.11n",
            Phy::Dot11ac => "802.11ac",
            Phy::Dot11ax => "802.11ax",
            Phy::Dot11be => "802.11be",
            Phy::Dot11ad => "802.11ad",
            Phy::Other(_) => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Security {
    Open,
    Wep,
    Wpa,
    Wpa2,
    Wpa2Enterprise,
    Wpa3,
    /// WPA2/WPA3 过渡模式：同一个 RSN IE 里 PSK 和 SAE 都在（很常见，路由器默认混开）
    Wpa2Wpa3,
    Wpa3Enterprise,
    Owe,
}

impl Security {
    pub fn label(self) -> &'static str {
        match self {
            Security::Open => "OPEN",
            Security::Wep => "WEP",
            Security::Wpa => "WPA",
            Security::Wpa2 => "WPA2",
            Security::Wpa2Enterprise => "WPA2-ENT",
            Security::Wpa3 => "WPA3",
            Security::Wpa2Wpa3 => "WPA2/WPA3",
            Security::Wpa3Enterprise => "WPA3-ENT",
            Security::Owe => "OWE",
        }
    }
}

#[derive(Debug, Clone)]
pub struct InterfaceInfo {
    pub guid: Guid,
    pub description: String,
    pub state: u32,
}

impl InterfaceInfo {
    pub fn state_label(&self) -> &'static str {
        match self.state {
            0 => "not-ready",
            1 => "connected",
            2 => "ad-hoc",
            3 => "disconnecting",
            4 => "disconnected",
            5 => "associating",
            6 => "discovering",
            7 => "authenticating",
            _ => "unknown",
        }
    }
}

/// 单个 BSS 的观测结果。Survey 的打点记录就是 `Vec<AccessPoint>` 快照。
#[derive(Debug, Clone)]
pub struct AccessPoint {
    pub ssid: String,
    pub bssid: String,
    pub rssi_dbm: i32,
    pub quality: u32,
    pub freq_mhz: u32,
    pub band: Band,
    pub channel: Option<u16>,
    pub phy: Phy,
    pub width_mhz: u16,
    pub security: Security,
    pub akm: Vec<&'static str>,
    pub cipher: Option<&'static str>,
    pub beacon_interval: u16,
    pub in_reg_domain: bool,
    pub station_count: Option<u16>,
    pub channel_utilization: Option<u8>,
    pub ie_bytes: usize,
    pub interface: String,
    /// 距驱动最后一次收到该 BSS 的 Beacon/Probe Response 过了多久（`ullHostTimestamp`）。
    /// BSS 列表是驱动缓存，这一轮没扫到的 AP 也会留在里面；值不可信（驱动没填/单位异常）时为 None。
    pub age_ms: Option<u64>,
}

/// 当前连接（对应 `netsh wlan show interfaces` 里连接态那一段）。
/// 这里的 auth/cipher 是**实际协商**出来的，不是扫描时 RSN IE 里"支持哪些"。
#[derive(Debug, Clone)]
pub struct Connection {
    pub interface_guid: String,
    pub interface: String,
    pub state: &'static str,
    pub profile: String,
    pub ssid: String,
    pub bssid: String,
    pub phy: Phy,
    pub quality: u32,
    pub rx_mbps: f32,
    pub tx_mbps: f32,
    pub auth: &'static str,
    pub cipher: &'static str,
    pub one_x: bool,
    pub security_enabled: bool,
}

/// DOT11_AUTH_ALGORITHM → 跟 netsh 一致的叫法
fn auth_name(v: u32) -> &'static str {
    match v {
        1 => "Open",
        2 => "Shared-Key",
        3 => "WPA-Enterprise",
        4 => "WPA-Personal",
        5 => "WPA-None",
        6 => "WPA2-Enterprise",
        7 => "WPA2-Personal",
        8 => "WPA3-Enterprise-192",
        9 => "WPA3-Personal",
        10 => "OWE",
        11 => "WPA3-Enterprise",
        _ => "?",
    }
}

/// DOT11_CIPHER_ALGORITHM → 名字
fn cipher_algo_name(v: u32) -> &'static str {
    match v {
        0 => "NONE",
        1 => "WEP-40",
        2 => "TKIP",
        4 => "CCMP",
        5 => "WEP-104",
        6 => "BIP",
        8 => "GCMP",
        9 => "GCMP-256",
        10 => "CCMP-256",
        0x100 => "WPA-GROUP",
        0x101 => "WEP",
        _ => "?",
    }
}

// ---------------------------------------------------------------- IE 解析

struct Ies {
    security: Security,
    akm: Vec<&'static str>,
    cipher: Option<&'static str>,
    width_mhz: u16,
    station_count: Option<u16>,
    channel_utilization: Option<u8>,
}

/// IEEE 802.11-2020 表 9-149 密码套件选择子（OUI 00-0F-AC）
fn cipher_name(suite: u8) -> &'static str {
    match suite {
        1 => "WEP-40",
        2 => "TKIP",
        4 => "CCMP",
        5 => "WEP-104",
        8 => "GCMP-128",
        9 => "GCMP-256",
        10 => "CCMP-256",
        _ => "?",
    }
}

/// 多个单播密码并存（如 TKIP+CCMP 混合模式）时取最强的那个来展示
fn cipher_rank(name: &str) -> u8 {
    match name {
        "GCMP-256" => 6,
        "CCMP-256" => 5,
        "GCMP-128" => 4,
        "CCMP" => 3,
        "TKIP" => 2,
        "WEP-104" | "WEP-40" => 1,
        _ => 0,
    }
}

fn akm_name(suite: u8) -> &'static str {
    match suite {
        1 => "802.1X",
        2 => "PSK",
        3 => "FT-802.1X",
        4 => "FT-PSK",
        5 => "802.1X-SHA256",
        6 => "PSK-SHA256",
        8 => "SAE",
        9 => "FT-SAE",
        11 => "802.1X-SUITE-B",
        12 => "802.1X-SUITE-B-192",
        18 => "OWE",
        // SAE-EXT-KEY：WPA3 H2E / Wi-Fi 7 路由器常用，不认的话会被当成 WPA2
        24 => "SAE-EXT-KEY",
        25 => "FT-SAE-EXT-KEY",
        _ => "?",
    }
}

fn le16(b: &[u8], pos: usize) -> Option<u16> {
    b.get(pos..pos + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}

/// RSN(48) / WPA 厂商 IE(221) 共用结构；`body` 已去掉 WPA 的 4 字节 OUI+type 头。
fn parse_rsn(body: &[u8], is_wpa1: bool, out: &mut Ies) {
    if body.len() < 6 {
        return;
    }
    let mut pos = 2; // version
    let group = cipher_name(body[pos + 3]);
    pos += 4;

    // 展示用单播（pairwise）密码，不是组播密码：TKIP+CCMP 混合模式下组播是 TKIP，实际单播是 CCMP
    let pairwise_count = le16(body, pos).unwrap_or(0) as usize;
    pos += 2;
    let best_pairwise = (0..pairwise_count)
        .filter_map(|i| body.get(pos + i * 4 + 3))
        .map(|s| cipher_name(*s))
        .filter(|n| *n != "?")
        .max_by_key(|n| cipher_rank(n));
    out.cipher = Some(best_pairwise.unwrap_or(group));
    pos += 4 * pairwise_count;

    let akm_count = le16(body, pos).unwrap_or(0) as usize;
    pos += 2;
    for i in 0..akm_count {
        if let Some(suite) = body.get(pos + i * 4 + 3) {
            out.akm.push(akm_name(*suite));
        }
    }

    let akm = &out.akm;
    let has_sae = akm
        .iter()
        .any(|a| matches!(*a, "SAE" | "FT-SAE" | "SAE-EXT-KEY" | "FT-SAE-EXT-KEY"));
    let has_psk = akm.iter().any(|a| a.starts_with("PSK"));
    out.security = if akm.contains(&"OWE") {
        Security::Owe
    } else if has_sae && has_psk {
        // 过渡模式：PSK（WPA2）+ SAE（WPA3）同时开，Display 成 WPA2/WPA3 才对得上路由器配置
        Security::Wpa2Wpa3
    } else if has_sae {
        Security::Wpa3
    } else if akm.contains(&"802.1X-SUITE-B") || akm.contains(&"802.1X-SUITE-B-192") {
        Security::Wpa3Enterprise
    } else if is_wpa1 {
        Security::Wpa
    } else if akm.iter().any(|a| a.starts_with("802.1X")) {
        Security::Wpa2Enterprise
    } else {
        Security::Wpa2
    };
}

/// VHT Operation(192) → 工作带宽。Channel Width=1 时再用 CCFS0/CCFS1 区分 80 / 160 / 80+80。
fn vht_op_width(body: &[u8]) -> Option<u16> {
    let cw = *body.first()?;
    match cw {
        0 => None, // 20/40，由 HT Operation 决定
        1 => {
            let c0 = *body.get(1)? as i32;
            let c1 = *body.get(2)? as i32;
            if c1 == 0 {
                Some(80)
            } else {
                // |CCFS1-CCFS0| == 8 → 160；> 16 → 80+80（按占用 160 MHz 计）
                Some(if (c1 - c0).abs() == 8 || (c1 - c0).abs() > 16 { 160 } else { 80 })
            }
        }
        2 | 3 => Some(160), // 已废弃的 160 / 80+80 写法
        _ => None,
    }
}

/// HE Operation(255/ext 36) 里的 6 GHz Operation Information → 工作带宽。
/// 布局：[36][HE Op Params 3B][BSS Color 1B][Basic HE-MCS 2B][VHT Op Info 3B?][Max Co-Hosted 1B?][6GHz Op Info 5B?]
fn he_op_6g_width(body: &[u8]) -> Option<u16> {
    let p = u32::from_le_bytes([*body.get(1)?, *body.get(2)?, *body.get(3)?, 0]);
    let mut pos = 7usize;
    if p & (1 << 14) != 0 {
        pos += 3; // VHT Operation Information Present
    }
    if p & (1 << 15) != 0 {
        pos += 1; // Co-Hosted BSS
    }
    if p & (1 << 17) == 0 {
        return None; // 没有 6 GHz Operation Information
    }
    let control = *body.get(pos + 1)?; // [primary][control][ccfs0][ccfs1][min rate]
    Some(match control & 0x3 {
        0 => 20,
        1 => 40,
        2 => 80,
        _ => 160,
    })
}

/// EHT Operation(255/ext 106) → 工作带宽（含 320 MHz）。
/// 布局：[106][EHT Op Params 1B][Basic EHT-MCS 4B][EHT Op Info: control ccfs0 ccfs1 ...]
fn eht_op_width(body: &[u8]) -> Option<u16> {
    let params = *body.get(1)?;
    if params & 0x01 == 0 {
        return None; // EHT Operation Information 不存在，带宽沿用 HT/VHT/HE
    }
    let control = *body.get(6)?;
    match control & 0x7 {
        0 => Some(20),
        1 => Some(40),
        2 => Some(80),
        3 => Some(160),
        4 => Some(320),
        _ => None,
    }
}

/// `capability` 是 `WLAN_BSS_ENTRY.usCapabilityInformation`（Beacon 固定字段，不在 IE 里）
fn parse_ies(blob: &[u8], freq_mhz: u32, capability: u16) -> Ies {
    let mut out = Ies {
        security: Security::Open,
        akm: Vec::new(),
        cipher: None,
        width_mhz: 20,
        station_count: None,
        channel_utilization: None,
    };
    let mut ht40 = false;
    let mut vht: Option<u16> = None;
    let mut he6: Option<u16> = None;
    let mut eht: Option<u16> = None;
    let mut rsn: Option<&[u8]> = None;
    let mut wpa1: Option<&[u8]> = None;
    let mut i = 0usize;
    while i + 2 <= blob.len() {
        let id = blob[i];
        let len = blob[i + 1] as usize;
        let Some(body) = blob.get(i + 2..i + 2 + len) else {
            break;
        };
        match id {
            // BSS Load：连接数 + 信道利用率，可做"空口拥堵"
            11 if len >= 5 => {
                out.station_count = le16(body, 0);
                out.channel_utilization = body.get(2).copied();
            }
            // HT Operation：次信道偏移(1=上/3=下) 且 STA Channel Width=1 才是真在跑 40 MHz
            61 if len >= 2 => {
                let info = body[1];
                let offset = info & 0x03;
                ht40 = (offset == 1 || offset == 3) && info & 0x04 != 0;
            }
            48 => rsn = Some(body),
            192 if len >= 3 && (4900..5925).contains(&freq_mhz) => vht = vht_op_width(body),
            221 if len >= 8 && body[..4] == [0x00, 0x50, 0xf2, 0x01] => wpa1 = Some(&body[4..]),
            255 if len >= 1 => match body[0] {
                36 if freq_mhz >= 5925 => he6 = he_op_6g_width(body),
                106 => eht = eht_op_width(body),
                _ => {}
            },
            _ => {}
        }
        i += 2 + len;
    }

    // RSN 优先；只有没有 RSN 时才退回 WPA1 厂商 IE（很多 AP 两个都发，双解析会造成 AKM 重复）
    if let Some(body) = rsn {
        parse_rsn(body, false, &mut out);
    } else if let Some(body) = wpa1 {
        parse_rsn(body, true, &mut out);
    } else if capability & 0x0010 != 0 {
        // 没有 RSN/WPA IE 但 Capability 的 Privacy 位置 1 → WEP
        out.security = Security::Wep;
    }

    let base = if ht40 { 40 } else { 20 };
    out.width_mhz = [Some(base), vht, he6, eht].into_iter().flatten().max().unwrap_or(20);
    // 按频段封顶：2.4 GHz 最多 40；5 GHz 最多 160；320 只存在于 6 GHz
    out.width_mhz = match freq_mhz {
        0..=2499 => out.width_mhz.min(40),
        2500..=5924 => out.width_mhz.min(160),
        _ => out.width_mhz.min(320),
    };
    out
}

/// 中心频率 → (频段, 信道号)。全部用 checked 运算：4.9 GHz、6 GHz 信道 2（5935 MHz）等边界不会下溢。
fn band_and_channel(freq_khz: u32) -> (Band, Option<u16>) {
    let mhz = freq_khz / 1000;
    let ch = |base: u32| mhz.checked_sub(base).map(|d| (d / 5) as u16);
    match mhz {
        2484 => (Band::B24, Some(14)),
        2400..=2499 => (Band::B24, ch(2407)),
        // 4.9 GHz（日本 / 公共安全）：信道号以 4000 MHz 为起点，如 4920 → 184
        4900..=4999 => (Band::B5, ch(4000)),
        5000..=5924 => (Band::B5, ch(5000)),
        // 6 GHz：信道 2 是 5935 MHz 特例，其余以 5950 为起点（信道 1 = 5955）
        5935 => (Band::B6, Some(2)),
        5925..=7200 => (Band::B6, ch(5950)),
        _ => (Band::Unknown, None),
    }
}

fn guid_to_string(g: &Guid) -> String {
    g.to_string()
}

// ---------------------------------------------------------------- 句柄

struct Client {
    handle: Handle,
}

impl Client {
    fn open() -> Result<Self> {
        let mut handle: Handle = 0;
        let mut negotiated = 0u32;
        let code = unsafe {
            WlanOpenHandle(
                WLAN_CLIENT_VERSION_VISTA,
                std::ptr::null(),
                &mut negotiated,
                &mut handle,
            )
        };
        if code != 0 {
            return Err(WlanError::Api {
                call: "WlanOpenHandle",
                code,
            });
        }
        Ok(Client { handle })
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        unsafe { WlanCloseHandle(self.handle, std::ptr::null()) };
    }
}

struct OwnedPtr<T>(*const T);

impl<T> Drop for OwnedPtr<T> {
    fn drop(&mut self) {
        unsafe { WlanFreeMemory(self.0 as *const c_void) };
    }
}

// ---------------------------------------------------------------- 公共 API

pub fn interfaces() -> Result<Vec<InterfaceInfo>> {
    let client = Client::open()?;
    let mut p: *const WlanInterfaceInfoList = std::ptr::null();
    let code = unsafe { WlanEnumInterfaces(client.handle, std::ptr::null(), &mut p) };
    if code != 0 {
        return Err(WlanError::Api {
            call: "WlanEnumInterfaces",
            code,
        });
    }
    let owned = OwnedPtr(p);
    let list = unsafe { &*owned.0 };
    let base = std::ptr::addr_of!(list.interface_info) as *const WlanInterfaceInfo;
    let mut out = Vec::with_capacity(list.dw_number_of_items as usize);
    for i in 0..list.dw_number_of_items as usize {
        let info = unsafe { &*base.add(i) };
        out.push(InterfaceInfo {
            guid: info.interface_guid,
            description: decode_utf16(&info.str_interface_description),
            state: info.is_state,
        });
    }
    Ok(out)
}

fn decode_utf16(buf: &[u16]) -> String {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// 等待各网卡的 scan_complete / scan_fail 通知。回调在 wlanapi 的线程上跑。
struct ScanWaiter {
    pending: Mutex<Vec<String>>,
    done: Condvar,
}

unsafe extern "system" fn on_wlan_notification(data: *const WlanNotificationData, ctx: *mut c_void) {
    if data.is_null() || ctx.is_null() {
        return;
    }
    let d = &*data;
    if d.notification_source != WLAN_NOTIFICATION_SOURCE_ACM
        || !matches!(
            d.notification_code,
            WLAN_NOTIFICATION_ACM_SCAN_COMPLETE | WLAN_NOTIFICATION_ACM_SCAN_FAIL
        )
    {
        return;
    }
    let waiter = &*(ctx as *const ScanWaiter);
    let guid = d.interface_guid.to_string();
    if let Ok(mut p) = waiter.pending.lock() {
        p.retain(|g| *g != guid);
        if p.is_empty() {
            waiter.done.notify_all();
        }
    }
}

fn now_filetime() -> u64 {
    let mut ft = 0u64;
    unsafe { GetSystemTimeAsFileTime(&mut ft) };
    ft
}

/// 触发一次扫描并读取 BSS 列表。`wait` 是等扫描完成的**上限**；
/// 驱动提前报 scan_complete 就提前返回。扫全部网卡。
pub fn scan(wait: Duration) -> Result<Vec<AccessPoint>> {
    scan_on(wait, None)
}

/// 只扫一块网卡（`iface_guid` 是 `Guid` 的 Display 文本）；传 `None` 等于 `scan`。
/// 指定的 GUID 不存在时退回扫全部，而不是报错——网卡被拔掉后设置里残留的 GUID 不该把扫描卡死。
pub fn scan_on(wait: Duration, iface_guid: Option<&str>) -> Result<Vec<AccessPoint>> {
    // waiter 必须比 client 活得久：client 先 drop（WlanCloseHandle 会等在途回调结束），waiter 后 drop
    let waiter = Arc::new(ScanWaiter {
        pending: Mutex::new(Vec::new()),
        done: Condvar::new(),
    });
    let client = Client::open()?;
    let mut ifaces = interfaces()?;
    if ifaces.is_empty() {
        return Err(WlanError::NoInterfaces);
    }
    if let Some(want) = iface_guid
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
    {
        let picked: Vec<InterfaceInfo> = ifaces
            .iter()
            .filter(|i| i.guid.to_string() == want)
            .cloned()
            .collect();
        if !picked.is_empty() {
            ifaces = picked;
        }
    }

    *waiter.pending.lock().unwrap() = ifaces.iter().map(|i| i.guid.to_string()).collect();
    let registered = unsafe {
        WlanRegisterNotification(
            client.handle,
            WLAN_NOTIFICATION_SOURCE_ACM,
            1,
            Some(on_wlan_notification),
            Arc::as_ptr(&waiter) as *mut c_void,
            std::ptr::null(),
            std::ptr::null_mut(),
        )
    } == 0;

    let mut all: Vec<AccessPoint> = Vec::new();
    for iface in &ifaces {
        let code = unsafe {
            WlanScan(
                client.handle,
                &iface.guid,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if code != 0 {
            // 这块网卡不会再发通知（比如正被别的扫描占用），别为它干等
            let g = iface.guid.to_string();
            waiter.pending.lock().unwrap().retain(|p| *p != g);
        }
    }

    if registered {
        let deadline = Instant::now() + wait;
        let mut pending = waiter.pending.lock().unwrap();
        while !pending.is_empty() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            pending = waiter.done.wait_timeout(pending, left).unwrap().0;
        }
        drop(pending);
        unsafe {
            WlanRegisterNotification(
                client.handle,
                WLAN_NOTIFICATION_SOURCE_NONE,
                1,
                None,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
            )
        };
    } else {
        std::thread::sleep(wait);
    }

    for iface in &ifaces {
        for ap in read_bss_list(&client, iface)? {
            all.push(ap);
        }
    }
    Ok(dedup_by_bssid(all))
}

/// 多块网卡同时扫描时，同一个 BSSID 会被每块网卡各报告一次（信号略有差别），
/// 界面上就成了同名、同信道的两条。按 BSSID 合并，保留信号最强的那条；顺序按首次出现。
fn dedup_by_bssid(all: Vec<AccessPoint>) -> Vec<AccessPoint> {
    let mut out: Vec<AccessPoint> = Vec::with_capacity(all.len());
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for ap in all {
        let key = ap.bssid.to_ascii_lowercase();
        match index.get(&key) {
            Some(&i) => {
                if ap.rssi_dbm > out[i].rssi_dbm {
                    out[i] = ap;
                }
            }
            None => {
                index.insert(key, out.len());
                out.push(ap);
            }
        }
    }
    out
}

/// 每块网卡的当前连接；没连上的网卡不出现在结果里。
pub fn current_connections() -> Result<Vec<Connection>> {
    let client = Client::open()?;
    let ifaces = interfaces()?;
    let mut out = Vec::new();
    for iface in &ifaces {
        let mut size = 0u32;
        let mut p: *const c_void = std::ptr::null();
        let mut vt = 0u32;
        let code = unsafe {
            WlanQueryInterface(
                client.handle,
                &iface.guid,
                WLAN_INTF_OPCODE_CURRENT_CONNECTION,
                std::ptr::null(),
                &mut size,
                &mut p,
                &mut vt,
            )
        };
        if code == ERROR_INVALID_STATE || p.is_null() {
            continue;
        }
        if code != 0 {
            return Err(WlanError::Api {
                call: "WlanQueryInterface",
                code,
            });
        }
        let owned = OwnedPtr(p as *const WlanConnectionAttributes);
        if (size as usize) < std::mem::size_of::<WlanConnectionAttributes>() {
            continue;
        }
        let c = unsafe { &*owned.0 };
        if c.is_state != 1 {
            continue;
        }
        let a = &c.wlan_association_attributes;
        let s = &c.wlan_security_attributes;
        out.push(Connection {
            interface_guid: iface.guid.to_string(),
            interface: iface.description.clone(),
            state: iface.state_label(),
            profile: decode_utf16(&c.str_profile_name),
            ssid: ssid_text(&a.dot11_ssid),
            bssid: mac_text(&a.dot11_bssid),
            phy: Phy::from_raw(a.dot11_phy_type),
            quality: a.wlan_signal_quality,
            rx_mbps: a.ul_rx_rate as f32 / 1000.0,
            tx_mbps: a.ul_tx_rate as f32 / 1000.0,
            auth: auth_name(s.dot11_auth_algorithm),
            cipher: cipher_algo_name(s.dot11_cipher_algorithm),
            one_x: s.b_one_x_enabled != 0,
            security_enabled: s.b_security_enabled != 0,
        });
    }
    Ok(out)
}

fn read_bss_list(client: &Client, iface: &InterfaceInfo) -> Result<Vec<AccessPoint>> {
    let mut p: *const WlanBssList = std::ptr::null();
    let code = unsafe {
        WlanGetNetworkBssList(
            client.handle,
            &iface.guid,
            std::ptr::null(),
            DOT11_BSS_TYPE_ANY,
            0,
            std::ptr::null(),
            &mut p,
        )
    };
    if code != 0 {
        return Err(WlanError::Api {
            call: "WlanGetNetworkBssList",
            code,
        });
    }
    let owned = OwnedPtr(p);
    let list = unsafe { &*owned.0 };
    let count = list.dw_number_of_items as usize;
    let entry_size = std::mem::size_of::<WlanBssEntry>();

    let hal = size_of::<WlanBssList>() - size_of::<WlanBssEntry>(); // 8 字节头
    let buf_base = owned.0 as *const u8;
    let entries_base = std::ptr::addr_of!(list.wlan_bss_entries) as *const WlanBssEntry;
    let total = list.dw_total_size as usize;
    let whole = unsafe { std::slice::from_raw_parts(buf_base, total) };
    // 正规路径：ulIeOffset 相对本条目起点。备用路径：IE 池紧跟定长条目数组，
    // 每块 IE 之后按 8 字节对齐累加，再在附近搜一段合法 IE 链（应付不按文档填 offset 的驱动）。
    let mut pool_offset = hal + count * entry_size;
    let now_ft = now_filetime();

    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let e = unsafe { &*entries_base.add(i) };
        let ie_size = e.ul_ie_size as usize;
        let mut ies = Ies {
            security: if e.us_capability_information & 0x0010 != 0 { Security::Wep } else { Security::Open },
            akm: Vec::new(),
            cipher: None,
            width_mhz: 20,
            station_count: None,
            channel_utilization: None,
        };
        if ie_size > 0 {
            let entry_off = hal + i * entry_size;
            let by_spec = entry_off + e.ul_ie_offset as usize;
            let (start_off, how) = if is_ie_chain(whole, by_spec, ie_size) {
                (Some(by_spec), "spec")
            } else {
                (find_ie_start(whole, pool_offset, ie_size), "fallback")
            };
            if let Some(o) = start_off {
                let blob = &whole[o..o + ie_size];
                ies = parse_ies(blob, e.ul_ch_center_frequency / 1000, e.us_capability_information);
                if std::env::var_os("WLAN_IE_DUMP").is_some() {
                    eprintln!(
                        "[ie] #{i} {} ieSize={ie_size} spec={by_spec} model={pool_offset} used={o}({how}) ids={:?}",
                        ssid_text(&e.dot11_ssid),
                        ie_ids(blob)
                    );
                }
            }
            pool_offset = (pool_offset + ie_size + 7) & !7usize;
        }

        // ullHostTimestamp 是 FILETIME；超过 1 天或在未来说明驱动没按约定填，不采信
        let age_ms = now_ft
            .checked_sub(e.ull_host_timestamp)
            .filter(|_| e.ull_host_timestamp != 0)
            .map(|d| d / 10_000)
            .filter(|ms| *ms < 86_400_000);

        let (band, channel) = band_and_channel(e.ul_ch_center_frequency);
        out.push(AccessPoint {
            ssid: ssid_text(&e.dot11_ssid),
            bssid: mac_text(&e.dot11_bssid),
            rssi_dbm: e.l_rssi,
            quality: e.u_link_quality,
            freq_mhz: e.ul_ch_center_frequency / 1000,
            band,
            channel,
            phy: Phy::from_raw(e.dot11_bss_phy_type),
            width_mhz: ies.width_mhz,
            security: ies.security,
            akm: ies.akm,
            cipher: ies.cipher,
            beacon_interval: e.us_beacon_period,
            in_reg_domain: e.b_in_reg_domain != 0,
            station_count: ies.station_count,
            channel_utilization: ies.channel_utilization,
            ie_bytes: ie_size,
            interface: iface.description.clone(),
            age_ms,
        });
    }
    Ok(out)
}

/// 找一块 IE 的起点：先信模型位置，不合格就在它附近 ±64 字节内搜一段
/// 「以 SSID(0) 开头、TLV 链刚好走完 ie_size 字节」的合法链。
fn find_ie_start(buf: &[u8], expected: usize, ie_size: usize) -> Option<usize> {
    let ok = |o: usize| is_ie_chain(buf, o, ie_size);
    if ok(expected) {
        return Some(expected);
    }
    let lo = expected.saturating_sub(64);
    let hi = (expected + 64).min(buf.len());
    (lo..hi).find(|&o| ok(o))
}

/// `buf[o..o+ie_size]` 是不是一段「以 SSID(0) 开头、TLV 刚好走完」的合法 IE 链
fn is_ie_chain(buf: &[u8], o: usize, ie_size: usize) -> bool {
    if o < 8 || o.checked_add(ie_size).is_none_or(|end| end > buf.len()) {
        return false;
    }
    let b = &buf[o..o + ie_size];
    b.len() >= 2 && b[0] == 0 && ie_end(b) == Some(ie_size)
}

/// IE 链走完时的位置（诊断用：合法链应该正好等于 blob 长度）；越界或不整齐返回 None
fn ie_end(blob: &[u8]) -> Option<usize> {
    let mut i = 0usize;
    while i + 2 <= blob.len() {
        let len = blob[i + 1] as usize;
        if i + 2 + len > blob.len() {
            return None;
        }
        i += 2 + len;
    }
    if i == blob.len() {
        Some(i)
    } else {
        None
    }
}

/// IE 链的 id 列表（诊断用：能看出这段字节到底是不是一段合法的 IE）
fn ie_ids(blob: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    let mut i = 0usize;
    while i + 2 <= blob.len() {
        let id = blob[i];
        let len = blob[i + 1] as usize;
        if i + 2 + len > blob.len() {
            v.push(0xFF); // 越界：说明不是合法 IE 链
            break;
        }
        v.push(id);
        i += 2 + len;
    }
    v
}

/// SSID 原样返回；隐藏网络的 SSID 长度就是 0，这里**返回空字符串**，不返回 "<hidden>" 这种展示文案。
/// 展示层按当前语言自己决定写 `<hidden>` / `<隐藏>`，而「不显示隐藏 SSID」这类过滤
/// 靠的是 `ssid.is_empty()`——以前这里返回字面量 "<hidden>"（非空），过滤永远不命中。
fn ssid_text(s: &Dot11Ssid) -> String {
    let len = (s.u_ssid_length as usize).min(32);
    let raw = &s.uc_ssid[..len];
    if raw.iter().all(|b| *b == 0) {
        return String::new();
    }
    match std::str::from_utf8(raw) {
        Ok(s) => s.trim_end_matches('\u{0}').to_string(),
        Err(_) => String::from_utf8_lossy(raw).trim_end_matches('\u{0}').to_string(),
    }
}

fn mac_text(m: &[u8; 6]) -> String {
    format!(
        "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        m[0], m[1], m[2], m[3], m[4], m[5]
    )
}

pub fn interface_id(g: &Guid) -> String {
    guid_to_string(g)
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼 IE 链：SSID 打头，后面跟给定的 (id, body)
    fn ies(items: &[(u8, &[u8])]) -> Vec<u8> {
        let mut v = vec![0u8, 4, b't', b'e', b's', b't'];
        for (id, body) in items {
            v.push(*id);
            v.push(body.len() as u8);
            v.extend_from_slice(body);
        }
        v
    }

    const RATES: &[u8] = &[0x96, 0x82, 0x84, 0x8b]; // 首字节带 0x10 位，旧代码会误判 WEP

    #[test]
    fn supported_rates_is_not_capability() {
        let b = ies(&[(1, RATES)]);
        assert_eq!(parse_ies(&b, 2437, 0x0401).security, Security::Open);
    }

    #[test]
    fn privacy_bit_without_rsn_is_wep() {
        let b = ies(&[(1, RATES)]);
        assert_eq!(parse_ies(&b, 2437, 0x0411).security, Security::Wep);
    }

    fn rsn(pairwise: &[u8], akm: &[u8], group: u8) -> Vec<u8> {
        let mut v = vec![1, 0, 0x00, 0x0f, 0xac, group];
        v.extend_from_slice(&(pairwise.len() as u16).to_le_bytes());
        for p in pairwise {
            v.extend_from_slice(&[0x00, 0x0f, 0xac, *p]);
        }
        v.extend_from_slice(&(akm.len() as u16).to_le_bytes());
        for a in akm {
            v.extend_from_slice(&[0x00, 0x0f, 0xac, *a]);
        }
        v.extend_from_slice(&[0, 0]);
        v
    }

    #[test]
    fn mixed_mode_shows_strongest_pairwise_cipher() {
        let r = rsn(&[2, 4], &[2], 2);
        let p = parse_ies(&ies(&[(48, &r)]), 2437, 0x0411);
        assert_eq!(p.security, Security::Wpa2);
        assert_eq!(p.cipher, Some("CCMP"));
    }

    #[test]
    fn gcmp_suite_numbers() {
        let r = rsn(&[9], &[8], 9);
        let p = parse_ies(&ies(&[(48, &r)]), 5955, 0x0411);
        assert_eq!(p.cipher, Some("GCMP-256"));
        assert_eq!(p.security, Security::Wpa3);
    }

    #[test]
    fn sae_ext_key_is_wpa3() {
        let r = rsn(&[4], &[24], 4);
        assert_eq!(parse_ies(&ies(&[(48, &r)]), 5955, 0x0411).security, Security::Wpa3);
        let r = rsn(&[4], &[2, 24], 4);
        assert_eq!(parse_ies(&ies(&[(48, &r)]), 5180, 0x0411).security, Security::Wpa2Wpa3);
    }

    // HT Operation：primary=36，info 字节 = 偏移 | STA width 位
    fn ht_op(info: u8) -> Vec<u8> {
        let mut v = vec![36, info];
        v.extend_from_slice(&[0; 20]);
        v
    }

    #[test]
    fn ht_capability_alone_is_20mhz() {
        // 只有 HT Capabilities 说支持 40，HT Operation 没开次信道 → 20
        let b = ies(&[(45, &[0x02, 0x00]), (61, &ht_op(0x00))]);
        assert_eq!(parse_ies(&b, 2437, 0).width_mhz, 20);
    }

    #[test]
    fn ht_operation_40() {
        let b = ies(&[(61, &ht_op(0x05))]);
        assert_eq!(parse_ies(&b, 2437, 0).width_mhz, 40);
    }

    #[test]
    fn vht_capabilities_do_not_set_width() {
        // VHT Capabilities 的 Supported Channel Width Set=0（=支持 80），旧代码会映射成 40
        let b = ies(&[(61, &ht_op(0x05)), (191, &[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), (192, &[1, 42, 0, 0, 0])]);
        assert_eq!(parse_ies(&b, 5180, 0).width_mhz, 80);
    }

    #[test]
    fn vht_operation_160_via_ccfs1() {
        let b = ies(&[(61, &ht_op(0x05)), (192, &[1, 42, 50, 0, 0])]);
        assert_eq!(parse_ies(&b, 5180, 0).width_mhz, 160);
        let b = ies(&[(61, &ht_op(0x05)), (192, &[0, 0, 0, 0, 0])]);
        assert_eq!(parse_ies(&b, 5180, 0).width_mhz, 40);
    }

    #[test]
    fn he_6ghz_operation_info() {
        // params bit17 置位：6 GHz Op Info 在 MCS 之后；control=2 → 80
        let he = [36u8, 0x00, 0x00, 0x02, 0x00, 0xfc, 0xff, 37, 0x02, 39, 0, 6];
        assert_eq!(parse_ies(&ies(&[(255, &he)]), 6135, 0).width_mhz, 80);
        // 同时带 VHT Op Info（bit14）时偏移要跳 3 字节
        let he = [36u8, 0x00, 0x40, 0x02, 0x00, 0xfc, 0xff, 0, 0, 0, 37, 0x03, 39, 47, 6];
        assert_eq!(parse_ies(&ies(&[(255, &he)]), 6135, 0).width_mhz, 160);
    }

    #[test]
    fn eht_320_only_in_6ghz() {
        let eht = [106u8, 0x01, 0, 0, 0, 0, 0x04, 31, 63];
        assert_eq!(parse_ies(&ies(&[(255, &eht)]), 6135, 0).width_mhz, 320);
        assert_eq!(parse_ies(&ies(&[(255, &eht)]), 5180, 0).width_mhz, 160);
    }

    #[test]
    fn channel_numbers_no_underflow() {
        assert_eq!(band_and_channel(2_412_000), (Band::B24, Some(1)));
        assert_eq!(band_and_channel(2_484_000), (Band::B24, Some(14)));
        assert_eq!(band_and_channel(2_400_000).0, Band::B24);
        assert_eq!(band_and_channel(4_920_000), (Band::B5, Some(184)));
        assert_eq!(band_and_channel(5_180_000), (Band::B5, Some(36)));
        assert_eq!(band_and_channel(5_885_000), (Band::B5, Some(177)));
        assert_eq!(band_and_channel(5_935_000), (Band::B6, Some(2)));
        assert_eq!(band_and_channel(5_955_000), (Band::B6, Some(1)));
        assert_eq!(band_and_channel(7_115_000), (Band::B6, Some(233)));
        assert_eq!(band_and_channel(5_930_000).0, Band::B6);
    }
}
