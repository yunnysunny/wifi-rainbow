//! Windows Native Wifi 数据层。
//!
//! 直接 FFI 调 `wlanapi.dll`，不依赖任何 crate：
//! `WlanOpenHandle` → `WlanEnumInterfaces` → `WlanScan` → `WlanGetNetworkBssList`
//!
//! 两个已实测的关键点（Intel AX200 / Win11）：
//! 1. `WLAN_BSS_ENTRY` 定长 360 字节，条目数组之后紧跟 IE 池，按条目顺序 **8 字节**对齐累加。
//! 2. 驱动返回的 `ulIeOffset` 不可信，不能按它去取 IE。
//!
//! 信道宽度与安全等级不在 API 字段里，必须自己解析 IE（HT / VHT / HE / RSN / WPA）。

use std::ffi::c_void;
use std::fmt;
use std::time::Duration;

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

fn cipher_name(suite: u8) -> &'static str {
    match suite {
        1 => "WEP-40",
        2 => "TKIP",
        4 => "CCMP",
        5 => "WEP-104",
        8 => "GCMP-256",
        9 => "GCMP-128",
        _ => "?",
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
        _ => "?",
    }
}

fn le16(b: &[u8], pos: usize) -> Option<u16> {
    b.get(pos..pos + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}

fn le32(b: &[u8], pos: usize) -> Option<u32> {
    b.get(pos..pos + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// RSN(48) / WPA 厂商 IE(221) 共用结构；`body` 已去掉 WPA 的 4 字节 OUI+type 头。
fn parse_rsn(body: &[u8], is_wpa1: bool, out: &mut Ies) {
    if body.len() < 6 {
        return;
    }
    let mut pos = 2; // version
    let group = body[pos + 3];
    out.cipher = Some(cipher_name(group));
    pos += 4;

    let pairwise_count = le16(body, pos).unwrap_or(0) as usize;
    pos += 2 + 4 * pairwise_count;

    let akm_count = le16(body, pos).unwrap_or(0) as usize;
    pos += 2;
    for i in 0..akm_count {
        if let Some(suite) = body.get(pos + i * 4 + 3) {
            out.akm.push(akm_name(*suite));
        }
    }

    let akm = &out.akm;
    let has_sae = akm.contains(&"SAE") || akm.contains(&"FT-SAE");
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

fn parse_ies(blob: &[u8], freq_mhz: u32) -> Ies {
    let mut out = Ies {
        security: Security::Open,
        akm: Vec::new(),
        cipher: None,
        width_mhz: 20,
        station_count: None,
        channel_utilization: None,
    };
    let mut vht: Option<u16> = None;
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
            // Capability Information 里的 Privacy 位：给 WEP 一个兜底判据
            1 if len >= 2 => {
                let cap = u16::from_le_bytes([body[0], body[1]]);
                if cap & 0x10 != 0 && out.security == Security::Open {
                    out.security = Security::Wep;
                }
            }
            // BSS Load：连接数 + 信道利用率，可做"空口拥堵"
            11 if len >= 5 => {
                out.station_count = le16(body, 0);
                out.channel_utilization = body.get(2).copied();
            }
            45 if len >= 2 => {
                let info = le16(body, 0).unwrap_or(0);
                if info & 0x0002 != 0 {
                    out.width_mhz = out.width_mhz.max(40);
                }
            }
            48 => rsn = Some(body),
            191 if len >= 4 && freq_mhz >= 4900 => {
                let info = le32(body, 0).unwrap_or(0);
                let cw = (info >> 2) & 0x3;
                vht = Some(match cw {
                    1 => 80,
                    2 | 3 => 160,
                    _ => 40,
                });
            }
            221 if len >= 8 && body[..4] == [0x00, 0x50, 0xf2, 0x01] => wpa1 = Some(&body[4..]),
            // HE Operation(255/ext 36)：6GHz Operation Information 只对 6 GHz 有效
            255 if len >= 6 && body[0] == 36 && freq_mhz >= 5925 => {
                if let Some(w) = body.get(5) {
                    let cw = (w >> 1) & 0x3;
                    out.width_mhz = out.width_mhz.max(match cw {
                        1 => 40,
                        2 => 80,
                        3 => 160,
                        _ => 20,
                    });
                }
            }
            _ => {}
        }
        i += 2 + len;
    }

    // RSN 优先；只有没有 RSN 时才退回 WPA1 厂商 IE（很多 AP 两个都发，双解析会造成 AKM 重复）
    if let Some(body) = rsn {
        parse_rsn(body, false, &mut out);
    } else if let Some(body) = wpa1 {
        parse_rsn(body, true, &mut out);
    }

    if let Some(w) = vht {
        out.width_mhz = out.width_mhz.max(w);
    }
    // 按频段封顶：2.4 GHz 不存在 80/160，6 GHz 没有 40 以下的 HE 宽信道
    out.width_mhz = match freq_mhz {
        0..=2499 => out.width_mhz.min(40),
        2500..=5924 => out.width_mhz.min(160),
        _ => out.width_mhz.min(160),
    };
    out
}

fn band_and_channel(freq_khz: u32) -> (Band, Option<u16>) {
    let mhz = freq_khz / 1000;
    match mhz {
        2400..=2499 => (Band::B24, Some(if mhz == 2484 { 14 } else { ((mhz - 2407) / 5) as u16 })),
        4900..=5899 => (Band::B5, Some(((mhz - 5000) / 5) as u16)),
        5900..=7199 => (Band::B6, Some(((mhz - 5950) / 5) as u16)),
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

/// 触发一次扫描并读取 BSS 列表。`wait` 是发起扫描后等待驱动回报的时间。扫全部网卡。
pub fn scan(wait: Duration) -> Result<Vec<AccessPoint>> {
    scan_on(wait, None)
}

/// 只扫一块网卡（`iface_guid` 是 `Guid` 的 Display 文本）；传 `None` 等于 `scan`。
/// 指定的 GUID 不存在时退回扫全部，而不是报错——网卡被拔掉后设置里残留的 GUID 不该把扫描卡死。
pub fn scan_on(wait: Duration, iface_guid: Option<&str>) -> Result<Vec<AccessPoint>> {
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

    let mut all: Vec<AccessPoint> = Vec::new();
    for iface in &ifaces {
        unsafe {
            WlanScan(
                client.handle,
                &iface.guid,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
    }
    std::thread::sleep(wait);

    for iface in &ifaces {
        for ap in read_bss_list(&client, iface)? {
            all.push(ap);
        }
    }
    Ok(all)
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
    // IE 池紧跟定长条目数组；每块 IE 之后按 **8 字节** 对齐（不是 4，之前按 4 累加，
    // 从第一个奇数长度的块起就错位，后几个 AP 的 RSN IE 全读不到 → 安全方式误报 OPEN）。
    // ulIeOffset 依然不可信（AX200 上返回的值跟实际位置无关）。
    let mut pool_offset = hal + count * entry_size;

    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let e = unsafe { &*entries_base.add(i) };
        let ie_size = e.ul_ie_size as usize;
        let mut ies = Ies {
            security: Security::Open,
            akm: Vec::new(),
            cipher: None,
            width_mhz: 20,
            station_count: None,
            channel_utilization: None,
        };
        if ie_size > 0 {
            // 先按模型位置取；万一哪天布局又变了，在附近搜一段长度刚好吻合的合法 IE 链
            let start_off = find_ie_start(whole, pool_offset, ie_size);
            if let Some(o) = start_off {
                let blob = &whole[o..o + ie_size];
                ies = parse_ies(blob, e.ul_ch_center_frequency / 1000);
                if std::env::var_os("WLAN_IE_DUMP").is_some() {
                    eprintln!(
                        "[ie] #{i} {} ieSize={ie_size} model={pool_offset} used={o} ids={:?}",
                        ssid_text(&e.dot11_ssid),
                        ie_ids(blob)
                    );
                }
            }
            pool_offset = (pool_offset + ie_size + 7) & !7usize;
        }

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
        });
    }
    Ok(out)
}

/// 找一块 IE 的起点：先信模型位置，不合格就在它附近 ±64 字节内搜一段
/// 「以 SSID(0) 开头、TLV 链刚好走完 ie_size 字节」的合法链。
fn find_ie_start(buf: &[u8], expected: usize, ie_size: usize) -> Option<usize> {
    let ok = |o: usize| -> bool {
        if o + ie_size > buf.len() || o < 8 {
            return false;
        }
        let b = &buf[o..o + ie_size];
        b.len() >= 2 && b[0] == 0 && ie_end(b) == Some(ie_size)
    };
    if ok(expected) {
        return Some(expected);
    }
    let lo = expected.saturating_sub(64);
    let hi = (expected + 64).min(buf.len());
    (lo..hi).find(|&o| ok(o))
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
