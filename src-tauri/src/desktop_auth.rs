//! Worker-only authentication reads. UI closures register asynchronous COM callbacks and return.
use std::{sync::mpsc, time::Duration};

const READ_FAILED: &str = "无法读取 DSH 登录状态，请重新打开工作窗口。";
const READ_TIMEOUT: &str = "读取 DSH 登录状态超时，请稍后重试。";

fn wait_for_cookie(
    receiver: mpsc::Receiver<Result<String, String>>,
    timeout: Duration,
) -> Result<String, String> {
    receiver
        .recv_timeout(timeout)
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => READ_TIMEOUT.to_owned(),
            mpsc::RecvTimeoutError::Disconnected => READ_FAILED.to_owned(),
        })?
}

// Name reads are permitted for selection; unrelated credential values are never read.
fn matching_cookie(
    count: u32,
    expected_name: &str,
    mut read_name: impl FnMut(u32) -> Result<String, String>,
    mut read_value: impl FnMut(u32) -> Result<String, String>,
) -> Result<String, String> {
    for index in 0..count {
        let name = read_name(index)?;
        if name != expected_name {
            continue;
        }
        return Ok(format!("{}={}", name, read_value(index)?));
    }
    Ok(String::new())
}

#[cfg(windows)]
fn com_string(
    read: impl FnOnce(*mut windows_webview::core::PWSTR) -> windows_webview::core::Result<()>,
) -> windows_webview::core::Result<String> {
    let mut raw = windows_webview::core::PWSTR::null();
    let result = read(&mut raw);
    // take_pwstr owns/frees CoTaskMem even if the getter failed after allocating.
    let text = webview2_com::take_pwstr(raw);
    result?;
    Ok(text)
}

#[cfg(windows)]
fn verify_origin(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    expected: &url::Url,
) -> Result<(), String> {
    let source = com_string(|out| unsafe { core.Source(out) })
        .map_err(|_| "无法验证 DSH 工作窗口。".to_owned())?;
    let url = url::Url::parse(&source).map_err(|_| "无法验证 DSH 工作窗口。".to_owned())?;
    if url.origin() == expected.origin() {
        Ok(())
    } else {
        Err("等待 DSH 工作窗口返回本机服务。".into())
    }
}

