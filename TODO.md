# WiFi 彩虹（WiFi Rainbow）· 待做

> 这份是唯一的口径：想做什么、先做什么、怎么验收。
> 最后更新：2026-10-24 23:30

## 0. 现在在哪儿

能用的：概览 / Inspector（三频段弧形图 + 3 分钟信号历史 / 变更事件 + 可排序筛选、**可按路由分组**的 AP 表）、信道视图（频谱占用 + 同/邻频重叠 + CIR + 候选信道评分）、AP 详情抽屉（含**当前连接实况**、别名、关注）、设置（隐藏 SSID / 最低信号 / 频段开关 / 刷新间隔 / 扫描网卡 / 分组 / 关注列表 / 别名 / 中英双语）、CSV / PNG 导出。

数据层：`wlanapi` 零依赖 FFI，字段到 IE 级（HT/VHT/HE/RSN/Cipher、BSS Load），另加 `WlanQueryInterface(current_connection)` 拿实际协商的 AKM/cipher/速率。2026-10-24 抓到并修掉一个从第一天就在的解析 bug——IE 块是 8 字节对齐而不是 4 字节。

已验证（2026-10-24 23:11，AX200 / Win11 / 300% 缩放）：`cargo build` 干净；selftest **十五类**探针全过（信道、详情、布局几何、浮层定位、弧形遮挡、双语切换、设置逐项、**分组、变更追踪、事件面板、已连接、视图状态、别名+关注、导出**、放大预览）；`current_connection` 与 `netsh wlan show interfaces` 逐字段一致（WPA3-Personal / CCMP / 866.7 Mbps / 99%）；截图肉眼核对了分组、事件面板、连接抽屉、英文界面四个状态。

### 2026-10-25 修的 bug

- **启动时设置没同步到界面**（v0.1.0 装上就能看到）：`groupBy` 默认 `ssid`，但顶栏「按 SSID 分组」复选框只在打开设置页或改动设置时才同步，启动后显示未勾选、表格却在分组；同一根因让已保存的「自动刷新间隔」在启动时不生效（`Inspector.init` 先于 `Settings.init` 跑，定时器读到的是默认 5 秒）。修法：`app.js` 里先 `Settings.init()` 再 `Inspector.init()`，`Settings.init()` 结束时立即 `render()`。selftest 加 `startup` 探针；`persist` 停靠模式留一组非默认设置供下一次启动核对。

### 2026-10-24 这一轮做掉的

| 项 | 做法 | 验收 |
|---|---|---|
| 1.1 分组 + 别名 + 折叠 | 不是按 SSID 字符串精确分组——本机实情是 `sgreat` / `sgreat-5g`、`sunnywifi` / `sunnywifi_5G` 这种**不同字符串**。归并条件取并集：去掉频段后缀后 SSID 相同 **或** BSSID 前 5 字节相同；组名取最短 SSID；隐藏 SSID 单独成组；只有 1 个 BSSID 的具名 SSID 不成组。组行显示信道 `1 / 36`、最强…最弱、频段、带宽、PHY、安全、客户端合计、空口最大值；点组行展开/折叠，展开集合持久化。别名在详情抽屉里起，按 SSID 存 localStorage，过滤词也能匹配别名 | selftest `group`：组数 + 各组成员和 + 单行数 = 可见 AP 数；折叠/展开后 DOM 行数各自对得上；组行高度 31、列对齐 delta 全 0；点击组行真能折叠。实测 13 个 BSS 折成 5 组 + 4 单行 |
| 1.2 变更追踪 | `ui/changes.js` 纯数据模块：新增 / 消失（连续 2 轮没扫到）/ 掉信号 / 换信道 / 换带宽。掉信号的口径被真机数据逼着改了两次：AX200 上同一 AP 两轮之间 -22/-39 来回跳是常态，所以 ① 基线取最近 3 次均值 ② **连续两轮**低于基线 7 dB 才报 ③ 同一 BSSID 60 秒最多报一次。表格行打 25 秒的标记，历史区可切到「事件」列表（最近 20 条，点一条开抽屉） | selftest `changes`：构造序列断言各类计数、-6 不算 / -7 算、-22/-39 抖动 0 次、真掉 1 次；Node 下也可单独跑 |
| 2.1 已连接实况 | Rust `current_connections()`（`WlanQueryInterface` opcode 7）；表格行 / 组行 / 弧顶小圆点 / 网卡栏都标「已连接」；抽屉里单开一块：实际认证、实际加密、收发速率、链路质量、连接时长（前端从首次观察到起算）、配置文件 | selftest `conn`：BSSID 在扫描列表里、行有标记、抽屉文案含 auth/cipher/速率 |
| 2.2 视图状态持久化 | 排序键/方向、过滤词、展开的组、历史区面板 → `wifisurvey.view.v1` | selftest `viewstate` |
| 2.3 导出 | 顶栏 CSV / PNG 按钮。CSV 表头跟界面一致 + 别名/已连接/厂商/频率/Cipher/扫描时间六列，带 BOM；PNG 把当前视图的画布拼成一张（Inspector：三频段 + 历史；信道：三张频谱）。Rust `export_file` 写到「下载」（零依赖 base64 解码） | selftest `export`；`mode=export` 真落盘三个文件 |
| 2.4 关注列表 | 按 SSID 存；历史曲线默认集合 = 关注的全部 BSSID + 最强补齐到 6 条，用户动过图例后不再自动挑；组行 / 抽屉 ☆ 切换 | selftest `alias+watch`：加关注后下一轮扫描图例 chip 变 on |
| 3.2 多网卡 | 设置里「扫描网卡」下拉（空 = 全部）；Rust `scan_on(wait, guid)`，GUID 不在了退回全部；`wlanscan` 支持 `WLAN_IFACE=` | 本机只有一块卡，**多卡路径没真机验过** |
| 3.4 扫描失败重试 | 连续失败按 2s/4s/8s…60s 退避（自动刷新的 tick 在退避期内跳过，手动点不受限）；状态栏变红可点开错误详情 | 代码路径有了，**没构造出真实失败**（拔网卡 / 禁用服务）验过 |
| 4.3 日志轮转 | `ui.log` 过 1 MiB 轮转成 `ui.log.1`（留一代） | 代码路径 |
| 4.1 安装包 | `cargo tauri build` → NSIS 按用户安装包，产品名 `WiFi Rainbow` | 静默装 / 启动 / 静默卸全过，见第 6 节打包记录 |

