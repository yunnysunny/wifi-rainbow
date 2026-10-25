//! 整窗口截图：PrintWindow 把主窗口（含标题栏）画进一块 32 位 DIB，
//! 按 DWM 的扩展边框裁掉 Win11 的隐形阴影边，再用 GDI+ 平面 API 存成 PNG。
//! 全部走系统自带的 user32 / gdi32 / dwmapi / gdiplus，不引第三方 crate。
//!
//! 和 tools/shot-window.ps1 是同一套办法，那边是给手册截图用的 PowerShell 版。

use std::ffi::c_void;
use std::path::Path;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct BitmapInfoHeader {
    size: u32,
    width: i32,
    height: i32,
    planes: u16,
    bit_count: u16,
    compression: u32,
    size_image: u32,
    x_pels_per_meter: i32,
    y_pels_per_meter: i32,
    clr_used: u32,
    clr_important: u32,
}

#[repr(C)]
struct BitmapInfo {
    header: BitmapInfoHeader,
    colors: [u32; 1],
}

#[repr(C)]
struct GdiplusStartupInput {
    version: u32,
    debug_event_callback: *const c_void,
    suppress_background_thread: i32,
    suppress_external_codecs: i32,
}

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

/// GDI+ 内置 PNG 编码器 {557CF406-1A04-11D3-9A73-0000F81EF32E}
const PNG_ENCODER: Guid = Guid {
    data1: 0x557c_f406,
    data2: 0x1a04,
    data3: 0x11d3,
    data4: [0x9a, 0x73, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e],
};

const PW_RENDERFULLCONTENT: u32 = 2;
const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
const DIB_RGB_COLORS: u32 = 0;
const BI_RGB: u32 = 0;
const PIXEL_FORMAT_32BPP_RGB: i32 = 0x0002_2009;

#[link(name = "user32")]
extern "system" {
    fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
    fn PrintWindow(hwnd: isize, hdc: isize, flags: u32) -> i32;
    fn GetDC(hwnd: isize) -> isize;
    fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
}

#[link(name = "dwmapi")]
extern "system" {
    fn DwmGetWindowAttribute(hwnd: isize, attr: u32, out: *mut c_void, size: u32) -> i32;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(hdc: isize) -> isize;
    fn CreateDIBSection(hdc: isize, info: *const BitmapInfo, usage: u32, bits: *mut *mut c_void, section: isize, offset: u32) -> isize;
    fn SelectObject(hdc: isize, obj: isize) -> isize;
    fn DeleteObject(obj: isize) -> i32;
    fn DeleteDC(hdc: isize) -> i32;
}

#[link(name = "gdiplus")]
extern "system" {
    fn GdiplusStartup(token: *mut usize, input: *const GdiplusStartupInput, output: *mut c_void) -> u32;
    fn GdiplusShutdown(token: usize);
    fn GdipCreateBitmapFromHBITMAP(hbm: isize, hpal: isize, bitmap: *mut *mut c_void) -> u32;
    fn GdipCloneBitmapAreaI(x: i32, y: i32, w: i32, h: i32, format: i32, src: *mut c_void, dst: *mut *mut c_void) -> u32;
    fn GdipSaveImageToFile(image: *mut c_void, filename: *const u16, clsid: *const Guid, params: *const c_void) -> u32;
    fn GdipDisposeImage(image: *mut c_void) -> u32;
}

/// RAII：确保每条路径都释放 GDI / GDI+ 资源
struct Gdi {
    hdc_screen: isize,
    hdc_mem: isize,
    hbm: isize,
    old: isize,
}

impl Drop for Gdi {
    fn drop(&mut self) {
        unsafe {
            if self.hdc_mem != 0 {
                if self.old != 0 {
                    SelectObject(self.hdc_mem, self.old);
                }
                DeleteDC(self.hdc_mem);
            }
            if self.hbm != 0 {
                DeleteObject(self.hbm);
            }
            if self.hdc_screen != 0 {
                ReleaseDC(0, self.hdc_screen);
            }
        }
    }
}

struct GdiPlus {
    token: usize,
    images: Vec<*mut c_void>,
}

impl Drop for GdiPlus {
    fn drop(&mut self) {
        unsafe {
            for &img in &self.images {
                if !img.is_null() {
                    GdipDisposeImage(img);
                }
            }
            if self.token != 0 {
                GdiplusShutdown(self.token);
            }
        }
    }
}

