//! Native WebView2 menu; remote documents receive no additional IPC or injected scripts.
use std::sync::mpsc;
use tauri::Webview;
use webview2_com::{
    ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Environment9,
        ICoreWebView2_11, ICoreWebView2_2, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
    },
};
use windows_webview::{
    core::{w, Interface, Result},
    Win32::System::Com::IStream,
};

// Build items per request so the registered handler never retains its own WebView.
unsafe fn populate(
    core: &ICoreWebView2,
    args: &ICoreWebView2ContextMenuRequestedEventArgs,
) -> Result<()> {
    // Fail closed: an API error must not bring back the full browser menu.
    args.SetHandled(true)?;
    let items = args.MenuItems()?;
    let mut count = 0;
    items.Count(&mut count)?;
    for index in (0..count).rev() {
        items.RemoveValueAtIndex(index)?;
    }
    let environment = core
        .cast::<ICoreWebView2_2>()?
        .Environment()?
        .cast::<ICoreWebView2Environment9>()?;
    let refresh = environment.CreateContextMenuItem(
        w!("刷新"),
        None::<&IStream>,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
    )?;
    let tools = environment.CreateContextMenuItem(
        w!("打开控制台"),
        None::<&IStream>,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
    )?;
    refresh.SetIsEnabled(true)?;
    tools.SetIsEnabled(true)?;
    let refresh_core = core.clone();
    let mut token = 0;
    refresh.add_CustomItemSelected(
        &CustomItemSelectedEventHandler::create(Box::new(move |_, _| refresh_core.Reload())),
        &mut token,
    )?;
    let tools_core = core.clone();
    tools.add_CustomItemSelected(
        &CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
            tools_core.OpenDevToolsWindow()
        })),
        &mut token,
    )?;
    items.InsertValueAtIndex(0, &refresh)?;
    items.InsertValueAtIndex(1, &tools)?;
    args.SetHandled(false)
}

pub(super) fn attach(view: &Webview) -> tauri::Result<()> {
    let (tx, rx) = mpsc::sync_channel(1);
    view.with_webview(move |native| {
        // All COM calls, including callbacks, stay on the WebView UI thread.
        let result = (|| -> Result<()> {
            unsafe {
                let core = native.controller().CoreWebView2()?;
                let settings = core.Settings()?;
                // The native API also works in release builds, without Tauri's debug-only wrapper.
                settings.SetAreDevToolsEnabled(true)?;
                settings.SetAreDefaultContextMenusEnabled(true)?;
                let handler = ContextMenuRequestedEventHandler::create(Box::new(|core, args| {
                    if let Some(args) = args {
                        args.SetHandled(true)?;
                        if let Some(core) = core {
                            populate(&core, &args)?;
                        }
                    }
                    Ok(())
                }));
                let mut token = 0;
                core.cast::<ICoreWebView2_11>()?
                    .add_ContextMenuRequested(&handler, &mut token)?;
            }
            Ok(())
        })();
        // Send only text across threads, never apartment-bound COM interfaces.
        let _ = tx.send(result.map_err(|error| error.to_string()));
    })?;
    rx.recv()
        .map_err(|_| tauri::Error::FailedToReceiveMessage)?
        .map_err(|error| std::io::Error::other(error).into())
}