---

## 1. P0 · 直接影响日常可用性

（都做完了，见上表。）

## 2. P1 · 体验打磨

- **2.5 列显隐**：现在 13 列全铺开，300% 缩放下要横向滚。给表头加右键 / 设置页加列开关，存进视图状态。
- **2.6 图例溢出**：历史区图例最多 14 个 chip，两行就被 `max-height: 42px` 裁掉——要么只给一行 + 「更多」，要么分组模式下图例也按组折。
- **2.7 掉信号口径再看一轮**：现在的三道门（均值基线 / 连续两轮 / 60 秒冷却）是按 AX200 的抖动调的，换一块卡可能过严或过松。想法：把阈值和冷却放进设置页。
- **2.8 连接时长**：API 里没有，现在是「本工具第一次看到它处于已连接」起算，重启工具就归零。要真值得读 `WlanQueryInterface` 的 `wlan_intf_opcode_statistics` 或事件通知。

## 3. P2 · 能力补齐

- **3.1 测速**：iperf3（注意 cygwin 依赖，或用静态编译版）或自建 HTTP 测速端点；UI 上是一次性按钮 + 结果，不做长期记录。
- **3.3 6 GHz / 6E 打磨**：代码路径写了（HE Operation 的 6 GHz 字段、PSC 信道），但一条真机数据都没有——等有 6E 硬件再动。
- **3.5 长跑**：3 分钟滚动窗口 + 每 5 秒一次扫描 + 事件环形缓冲 200 条，跑 8 小时看内存/句柄曲线。

## 4. P3 · 发布与工程化

- **4.1 安装包**：2026-10-24 第一次真打了包（`cargo tauri build`，tauri-cli 2.12.4）并装/跑/卸各验了一遍，见「6. 验收工具」末尾的打包记录。剩下没验的：WebView2 缺失提示、覆盖升级、代码签名、安装器侧图。
- **4.2 单实例 + 托盘 + 开机自启**：没做。现在多开会各自扫一遍。需要 `tauri-plugin-single-instance`（crates.io 上是 `3.0.0-alpha`，跟 tauri 2.12 的配套版本要先核对）+ tauri 的 `tray-icon` 特性 + `tauri-plugin-autostart`。
- **4.4 代码签名**：2026-10-25 向 SignPath Foundation 提交申请。批准后要做：① 仓库 Secrets/Variables 填 `SIGNPATH_API_TOKEN` / `SIGNPATH_ORGANIZATION_ID` / `SIGNPATH_PROJECT_SLUG` / `SIGNPATH_SIGNING_POLICY_SLUG`；② 把下面几处「已申请、等待批准」的措辞改成「由 SignPath.io 签名」：`README.md` 下载段、`docs/README.zh-CN.md`、`docs/CODE_SIGNING_POLICY.md` 顶部状态、`docs/manual.*.md` 的 SmartScreen 段、`tools/build-docs.mjs` 的安装提示和页脚、`docs/promo.zh-CN.md`；③ 推一个新 tag 出签名包。

