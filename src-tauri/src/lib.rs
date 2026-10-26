pub mod assistant;
pub mod assistant_policy;
pub mod assistant_speech;
pub mod assistant_transport;
pub mod backend;
pub mod config;
#[cfg(windows)]
mod desktop;
#[cfg(all(test, not(windows)))]
#[path = "desktop_auth.rs"]
mod desktop_auth_tests;
pub mod environment;
pub mod notification_audio;
pub mod notification_channels;
pub mod notification_transport;
pub mod notifications;
pub mod pet_geometry;
pub mod pet_interactions;
pub mod pet_memory;
pub mod pet_native_policy;
pub mod pet_notifications;
pub mod pet_settings;
pub mod pet_workspace;
pub mod power;
pub mod protocol;
pub mod settings_path;
pub mod setup;
pub mod speech_install;
pub mod speech_prerequisites;
pub mod speech_resources;
pub mod speech_settings;
#[cfg(any(windows, test))]
pub mod speech_wsl;
pub mod update;
pub mod user_attention;
#[cfg(any(windows, test))]
mod window_activation;
#[cfg(windows)]
pub use desktop::run;
