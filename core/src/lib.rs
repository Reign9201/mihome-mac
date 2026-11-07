pub mod assistant;
pub mod auth;
pub mod automation;
pub mod camera;
pub mod cloud;
pub mod integration;
pub mod logging;
mod loopback_proxy;
pub mod media;
pub mod miss;
pub mod pppp;
pub mod relay;
pub mod remote;
pub mod remote_crypto;
pub mod remote_stream;
pub mod sign;
pub mod spec;

pub use assistant::{
    parse_model_content, AdjustmentDirection, AdjustmentUnit, AssistantIntent, DeviceCatalog,
    IntentAction, IntentTarget, OpenAiIntentParser, ResolveOutcome, ResolvedCommand,
    ResolvedOperation, ResolvedTarget,
};
pub use auth::{
    account_storage_key, AccountBook, AccountSummary, AuthStart, PendingLogin, Session, UserInfo,
};
pub use automation::{Automation, AutomationStore};
pub use camera::{CameraDevice, CameraStream};
pub use cloud::{Device, Home, MiCloud, Scene};
pub use integration::{
    AsrConfig, AsrProvider, Binding, ConnectionMode, IntegrationSettings, IntegrationSnapshot,
    IntegrationStore, LlmConfig, PairingCode, PairingCodeView, PlatformConfig, PlatformKind,
    PlatformStatus,
};
pub use spec::{DeviceSpec, SpecBatch, SpecRegistry};
