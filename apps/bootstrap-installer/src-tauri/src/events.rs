//! Event types streamed from Rust → React.
//!
//! These mirror `apps/desktop/electron/bootstrap-runner.ts`'s event shape
//! 1:1 so the React installer code can be roughly identical to the Electron
//! install-overlay we'll replace.
//!
//! The Tauri event channel name is `"bootstrap"` for all of these — the
//! `type` discriminator on each payload is how the frontend routes.

use serde::{Deserialize, Serialize};

pub(crate) const SETUP_CHANNEL_UNPUBLISHED: &str = "This Setup is not published on the selected update channel. Download the current Setup for that channel, then retry";

/// Stage definition as reported by `install.ps1 -Manifest`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageInfo {
    pub name: String,
    pub title: String,
    pub category: String,
    /// `needs_user_input=true` stages run with -NonInteractive and emit
    /// skipped=true; the post-install wizard takes over for those.
    #[serde(rename = "needs_user_input", alias = "needsUserInput")]
    pub needs_user_input: bool,
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    #[test]
    fn display_diagnostics_are_safe_without_rewriting_protocol_data() {
        let event = BootstrapEvent::Stage {
            name: "verify".into(), state: StageState::Failed, duration_ms: Some(7),
            error: Some("Authorization: synthetic credential".into()),
            result: Some(StageResultPayload {
                stage: "verify".into(), ok: false, skipped: false,
                reason: Some("password=synthetic credential".into()),
                data: Some(serde_json::json!({"path": "safe fixture path"})),
            }),
        }.safe_for_display();
        let BootstrapEvent::Stage { result, error, duration_ms, .. } = event else { panic!("stage changed"); };
        assert_eq!(duration_ms, Some(7));
        assert!(!error.unwrap().contains("synthetic credential"));
        let result = result.unwrap();
        assert!(!result.reason.unwrap().contains("synthetic credential"));
        assert_eq!(result.data.unwrap()["path"], "safe fixture path");
    }

    #[test]
    fn opaque_process_output_cannot_cross_event_or_diagnostic_boundary() {
        let opaque = "syntheticOpaqueCompanyCanary9971";
        for original in [
            BootstrapEvent::Log { stage: Some("repository".into()), line: opaque.into(), stream: LogStream::Stderr },
            BootstrapEvent::Failed { stage: Some("repository".into()), error: opaque.into() },
            BootstrapEvent::Stage { name: "repository".into(), state: StageState::Failed,
                duration_ms: Some(17), error: Some(opaque.into()),
                result: Some(StageResultPayload { stage: "repository".into(), ok: false,
                    skipped: false, reason: Some(opaque.into()), data: None }) },
        ] {
            let serialized = serde_json::to_string(&original.with_diagnostic()).unwrap();
            assert!(!serialized.contains(opaque), "opaque process value reached Tauri payload");
            assert!(serialized.contains("repository"));
        }
        assert_eq!(fixed_diagnostic("home-binding-conflict syntheticOpaqueCompanyCanary9971", false),
            "home-binding-conflict: installation home is already bound; preserving migration required");
        let unpublished = SETUP_CHANNEL_UNPUBLISHED;
        assert_eq!(fixed_diagnostic(unpublished, false), unpublished);
        assert_eq!(fixed_diagnostic(&format!("{unpublished} {opaque}"), false), unpublished);
        for raw in ["Access is denied syntheticOpaqueCompanyCanary9971",
            "checksum mismatch syntheticOpaqueCompanyCanary9971"] {
            let first = fixed_diagnostic(raw, false);
            assert_eq!(fixed_diagnostic(first, false), first);
            let payload = BootstrapEvent::Failed { stage: Some("verify".into()), error: raw.into() }
                .safe_for_display().with_diagnostic();
            assert_eq!(payload.diagnostic.safe_message, first);
            assert!(!serde_json::to_string(&payload).unwrap().contains(opaque));
        }
        let tls = BootstrapEvent::Failed { stage: Some("desktop".into()),
            error: "SELF_SIGNED_CERT_IN_CHAIN syntheticOpaqueCompanyCanary9971".into() }
            .safe_for_display().with_diagnostic();
        let serialized = serde_json::to_string(&tls).unwrap();
        assert!(serialized.contains("NODE_EXTRA_CA_CERTS"));
        assert!(!serialized.contains(opaque));
        assert_eq!(tls.diagnostic.safe_message,
            "TLS certificate trust failed. Ask IT for the corporate root CA, set NODE_EXTRA_CA_CERTS to its PEM path, then retry");
        assert_eq!(actionable_process_hint("SELF_SIGNED_CERT_IN_CHAIN syntheticOpaqueCompanyCanary9971"),
            Some("TLS certificate trust failed. Ask IT for the corporate root CA, set NODE_EXTRA_CA_CERTS to its PEM path, then retry"));
        let inconsistent = BootstrapEvent::Failed { stage: Some("dependencies".into()),
            error: "Customer locked dependencies are inconsistent (exit 1); syntheticOpaqueCompanyCanary9971".into() }
            .safe_for_display().with_diagnostic();
        assert_eq!(inconsistent.diagnostic.safe_message,
            "Installed dependencies are incompatible. Use a repaired Youtab Setup and provide the operation ID to support");
        assert!(!serde_json::to_string(&inconsistent).unwrap().contains(opaque));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub stages: Vec<StageInfo>,
    #[serde(rename = "protocol_version", alias = "protocolVersion", default)]
    pub protocol_version: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageResultPayload {
    pub stage: String,
    pub ok: bool,
    #[serde(default)]
    pub skipped: bool,
    #[serde(default)]
    pub reason: Option<String>,
    /// install.ps1 may attach stage-specific structured data here.
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

/// Run-state for a single stage as we transition through it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StageState {
    Running,
    Succeeded,
    Skipped,
    Failed,
}

/// Which pipe a process line came from. Reported as structured metadata so
/// the UI can style stderr subtly rather than mislabeling it as an error:
/// uv/pip/git/npm write normal progress to stderr by design.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// The single event channel `bootstrap` emits these. `type` discriminates.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BootstrapEvent {
    /// Sent once at the start with the full stage list.
    Manifest {
        stages: Vec<StageInfo>,
        #[serde(rename = "protocolVersion")]
        protocol_version: Option<u32>,
    },
    /// Stage state transition. `result` populated only on terminal states.
    Stage {
        name: String,
        state: StageState,
        #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<StageResultPayload>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Fixed diagnostic category for stdout/stderr from install.ps1 (or our
    /// wrapper). `stream` lets the UI style stderr without exposing its body.
    Log {
        #[serde(skip_serializing_if = "Option::is_none")]
        stage: Option<String>,
        line: String,
        stream: LogStream,
    },
    /// Sent once when all stages complete successfully.
    Complete {
        #[serde(rename = "installRoot")]
        install_root: String,
        marker: Option<serde_json::Value>,
    },
    /// Sent once if the run aborts.
    Failed {
        #[serde(skip_serializing_if = "Option::is_none")]
        stage: Option<String>,
        error: String,
    },
}

impl BootstrapEvent {
    /// Process output and exception text are untrusted, even when they have no
    /// recognizable credential label. Only fixed messages cross the UI boundary.
    /// Structured stage data and the marker remain machine protocol fields.
    pub fn safe_for_display(mut self) -> Self {
        match &mut self {
            Self::Log { line, .. } => *line = fixed_diagnostic(line, true).into(),
            Self::Failed { error, .. } => *error = fixed_diagnostic(error, false).into(),
            Self::Stage { error, result, .. } => {
                if let Some(error) = error { *error = fixed_diagnostic(error, false).into(); }
                if let Some(reason) = result.as_mut().and_then(|result| result.reason.as_mut()) {
                    *reason = fixed_diagnostic(reason, false).into();
                }
            }
            _ => {}
        }
        self
    }
    /// Tauri event name. Single channel for all bootstrap events; the
    /// `type` tag tells the renderer how to interpret the payload.
    pub const CHANNEL: &'static str = "bootstrap";
}


/// Optional metadata around the original event. The stage protocol and marker
/// values are flattened unchanged; old clients ignore the diagnostic member.
#[derive(Serialize)]
pub struct DiagnosticBootstrapEvent {
    #[serde(flatten)]
    pub event: BootstrapEvent,
    pub diagnostic: crate::diagnostics::OperationDiagnostic,
}

impl BootstrapEvent {
    pub fn with_diagnostic(self) -> DiagnosticBootstrapEvent {
        let self_ = self.safe_for_display();
        let (code, stage, message) = match &self_ {
            Self::Manifest { .. } => ("SETUP_STARTED", "start", ""),
            Self::Complete { .. } => ("SETUP_COMPLETE", "complete", ""),
            Self::Failed { stage, error } => ("SETUP_FAILED", stage.as_deref().unwrap_or("unknown"), error.as_str()),
            Self::Stage { name, state, error, .. } => (
                if matches!(state, StageState::Failed) { "SETUP_STAGE_FAILED" } else { "SETUP_STAGE_PROGRESS" },
                name.as_str(), error.as_deref().unwrap_or("")),
            Self::Log { stage, line, .. } => ("SETUP_LOG", stage.as_deref().unwrap_or("unknown"), line.as_str()),
        };
        let diagnostic = crate::diagnostics::operation_diagnostic(code, stage, message);
        DiagnosticBootstrapEvent { event: self_, diagnostic }
    }
}

/// Classify without copying any bytes from untrusted output. In particular,
/// heuristic redaction cannot detect an unlabelled company credential.
pub(crate) fn fixed_diagnostic(value: &str, is_log: bool) -> &'static str {
    const FIXED: &[&str] = &[
        "home-binding-conflict: installation home is already bound; preserving migration required",
        "Operation cancelled by user",
        "Another Youtab process is using this installation; close it and retry",
        "Downloaded package failed integrity verification",
        "Installation access denied; check folder permissions",
        "TLS certificate trust failed. Ask IT for the corporate root CA, set NODE_EXTRA_CA_CERTS to its PEM path, then retry",
        "Network download unavailable. Check connectivity or proxy and retry",
        "Not enough disk space. Free space on the installation drive and retry",
        "Installed dependencies are incompatible. Use a repaired Youtab Setup and provide the operation ID to support",
        "Installer process output omitted; see stage status",
        "Installation step failed; see the stage name and operation ID",
        SETUP_CHANNEL_UNPUBLISHED,
    ];
    if let Some(&known) = FIXED.iter().find(|&&known| known == value) { return known; }
    let lower = value.to_ascii_lowercase();
    if lower.contains("home-binding-conflict") {
        "home-binding-conflict: installation home is already bound; preserving migration required"
    } else if lower.contains("this setup is not published on the selected update channel") {
        SETUP_CHANNEL_UNPUBLISHED
    } else if lower.contains("cancelled by user") || lower.contains("canceled by user") {
        "Operation cancelled by user"
    } else if lower.contains("another youtab update") || lower.contains("still running")
        || lower.contains("another youtab process") || lower.contains("still locked") {
        "Another Youtab process is using this installation; close it and retry"
    } else if ["self_signed_cert_in_chain", "unable_to_get_issuer_cert_locally",
        "unable to get local issuer certificate", "self-signed certificate",
        "self signed certificate", "cert_has_expired", "certificate verify failed",
        "tls certificate-trust failure", "tls certificate trust failed"]
        .iter().any(|needle| lower.contains(needle)) {
        "TLS certificate trust failed. Ask IT for the corporate root CA, set NODE_EXTRA_CA_CERTS to its PEM path, then retry"
    } else if ["enospc", "no space left", "not enough disk space", "disk full"]
        .iter().any(|needle| lower.contains(needle)) {
        "Not enough disk space. Free space on the installation drive and retry"
    } else if lower.contains("customer locked dependencies are inconsistent") {
        "Installed dependencies are incompatible. Use a repaired Youtab Setup and provide the operation ID to support"
    } else if ["econnreset", "enotfound", "etimedout", "network is unreachable",
        "could not resolve host", "network timeout", "network download unavailable"]
        .iter().any(|needle| lower.contains(needle)) {
        "Network download unavailable. Check connectivity or proxy and retry"
    } else if lower.contains("hash mismatch") || lower.contains("checksum mismatch")
        || lower.contains("does not match the pinned manifest") {
        "Downloaded package failed integrity verification"
    } else if lower.contains("access is denied") || lower.contains("permission denied") {
        "Installation access denied; check folder permissions"
    } else if is_log {
        "Installer process output omitted; see stage status"
    } else {
        "Installation step failed; see the stage name and operation ID"
    }
}

