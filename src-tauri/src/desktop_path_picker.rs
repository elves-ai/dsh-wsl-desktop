//! One read-only, trusted IPC surface for Windows native WSL path selection.
use super::{assert_local, settings_page, Controller};
use crate::settings_path::PathKind;
use crate::settings_path::{from_unc, to_unc, validate_linux};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Manager, Webview};
use windows_webview::{
    core::{HSTRING, PCWSTR},
    Win32::{
        Foundation::{ERROR_CANCELLED, HWND},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            SystemServices::{SFGAO_FILESYSTEM, SFGAO_FOLDER},
        },
        UI::Shell::{
            FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName,
            FOS_DONTADDTORECENT, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_FORCESHOWHIDDEN,
            FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
        },
    },
};

impl PathKind {
    fn setup(self) -> bool {
        matches!(self, Self::SetupRepository | Self::SetupNode)
    }
    fn folder(self) -> bool {
        matches!(self, Self::Repository | Self::SetupRepository)
    }
    fn title(self) -> &'static str {
        match self {
            Self::Repository | Self::SetupRepository => "选择 WSL Harness 项目目录",
            Self::SetupNode => "选择 WSL Node.js 可执行文件",
        }
    }
}
static OPEN: AtomicBool = AtomicBool::new(false);
struct PickerLease;
impl Drop for PickerLease {
    fn drop(&mut self) {
        OPEN.store(false, Ordering::SeqCst);
    }
}
fn assert_available(controller: &Controller) -> Result<(), String> {
    if controller.busy.load(Ordering::SeqCst) || controller.exiting.load(Ordering::SeqCst) {
        return Err("当前操作期间无法选择路径，请稍后重试。".into());
    }
    Ok(())
}
#[tauri::command]
pub(super) async fn pick_settings_path(
    view: Webview,
    kind: PathKind,
    current_path: Option<String>,
    distribution: Option<String>,
) -> Result<Option<String>, String> {
    assert_local(&view)?;
    let controller = view.app_handle().state::<Arc<Controller>>().inner().clone();
    assert_available(&controller)?;
    let configured = controller
        .backend
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let (distro, fallback) = if kind.setup() {
        if view.label() != "launcher"
            || view.window().label() != "launcher"
            || !view.window().is_visible().unwrap_or(false)
            || !controller.snapshot().setup_required
            || configured.is_some()
        {
            return Err("只有首次配置页可以选择待配置发行版内的路径。".into());
        }
        let distro = distribution.ok_or("请先选择 WSL 发行版。")?;
        (distro, "/".to_string())
    } else {
        settings_page::assert_active_page(&view)?;
        if distribution.is_some() {
            return Err("设置路径只能使用已配置的 WSL 发行版。".into());
        }
        let config = configured.ok_or("请先完成 WSL 环境配置。")?;
        let fallback = config
            .linux_config
            .rsplit_once('/')
            .map(|p| p.0)
            .filter(|p| !p.is_empty())
            .unwrap_or("/")
            .to_string();
        (config.distribution, fallback)
    };
    let supplied = current_path.filter(|p| !p.is_empty());
    let is_file = !kind.folder() && supplied.is_some();
    let current = supplied.unwrap_or(fallback);
    validate_linux(&current)?;
    let folder = if !is_file {
        current
    } else {
        current
            .rsplit_once('/')
            .map(|p| p.0)
            .filter(|p| !p.is_empty())
            .unwrap_or("/")
            .to_string()
    };
    // Validate before creating a dialog. The frontend cannot supply an arbitrary UNC/host location.
    to_unc(&distro, &folder)?;
    if OPEN
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有系统路径选择窗口打开。".into());
    }
    let lease = PickerLease;
    let owner = view
        .window()
        .hwnd()
        .map_err(|_| "无法读取路径选择窗口。")?
        .0 as isize;
    let requested_distro = distro.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        if kind.setup()
            && !crate::setup::distributions()?
                .iter()
                .any(|d| d == &requested_distro)
        {
            return Err("只能选择已检测到的 WSL 发行版。".to_string());
        }
        // A fresh STA thread owns every COM object and releases them before CoUninitialize.
        std::thread::spawn(move || native_dialog(owner, kind, &requested_distro, &folder))
            .join()
            .map_err(|_| "系统路径选择任务异常结束。".to_string())?
    })
    .await
    .map_err(|_| "系统路径选择任务未完成。".to_string())??;
    if !kind.setup() {
        settings_page::assert_active_page(&view)?;
    }
    assert_available(&controller)?;
    if kind.setup() {
        assert_local(&view)?;
        if !view.window().is_visible().unwrap_or(false) || !controller.snapshot().setup_required {
            return Err("首次配置状态已改变，请重新选择。".into());
        }
    } else if controller
        .backend
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|c| c.distribution.as_str())
        != Some(distro.as_str())
    {
        return Err("WSL 配置已改变，请重新选择。".into());
    }
    Ok(result)
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
fn native_dialog(
    owner: isize,
    kind: PathKind,
    distro: &str,
    folder: &str,
) -> Result<Option<String>, String> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|_| "无法初始化系统路径选择器。")?;
        let _apartment = Apartment;
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| "无法创建 Windows 系统路径选择器。")?;
        let mut options = FOS_FORCEFILESYSTEM
            | FOS_PATHMUSTEXIST
            | FOS_NOCHANGEDIR
            | FOS_FORCESHOWHIDDEN
            | FOS_DONTADDTORECENT;
        options |= if kind.folder() {
            FOS_PICKFOLDERS
        } else {
            FOS_FILEMUSTEXIST
        };
        dialog
            .SetOptions(options)
            .map_err(|_| "无法配置系统路径选择器。")?;
        dialog
            .SetTitle(&HSTRING::from(kind.title()))
            .map_err(|_| "无法设置路径选择标题。")?;
        let mut initial = folder.to_string();
        loop {
            let unc = HSTRING::from(to_unc(distro, &initial)?);
            let item: windows_webview::core::Result<IShellItem> =
                SHCreateItemFromParsingName(&unc, None);
            if let Ok(item) = item {
                if item
                    .GetAttributes(SFGAO_FOLDER)
                    .is_ok_and(|a| a.contains(SFGAO_FOLDER))
                    && dialog.SetFolder(&item).is_ok()
                {
                    break;
                }
            }
            if initial == "/" {
                return Err("无法访问已配置发行版的 WSL 目录，请确认发行版正在运行。".into());
            }
            initial = initial
                .rsplit_once('/')
                .map(|p| p.0)
                .filter(|p| !p.is_empty())
                .unwrap_or("/")
                .to_string();
        }
        if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
            if error.code() == windows_webview::core::HRESULT::from_win32(ERROR_CANCELLED.0) {
                return Ok(None);
            }
            return Err("Windows 系统路径选择未完成。".into());
        }
        let item = dialog.GetResult().map_err(|_| "无法读取所选路径。")?;
        let attributes = item
            .GetAttributes(SFGAO_FILESYSTEM | SFGAO_FOLDER)
            .map_err(|_| "无法确认所选项目类型。")?;
        if !attributes.contains(SFGAO_FILESYSTEM)
            || attributes.contains(SFGAO_FOLDER) != kind.folder()
        {
            return Err("所选项目的文件或目录类型不匹配。".into());
        }
        let raw = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|_| "所选项目不是受支持的文件系统路径。")?;
        let text = PCWSTR(raw.0).to_string();
        CoTaskMemFree(Some(raw.0 as *const _));
        let path = from_unc(distro, &text.map_err(|_| "所选路径不是有效的 Unicode。")?)?;
        Ok(Some(path))
    }
}
