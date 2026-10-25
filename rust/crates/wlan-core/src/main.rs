use std::time::Duration;

use wlan_core::Band;

fn main() {
    let wait = std::env::args()
        .nth(1)
        .and_then(|s| s.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(2500));

    match wlan_core::interfaces() {
        Ok(ifaces) => {
            println!("== 无线网卡 ==");
            for i in &ifaces {
                println!("  {}  [{}]  {}", i.guid, i.state_label(), i.description);
            }
        }
        Err(e) => {
            eprintln!("枚举网卡失败: {e}");
            std::process::exit(1);
        }
    }

    match wlan_core::current_connections() {
        Ok(conns) if conns.is_empty() => println!("  （没有已连接的网卡）"),
        Ok(conns) => {
            println!("== 当前连接 ==");
            for c in &conns {
                println!(
                    "  {} {} [{}] {} q={}% rx={:.1} tx={:.1} Mbps auth={} cipher={} 802.1X={}",
                    c.ssid,
                    c.bssid,
                    c.phy.label(),
                    c.interface,
                    c.quality,
                    c.rx_mbps,
                    c.tx_mbps,
                    c.auth,
                    c.cipher,
                    c.one_x
                );
            }
        }
        Err(e) => eprintln!("读取当前连接失败: {e}"),
    }

    // WLAN_IFACE=<guid> 只扫一块网卡（与 UI 设置里的「扫描网卡」同一条路径）
    let iface_filter = std::env::var("WLAN_IFACE").ok();
    let aps = match wlan_core::scan_on(wait, iface_filter.as_deref()) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("扫描失败: {e}");
            std::process::exit(1);
        }
    };

    let mut aps = aps;
    aps.sort_by_key(|a| -a.rssi_dbm);
    aps.dedup_by(|a, b| a.bssid == b.bssid);

    println!("\n== BSS 列表：{} 个 ==", aps.len());
    println!(
        "{:<20}{:<18}{:>5}{:>4}{:>5}{:>9}{:>6}{:>10}  {:<14}AKM",
        "SSID", "BSSID", "dBm", "Q%", "CH", "频段", "带宽", "PHY", "安全"
    );
    println!("{}", "-".repeat(110));
    for a in &aps {
        println!(
            "{:<20}{:<18}{:>5}{:>4}{:>5}{:>9}{:>6}{:>10}  {:<14}{}",
            truncate(if a.ssid.is_empty() { "<hidden>" } else { &a.ssid }, 19),
            a.bssid,
            a.rssi_dbm,
            a.quality,
            a.channel.map(|c| c.to_string()).unwrap_or_else(|| "-".into()),
            a.band.label(),
            a.width_mhz,
            a.phy.label(),
            a.security.label(),
            if a.akm.is_empty() { "-".to_string() } else { a.akm.join(",") }
        );
        let _ = &a.station_count;
        let _ = &a.channel_utilization;
    }

    let b24 = aps.iter().filter(|a| a.band == Band::B24).count();
    let b5 = aps.iter().filter(|a| a.band == Band::B5).count();
    let b6 = aps.iter().filter(|a| a.band == Band::B6).count();
    println!("\n== 频段分布 == 2.4 GHz:{b24}  5 GHz:{b5}  6 GHz:{b6}");
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}