pub(crate) fn actionable_process_hint(value: &str) -> Option<&'static str> {
    let category = fixed_diagnostic(value, true);
    match category {
        "TLS certificate trust failed. Ask IT for the corporate root CA, set NODE_EXTRA_CA_CERTS to its PEM path, then retry"
        | "Network download unavailable. Check connectivity or proxy and retry"
        | "Not enough disk space. Free space on the installation drive and retry" => Some(category),
        _ => None,
    }
}


#[cfg(test)]
mod operation_diagnostic_tests {
    use super::*;

    #[test]
    fn operation_ids_are_canonical_and_never_authority() {
        let id = "123e4567-e89b-42d3-a456-426614174000";
        assert_eq!(crate::diagnostics::valid_operation_id(id).as_deref(), Some(id));
        for bad in ["", "123E4567-E89B-42D3-A456-426614174000", "123e4567-e89b-12d3-a456-426614174000", "00000000-0000-0000-0000-000000000000", "password=synthetic"] {
            assert!(crate::diagnostics::valid_operation_id(bad).is_none());
        }
        assert_eq!(crate::diagnostics::operation_id(), crate::diagnostics::operation_id());
        assert!(crate::diagnostics::valid_operation_id(crate::diagnostics::operation_id()).is_some());
    }

    #[test]
    fn metadata_extension_preserves_every_original_event_and_machine_field() {
        let variants = vec![
            BootstrapEvent::Manifest { stages: vec![], protocol_version: Some(1) },
            BootstrapEvent::Stage { name: "verify".into(), state: StageState::Failed, duration_ms: Some(73),
                error: Some("Authorization: Bearer SYNTHETIC_OPERATION_CREDENTIAL".into()),
                result: Some(StageResultPayload { stage: "verify".into(), ok: false, skipped: false,
                    reason: Some("password=SYNTHETIC_OPERATION_CREDENTIAL".into()),
                    data: Some(serde_json::json!({"path":"original/path", "sha256":"machine-value"})) }) },
            BootstrapEvent::Log { stage: Some("verify".into()), line: "password=SYNTHETIC_OPERATION_CREDENTIAL".into(), stream: LogStream::Stderr },
            BootstrapEvent::Complete { install_root: "original/root".into(), marker: Some(serde_json::json!({"release_sequence":4,"source_sha":"machine-value"})) },
            BootstrapEvent::Failed { stage: None, error: "https://user:SYNTHETIC_OPERATION_CREDENTIAL@example.invalid/".into() },
        ];
        for original in variants {
            let safe = original.safe_for_display();
            let expected = serde_json::to_value(&safe).unwrap();
            let mut actual = serde_json::to_value(safe.with_diagnostic()).unwrap();
            let metadata = actual.as_object_mut().unwrap().remove("diagnostic").unwrap();
            assert_eq!(actual, expected);
            assert_eq!(metadata["schema_version"], "youtab.diagnostic.v1");
            assert_eq!(metadata["retryable"], false);
            assert_eq!(metadata["operation_id"], crate::diagnostics::operation_id());
            assert!(!metadata.to_string().contains("SYNTHETIC_OPERATION_CREDENTIAL"));
        }
    }
}