---

## 5. 已知风险与没验证的边界

诚实清单，别当成已完成：

| 项 | 状态 |
|---|---|
| IE 池布局 | 逆向得来：条目定长 360 字节 + 每块 IE **8 字节对齐**，另加"合法 TLV 链"校验兜底；`ulIeOffset` 依旧不用（AX200 上返回乱值）。换网卡厂商（Qualcomm / Realtek / MediaTek）必须重跑 `WLAN_IE_DUMP=1` 对照 |
| `WLAN_CONNECTION_ATTRIBUTES` 布局 | 按 wlanapi.h 手写 `repr(C)`，编译期断言 604 字节，AX200 上字段值与 netsh 一致；别的驱动没验 |
| RSSI 抖动 | AX200 对同一 AP 两轮之间报 -22 / -39（17 dB）是常态，`wlanscan` 连跑 5 次可复现。弧形图、趋势列、变更事件都会被它影响；变更事件已加三道门，弧形图和趋势列没做平滑 |
| 分组归并 | BSSID 前 5 字节相同就归一组：同一台路由的主网 + 访客网会并到一起（这是想要的），但理论上不同厂牌撞前缀的概率不是零 |
| 多网卡 | 代码路径有，零真机数据 |
| 扫描失败重试 | 代码路径有，没构造过真实失败 |
| 6 GHz | 零真机数据 |
| 高 DPI | 只在 300%（3840×2160）验过；100% / 125% / 200% 未验 |
| 窄窗 | `minWidth 480 × minHeight 380` 是设了，但没在这个尺寸下验过布局；导出按钮和分组/自动刷新开关在 ≤1040 CSS px 时隐藏 |
| 语言 | 只有中 / 英。Inspector 视图中文叫「概览」（2026-10-25 定）；频段名与 dBm/MHz/ch36 不翻译是约定 |
| 采样方式 | 轮询（Windows 无 monitor 模式），瞬时突发看不到；间隔最小值 1 秒也受扫描本身耗时（~2.2s）限制，实测 `scanSec=2` 时 6 秒内只扫 1~2 次 |
| 干扰模型 | 只看功率重叠，不建 CSMA 竞争模型；距离估算是 1m/-40dBm、n=2.7 的简化公式，只能当相对参考 |
| 导出目录 | 写死「下载」（`%USERPROFILE%\Downloads`），没有就落 `%LOCALAPPDATA%\WiFiRainbow\export`；没做「另存为」对话框（那要 `rfd`，已随 Survey 一起删掉） |

## 6. 验收工具（改完怎么证明真的对）

- **演示模式**：selftest 文件里写 `demo:<视图>`（`demo:en-<视图>` 切英文），`ui/demo.js` 用一组合成网络（30 轮、倒推 3 分钟、带脚本化事件）驱动整个界面，之后真机扫描被冻结。手册截图全靠它；`demo:cleanup` 清掉它写进 localStorage 的别名 / 关注。
- **窗口截图**：`tools/shot-window.ps1`（PrintWindow，只截主窗口，不含任务栏和输入法条；`-Scale 0.5` 给手册用）。
- **文档站**：`npm run docs` 把 `docs/manual.*.md` 转成 `site/`，Cloudflare Pages 构建命令 `npm ci && npm run docs`、输出目录 `site`。

