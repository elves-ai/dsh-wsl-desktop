//! In-process Windows toast activation. No protocol handler, external URL, or page IPC.
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::{IInspectable, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    UI::Notifications::{
        ToastDismissalReason, ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification,
        ToastNotificationManager, ToastNotifier,
    },
};

const LIMIT: usize = 128;
const GROUP: &str = "dsh-task";
const SEND_ERROR: &str = "无法提交可点击的系统通知，请检查 Windows 通知设置。";

/// Sound-only path: no toast or Notification Center entry is created.
/// The caller controls the app notification switch and foreground suppression.
pub(super) fn play_notification_sound() -> Result<(), String> {
    use windows_sys::Win32::Media::Audio::{
        PlaySoundW, SND_ALIAS, SND_ASYNC, SND_NODEFAULT, SND_SYSTEM,
    };

    // Use the current Windows sound scheme and system-sounds audio session.
    // SAFETY: w! provides static, NUL-terminated UTF-16 storage for async playback;
    // an alias needs no module handle, and Windows owns the playback lifetime.
    let started = unsafe {
        PlaySoundW(
            windows_sys::core::w!("SystemNotification"),
            std::ptr::null_mut(),
            SND_ALIAS | SND_ASYNC | SND_NODEFAULT | SND_SYSTEM,
        )
    };
    if started == 0 {
        Err("无法播放系统通知声音，请检查 Windows 声音设置。".to_owned())
    } else {
        Ok(())
    }
}

type Click = Box<dyn FnOnce() + Send>;
enum Event {
    Show {
        app_id: String,
        title: String,
        body: String,
        click: Click,
        canceled: Arc<AtomicBool>,
        deadline: Instant,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Clicked(u64),
    Closed(u64),
    Stop(Option<mpsc::Sender<()>>),
}

pub(super) struct Toasts {
    sender: mpsc::Sender<Event>,
}
impl Toasts {
    pub(super) fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        let events = sender.clone();
        // Preserve click order without blocking native event cleanup on WebView IPC.
        let (clicks, click_queue) = mpsc::channel::<Click>();
        thread::spawn(move || {
            for click in click_queue {
                click();
            }
        });
        thread::spawn(move || worker(receiver, events, clicks));
        Self { sender }
    }
    /// Called only by a worker, never by the Windows UI thread.
    pub(super) fn show(
        &self,
        app_id: &str,
        title: &str,
        body: &str,
        click: impl FnOnce() + Send + 'static,
    ) -> Result<(), String> {
        let (reply, result) = mpsc::channel();
        let timeout = Duration::from_secs(5);
        let canceled = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + timeout;
        self.sender
            .send(Event::Show {
                app_id: app_id.into(),
                title: title.into(),
                body: body.into(),
                click: Box::new(click),
                canceled: canceled.clone(),
                deadline,
                reply,
            })
            .map_err(|_| SEND_ERROR.to_owned())?;
        match result.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                canceled.store(true, Ordering::SeqCst);
                Err(SEND_ERROR.to_owned())
            }
        }
    }
    pub(super) fn shutdown(&self) {
        let (reply, done) = mpsc::channel();
        if self.sender.send(Event::Stop(Some(reply))).is_ok() {
            let _ = done.recv_timeout(Duration::from_secs(2));
        }
    }
}
impl Drop for Toasts {
    fn drop(&mut self) {
        let _ = self.sender.send(Event::Stop(None));
    }
}