fn wide(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// 把 `hwnd` 整个窗口（含标题栏，不含阴影边）存成 PNG，返回 (宽, 高)。
pub fn window_to_png(hwnd: isize, path: &Path) -> Result<(u32, u32), String> {
    if hwnd == 0 {
        return Err("窗口句柄为空".into());
    }
    unsafe {
        let mut full = Rect::default();
        if GetWindowRect(hwnd, &mut full) == 0 {
            return Err("GetWindowRect 失败".into());
        }
        let w = full.right - full.left;
        let h = full.bottom - full.top;
        if w <= 0 || h <= 0 {
            return Err(format!("窗口尺寸异常 {w}x{h}（最小化了？）"));
        }

        // 可见边界：拿不到就按整个窗口矩形
        let mut vis = full;
        if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut vis as *mut Rect as *mut c_void, std::mem::size_of::<Rect>() as u32) != 0 {
            vis = full;
        }

        let mut gdi = Gdi { hdc_screen: 0, hdc_mem: 0, hbm: 0, old: 0 };
        gdi.hdc_screen = GetDC(0);
        if gdi.hdc_screen == 0 {
            return Err("GetDC 失败".into());
        }
        gdi.hdc_mem = CreateCompatibleDC(gdi.hdc_screen);
        if gdi.hdc_mem == 0 {
            return Err("CreateCompatibleDC 失败".into());
        }
        let info = BitmapInfo {
            header: BitmapInfoHeader {
                size: std::mem::size_of::<BitmapInfoHeader>() as u32,
                width: w,
                height: -h, // 负数 = 自上而下
                planes: 1,
                bit_count: 32,
                compression: BI_RGB,
                size_image: 0,
                x_pels_per_meter: 0,
                y_pels_per_meter: 0,
                clr_used: 0,
                clr_important: 0,
            },
            colors: [0],
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        gdi.hbm = CreateDIBSection(gdi.hdc_screen, &info, DIB_RGB_COLORS, &mut bits, 0, 0);
        if gdi.hbm == 0 {
            return Err("CreateDIBSection 失败".into());
        }
        gdi.old = SelectObject(gdi.hdc_mem, gdi.hbm);
        if PrintWindow(hwnd, gdi.hdc_mem, PW_RENDERFULLCONTENT) == 0 {
            return Err("PrintWindow 失败".into());
        }

        let mut gp = GdiPlus { token: 0, images: Vec::new() };
        let input = GdiplusStartupInput { version: 1, debug_event_callback: std::ptr::null(), suppress_background_thread: 0, suppress_external_codecs: 0 };
        let st = GdiplusStartup(&mut gp.token, &input, std::ptr::null_mut());
        if st != 0 {
            return Err(format!("GdiplusStartup 失败（{st}）"));
        }
        let mut src: *mut c_void = std::ptr::null_mut();
        let st = GdipCreateBitmapFromHBITMAP(gdi.hbm, 0, &mut src);
        if st != 0 || src.is_null() {
            return Err(format!("GdipCreateBitmapFromHBITMAP 失败（{st}）"));
        }
        gp.images.push(src);

        // 裁掉阴影边
        let cx = (vis.left - full.left).max(0);
        let cy = (vis.top - full.top).max(0);
        let cw = (vis.right - vis.left).min(w - cx).max(1);
        let ch = (vis.bottom - vis.top).min(h - cy).max(1);
        let mut out = src;
        if cx != 0 || cy != 0 || cw != w || ch != h {
            let mut dst: *mut c_void = std::ptr::null_mut();
            let st = GdipCloneBitmapAreaI(cx, cy, cw, ch, PIXEL_FORMAT_32BPP_RGB, src, &mut dst);
            if st != 0 || dst.is_null() {
                return Err(format!("GdipCloneBitmapAreaI 失败（{st}）"));
            }
            gp.images.push(dst);
            out = dst;
        }

        let name = wide(path);
        let st = GdipSaveImageToFile(out, name.as_ptr(), &PNG_ENCODER, std::ptr::null());
        if st != 0 {
            return Err(format!("GdipSaveImageToFile 失败（{st}）"));
        }
        Ok((cw as u32, ch as u32))
    }
}