- **selftest**：往 `%LOCALAPPDATA%\WiFiRainbow\selftest` 写一个词再启动，跑完探针后停在对应视图——`inspector` / `channels` / `detail` / `tip` / `max` / `settings` / `en` / `enset` / `nohidden` / **`group` / `events` / `conn` / `export`**。日志在 `%LOCALAPPDATA%\WiFiRainbow\ui.log`。**验完记得删掉标记文件**，否则每次启动都跑一遍。
- **探针覆盖**：`channels`（AP 数、同/邻频对、每频段标签数）、`detail`（CIR/同邻频/距离）、`layout`（`rowH` + `colDelta` 列对齐）、`tip`（浮层是否落回自己那张图）、`arcs`（哪些弧被完全套住）、`lang`（切语言后界面 chrome 里中文字符数、网卡栏文案是否卡住）、`settings`（逐项生效 + 持久化 + 设置页几何）、`group`（组数/成员和/单行数/折叠展开行数/组行几何/点击折叠）、`changes`（构造序列的事件计数与阈值边界 + 抖动 0 次 + 真掉 1 次）、`events-panel`（面板切换）、`conn`（已连接 AP 的标记与抽屉）、`viewstate`（排序/过滤/面板持久化）、`alias+watch`（别名进表格与过滤、关注进曲线）、`export`（CSV 行列数、PNG 尺寸）、`max`（放大前后画布尺寸）。
- **变更追踪单测**：`ui/changes.js` 不依赖 DOM，Node 里 `new Function(src + '; return Changes')()` 就能跑构造序列。
- **数据层对拍**：`cargo run -p wlan-core --bin wlanscan` 打表格（现在也打当前连接）；`WLAN_IE_DUMP=1` 打印每个 AP 的 IE 起点与 id 链；`WLAN_IFACE=<guid>` 只扫一块卡。
- **真值对照**：`netsh wlan show interfaces`（连接时的实际 AKM/cipher/速率，跟抽屉「当前连接」块逐项对）、`netsh wlan show networks mode=bssid`。
- **截图**：`tools/shot.ps1`（必须 DPI-aware，否则 300% 缩放下只截到左上角），截完用视觉模型逐项核对——**注意计数型探针证明不了"看得见"**，颜色算错时探针照样报"已标注"。
- **打包**：`cargo tauri build`（需要 `cargo install tauri-cli --version ^2`），产物在 `rust/target/release/bundle/nsis/`。打包记录见下。

### 打包记录（4.1）

**2026-10-24 23:30，第一次真打包并装过一遍。** 产物 `rust/target/release/bundle/nsis/WiFi-Rainbow_0.1.0_x64-setup.exe`（1.94 MiB；exe 本体 9.35 MB，thin LTO）。`productName` / `publisher` 用英文 `WiFi Rainbow`（安装包文件名由 CI 改成连字符 `WiFi-Rainbow_<版本>_x64-setup.exe`，因为 GitHub 会把资源名里的空格换成点；安装目录和注册表键是 `WiFi Rainbow`）（中文窗口标题由 `app.windows[0].title` 和 i18n 给），否则安装目录、注册表键、控制台输出里全是中文路径，排错时一团乱码。

验过的（静默 `/S` 装 → 启动 → 静默卸）：

| 项 | 结果 |
|---|---|
| 安装位置 | 按用户装到 `%LOCALAPPDATA%\WiFi Rainbow\`（`wifi-rainbow.exe` + `uninstall.exe`），不要管理员 |
| 开始菜单 / 桌面快捷方式 | 都有，`WiFi Rainbow.lnk`，目标正确 |
| 注册表 | `HKCU\...\Uninstall\WiFi Rainbow`：DisplayVersion 0.1.0、Publisher WiFi Rainbow、DisplayIcon / UninstallString 正确、EstimatedSize 9212 KB |
| 版本信息 | exe 的 FileVersion / ProductVersion 0.1.0，ProductName / CompanyName = WiFi Rainbow |
| 装好的 exe 能跑 | `ui.log` 里 boot ok，扫描、当前连接正常，窗口标题「WiFi 彩虹」 |
| 卸载 | 目录、快捷方式、注册表键全清；`%LOCALAPPDATA%\WiFiRainbow\`（日志）和 WebView2 的 localStorage 保留，这是有意的 |
| 安装器语言 | `bundle.windows.nsis.languages = ["SimpChinese","English"]`，不弹语言选择，中文系统上向导是中文（截图 `screens/new-installer.png`） |

**没验的 / 已知不足**：
- WebView2 运行时缺失时的提示——本机装着 WebView2，没法造这个场景
- 没有代码签名证书，SmartScreen 会拦（4.4）
- 安装向导用的是 NSIS 默认的蓝色侧图和图标，没换成自己的
- 升级覆盖安装（0.1.0 → 0.1.1）没试
- 在 Git Bash 里直接跑 `setup.exe /S` 会把 `/S` 转成路径，变成交互安装——静默装要走 PowerShell `Start-Process -ArgumentList '/S'`

## 7. 明确不做

Survey（现场勘测）、Planning（预测仿真）、快照对比、工程文件与报告导出——2026-10-24 下线，代码在 `rust/archive-ui/`（不加载、不进包）。
