pub mod backend;
pub mod config;
#[cfg(windows)]
mod desktop;
pub mod notification_transport;
pub mod notifications;
pub mod protocol;
pub mod update;
#[cfg(windows)]
pub use desktop::run;
