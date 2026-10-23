pub mod backend;
pub mod config;
#[cfg(windows)]
mod desktop;
pub mod environment;
pub mod notification_transport;
pub mod notifications;
pub mod power;
pub mod protocol;
pub mod update;
pub mod user_attention;
#[cfg(windows)]
pub use desktop::run;