#[cfg(windows)]
pub(super) fn auth_cookie(app: &tauri::AppHandle, origin: &str) -> Result<String, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    use tauri::Manager;
    use webview2_com::{
        GetCookiesCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2_2,
    };
    use windows_webview::core::{Interface, HSTRING};

    let url = url::Url::parse(origin).map_err(|_| "本机服务地址无效。".to_owned())?;
    let view = app
        .get_webview("dsh")
        .ok_or("等待 DSH 工作窗口完成登录。")?;
    let authority = match url.port() {
        Some(port) => format!("127.0.0.1:{port}"),
        None => "127.0.0.1".into(),
    };
    let name = format!(
        "dsh-auth-{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(authority.as_bytes()))
    );
    let (sender, receiver) = mpsc::channel();
    view.with_webview(move |native| {
        let result = (|| -> Result<(), String> {
            let core = unsafe { native.controller().CoreWebView2() }
                .map_err(|_| READ_FAILED.to_owned())?;
            verify_origin(&core, &url)?;
            let manager = unsafe {
                core.cast::<ICoreWebView2_2>()
                    .and_then(|core| core.CookieManager())
            }
            .map_err(|_| READ_FAILED.to_owned())?;
            let uri = HSTRING::from(url.as_str());
            let completed = sender.clone();
            // COM objects are created/retained only by UI callbacks; only String results
            // cross the channel. Registration never waits for the completion callback.
            let handler = GetCookiesCompletedHandler::create(Box::new(move |status, cookies| {
                let result = (|| -> Result<String, String> {
                    status.map_err(|_| READ_FAILED.to_owned())?;
                    verify_origin(&core, &url)?;
                    let Some(cookies) = cookies else {
                        return Ok(String::new());
                    };
                    let mut count = 0;
                    unsafe { cookies.Count(&mut count) }.map_err(|_| READ_FAILED.to_owned())?;
                    matching_cookie(
                        count,
                        &name,
                        |index| {
                            let cookie = unsafe { cookies.GetValueAtIndex(index) }
                                .map_err(|_| READ_FAILED.to_owned())?;
                            com_string(|out| unsafe { cookie.Name(out) })
                                .map_err(|_| READ_FAILED.to_owned())
                        },
                        |index| {
                            let cookie = unsafe { cookies.GetValueAtIndex(index) }
                                .map_err(|_| READ_FAILED.to_owned())?;
                            com_string(|out| unsafe { cookie.Value(out) })
                                .map_err(|_| READ_FAILED.to_owned())
                        },
                    )
                })();
                // A timed-out worker may already have left. Never panic/retry on the UI.
                let _ = completed.send(result);
                Ok(())
            }));
            unsafe { manager.GetCookies(&uri, &handler) }.map_err(|_| READ_FAILED.to_owned())
        })();
        if let Err(error) = result {
            let _ = sender.send(Err(error));
        }
    })
    .map_err(|_| READ_FAILED.to_owned())?;
    wait_for_cookie(receiver, Duration::from_secs(5))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_audience_cookie_value_is_read() {
        let names = [
            "dsh-auth-other-port",
            "unrelated-token",
            "dsh-auth-matching",
            "later",
        ];
        let mut reads = Vec::new();
        let result = matching_cookie(
            4,
            "dsh-auth-matching",
            |index| Ok(names[index as usize].into()),
            |index| {
                reads.push(index);
                Ok("opaque-value".into())
            },
        );
        assert_eq!(result.unwrap(), "dsh-auth-matching=opaque-value");
        assert_eq!(reads, [2]);
    }

    #[test]
    fn absent_cookie_reads_no_values_and_returns_empty() {
        assert_eq!(
            matching_cookie(
                2,
                "expected",
                |_| Ok("other".into()),
                |_| panic!("must not read unrelated values")
            )
            .unwrap(),
            ""
        );
    }

    #[test]
    fn getter_errors_fail_closed_without_reading_values() {
        assert_eq!(
            matching_cookie(
                1,
                "expected",
                |_| Err(READ_FAILED.into()),
                |_| panic!("must not read on error")
            ),
            Err(READ_FAILED.into())
        );
    }

    #[test]
    fn worker_receives_only_result_strings_and_does_not_wait_after_completion() {
        let (sender, receiver) = mpsc::channel();
        sender.send(Ok("expected=value".into())).unwrap();
        assert_eq!(
            wait_for_cookie(receiver, Duration::ZERO).unwrap(),
            "expected=value"
        );
    }

    #[test]
    fn timeout_allows_late_callback_to_fail_without_panicking_and_next_read_to_retry() {
        let (sender, receiver) = mpsc::channel();
        assert_eq!(
            wait_for_cookie(receiver, Duration::ZERO),
            Err(READ_TIMEOUT.into())
        );
        assert!(sender.send(Ok("late".into())).is_err());
        let (sender, receiver) = mpsc::channel();
        sender.send(Ok(String::new())).unwrap();
        assert_eq!(wait_for_cookie(receiver, Duration::ZERO), Ok(String::new()));
    }

    #[test]
    fn disconnected_or_failed_callback_returns_fixed_error() {
        let (sender, receiver) = mpsc::channel();
        drop(sender);
        assert_eq!(
            wait_for_cookie(receiver, Duration::ZERO),
            Err(READ_FAILED.into())
        );
        let (sender, receiver) = mpsc::channel();
        sender.send(Err(READ_FAILED.into())).unwrap();
        assert_eq!(
            wait_for_cookie(receiver, Duration::ZERO),
            Err(READ_FAILED.into())
        );
    }
}
