# Privacy Policy · 隐私政策

WiFi Rainbow (WiFi 彩虹) · last updated 2026-10-26

## English

WiFi Rainbow is a local Wi-Fi analyzer. It does not collect, store remotely, share or sell any personal data.

- **No network access.** The program makes no network connections of its own and sends no information to the developer or to any third party. There is no telemetry, analytics, advertising or crash reporting.
- **What it reads.** Through the Windows Native Wifi API it reads the wireless networks your adapter can see (network names / SSIDs, access point MAC addresses / BSSIDs, signal strength, channel, security settings) and the state of your own connection. Windows treats nearby access point addresses as location-related information, so the Microsoft Store package declares the *location* capability and Windows may ask for your consent. This data is only shown on your screen; it never leaves your computer.
- **What it stores locally.** Settings, network aliases and the watch list are kept in the program's local WebView2 profile. A diagnostic UI log is written to `%LOCALAPPDATA%\WiFiRainbow\ui.log` (for the Store version, inside the app's private package folder). Uninstalling removes them.
- **Exports.** CSV and PNG exports are written only to a location on your computer (your Downloads folder by default). What you do with them is up to you.
- **Children.** The program collects no data from anyone, including children.

Questions: open an issue at <https://github.com/yunnysunny/wifi-rainbow/issues>.

## 中文

WiFi 彩虹是一个本地运行的 Wi-Fi 分析工具，不收集、不上传、不共享、不出售任何个人数据。

- **不联网。** 程序自身不建立任何网络连接，不向开发者或任何第三方发送信息；没有遥测、统计、广告或崩溃上报。
- **读取哪些信息。** 通过 Windows 自带的 Native Wifi API 读取网卡能看到的无线网络（网络名 SSID、接入点 MAC 地址 BSSID、信号强度、信道、安全设置）以及本机当前的连接状态。Windows 把附近接入点的地址视为与位置相关的信息，因此微软商店版本声明了「位置」能力，系统可能会请求你的授权。这些数据只显示在你的屏幕上，不会离开你的电脑。
- **本地保存哪些内容。** 设置、网络别名和关注列表保存在程序本机的 WebView2 用户数据里；界面诊断日志写在 `%LOCALAPPDATA%\WiFiRainbow\ui.log`（商店版位于应用的私有包目录内）。卸载时一并删除。
- **导出。** CSV 和 PNG 导出只写到你电脑上的位置（默认是「下载」文件夹），之后如何使用由你决定。
- **儿童。** 程序不收集任何人的数据，包括儿童。

有疑问请在 <https://github.com/yunnysunny/wifi-rainbow/issues> 提 issue。
