use std::process::{Command, Output};

fn lucida(args: &[&str]) -> Output {
    let config_path = std::env::temp_dir().join(format!(
        "lucida-cli-automation-{}-{}.json",
        std::process::id(),
        args.len()
    ));
    Command::new(env!("CARGO_BIN_EXE_lucida"))
        .args(args)
        .env("LUCIDA_CONFIG_PATH", &config_path)
        .env_remove("LUCIDA_TOKEN")
        .output()
        .unwrap()
}

fn json(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).unwrap_or_else(|error| {
        panic!(
            "expected JSON ({error}), got: {}",
            String::from_utf8_lossy(bytes)
        )
    })
}

#[test]
fn parse_failures_use_the_stable_json_error_envelope_and_exit_two() {
    let output = lucida(&["--json", "definitely-not-a-command"]);

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let error = json(&output.stderr);
    assert_eq!(error["error"]["kind"], "usage");
    assert_eq!(error["error"]["exit_code"], 2);
    assert!(error["error"]["clap_kind"].is_string());
}

#[test]
fn runtime_failures_use_the_same_json_envelope_and_config_exit_code() {
    let output = lucida(&["--json", "--server", "ftp://example.test", "status"]);

    assert_eq!(output.status.code(), Some(64));
    assert!(output.stdout.is_empty());
    assert_eq!(json(&output.stderr)["error"]["kind"], "invalid_server");
}

#[test]
fn unhealthy_status_is_machine_readable_and_exits_nonzero_without_fake_success() {
    // Port 9 is expected to refuse locally and avoids DNS/network dependence.
    let output = lucida(&["--json", "--server", "http://127.0.0.1:9", "status"]);

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stderr.is_empty());
    let report = json(&output.stdout);
    assert_eq!(report["ok"], false);
    assert_eq!(report["checks"]["healthz"]["ok"], false);
    assert_eq!(report["checks"]["readyz"]["ok"], false);
    assert_eq!(report["checks"]["version"]["ok"], false);
}

#[test]
fn help_remains_a_successful_human_control_flow_even_with_json_requested() {
    let output = lucida(&["--json", "--help"]);

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert!(String::from_utf8_lossy(&output.stdout).contains("Command line client for Lucida"));
}