struct Entry {
    id: u64,
    app_id: String,
    tag: String,
    native: ToastNotification,
    notifier: ToastNotifier,
    activated: Option<i64>,
    dismissed: Option<i64>,
    failed: Option<i64>,
    click: Option<Click>,
}
impl Entry {
    fn new(
        id: u64,
        app_id: String,
        title: &str,
        body: &str,
        click: Click,
        events: &mpsc::Sender<Event>,
    ) -> windows::core::Result<Self> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(r#"<toast><visual><binding template="ToastGeneric"/></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>"#))?;
        let binding = doc
            .GetElementsByTagName(&HSTRING::from("binding"))?
            .Item(0)?;
        // DOM text nodes escape markup in task names; never interpolate them into XML.
        for value in [title, body] {
            let text = doc.CreateElement(&HSTRING::from("text"))?;
            text.AppendChild(&doc.CreateTextNode(&HSTRING::from(value))?)?;
            binding.AppendChild(&text)?;
        }
        let native = ToastNotification::CreateToastNotification(&doc)?;
        let tag = format!("{id:016x}");
        native.SetTag(&HSTRING::from(&tag))?;
        native.SetGroup(&HSTRING::from(GROUP))?;
        let notifier =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(&app_id))?;
        let mut entry = Self {
            id,
            app_id,
            tag,
            native,
            notifier,
            activated: None,
            dismissed: None,
            failed: None,
            click: Some(click),
        };
        let sender = events.clone();
        entry.activated = Some(entry.native.Activated(&TypedEventHandler::<
            ToastNotification,
            IInspectable,
        >::new(move |_, _| {
            let _ = sender.send(Event::Clicked(id));
            Ok(())
        }))?);
        let sender = events.clone();
        entry.dismissed = Some(entry.native.Dismissed(&TypedEventHandler::<
            ToastNotification,
            ToastDismissedEventArgs,
        >::new(move |_, args| {
            // A banner timeout leaves the toast in Notification Center: keep its callback.
            if args.as_ref().and_then(|args| args.Reason().ok())
                != Some(ToastDismissalReason::TimedOut)
            {
                let _ = sender.send(Event::Closed(id));
            }
            Ok(())
        }))?);
        let sender = events.clone();
        entry.failed = Some(entry.native.Failed(&TypedEventHandler::<
            ToastNotification,
            ToastFailedEventArgs,
        >::new(move |_, _| {
            let _ = sender.send(Event::Closed(id));
            Ok(())
        }))?);
        Ok(entry)
    }
}
impl Drop for Entry {
    fn drop(&mut self) {
        // Worker-only cleanup: callbacks merely enqueue IDs and never take locks or
        // unregister their own active delegates. Also handles partial registration failures.
        if let Some(token) = self.activated {
            let _ = self.native.RemoveActivated(token);
        }
        if let Some(token) = self.dismissed {
            let _ = self.native.RemoveDismissed(token);
        }
        if let Some(token) = self.failed {
            let _ = self.native.RemoveFailed(token);
        }
        let _ = self.notifier.Hide(&self.native);
        if let Ok(history) = ToastNotificationManager::History() {
            let _ = history.RemoveGroupedTagWithId(
                &HSTRING::from(&self.tag),
                &HSTRING::from(GROUP),
                &HSTRING::from(&self.app_id),
            );
        }
    }
}

fn worker(
    receiver: mpsc::Receiver<Event>,
    events: mpsc::Sender<Event>,
    clicks: mpsc::Sender<Click>,
) {
    // Own every WinRT object on this dedicated MTA, not Tauri's UI thread.
    let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
    let mut entries: VecDeque<Entry> = VecDeque::new();
    let mut next = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    while let Ok(event) = receiver.recv() {
        match event {
            Event::Show {
                app_id,
                title,
                body,
                click,
                canceled,
                deadline,
                reply,
            } => {
                next = next.wrapping_add(1);
                let expired = || canceled.load(Ordering::SeqCst) || Instant::now() >= deadline;
                let result = if initialized && !expired() {
                    Entry::new(next, app_id, &title, &body, click, &events)
                        .map_err(|_| SEND_ERROR.to_owned())
                        .and_then(|entry| {
                            // WinRT construction may be slow; recheck just before Show.
                            if expired() {
                                return Err(SEND_ERROR.to_owned());
                            }
                            if entries.len() >= LIMIT {
                                entries.pop_front();
                            }
                            // Keep native handles before Show: an immediate click/failure can race.
                            entries.push_back(entry);
                            let entry = entries.back().expect("just inserted toast");
                            let result = entry.notifier.Show(&entry.native);
                            if result.is_err() {
                                entries.pop_back();
                            }
                            result.map_err(|_| SEND_ERROR.to_owned())
                        })
                } else {
                    Err(SEND_ERROR.to_owned())
                };
                let abandoned = expired();
                let replied = reply.send(if abandoned {
                    Err(SEND_ERROR.to_owned())
                } else {
                    result
                });
                // An already-running WinRT Show cannot be interrupted. If its owner
                // timed out, remove any late toast instead of leaving an orphan behind.
                if abandoned || replied.is_err() {
                    if let Some(index) = entries.iter().position(|entry| entry.id == next) {
                        entries.remove(index);
                    }
                }
            }
            Event::Clicked(id) | Event::Closed(id) => {
                if let Some(index) = entries.iter().position(|entry| entry.id == id) {
                    let mut entry = entries.remove(index).expect("located toast");
                    let click = if matches!(event, Event::Clicked(_)) {
                        entry.click.take()
                    } else {
                        None
                    };
                    drop(entry);
                    // Window/WebView operations may marshal to UI; don't block toast cleanup.
                    if let Some(click) = click {
                        let _ = clicks.send(click);
                    }
                }
            }
            Event::Stop(reply) => {
                entries.clear();
                if let Some(reply) = reply {
                    let _ = reply.send(());
                }
                break;
            }
        }
    }
    drop(entries);
    if initialized {
        unsafe { RoUninitialize() };
    }
}
