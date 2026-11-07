//! Booting the server binary from an integration test.
//!
//! The boot cases all need the same two things: a command with its
//! environment pinned, so a variable set in the shell running
//! `cargo test` cannot change the outcome, and a way to wait for a
//! server that came up and ask it something.

// Every test binary compiles its own copy and uses a different subset.
#![allow(dead_code)]

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// How long a server gets to come up and answer before a case gives up.
/// Generous, because a slow machine failing this would be a false alarm
/// rather than a defect.
pub const STARTUP_BUDGET: Duration = Duration::from_secs(30);

/// The only variables the server inherits. It needs `PATH` and `HOME`,
/// and on Windows `SystemRoot`, without which Winsock cannot start and
/// the bind fails.
const INHERITED: [&str; 3] = ["PATH", "HOME", "SystemRoot"];

/// The server binary with none of the parent's environment beyond
/// [`INHERITED`], so a case sees only the variables it sets.
pub fn server(bind: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lucida-server"));
    command.env_clear();
    for name in INHERITED {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        // A loopback bind auto-detects the auth mode to disabled, so no
        // Google credentials are needed to reach the storage step.
        .env("LUCIDA_BIND", bind)
        .env("RUST_LOG", "lucida_server=info")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Run the server until it exits and return its exit code and stderr.
/// Only for the cases that fail before binding: one that comes up anyway
/// is killed when [`STARTUP_BUDGET`] runs out, and the case fails rather
/// than hangs.
pub fn exit_of(command: &mut Command) -> (Option<i32>, String) {
    // Nothing reads the log here, and a pipe nobody drains can fill and
    // stall the server before it exits.
    let mut child = command
        .stdout(Stdio::null())
        .spawn()
        .expect("the server binary runs");
    let deadline = Instant::now() + STARTUP_BUDGET;
    while matches!(child.try_wait(), Ok(None)) {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let stderr = child
                .wait_with_output()
                .map(|output| String::from_utf8_lossy(&output.stderr).into_owned())
                .unwrap_or_default();
            panic!("the server was still running after {STARTUP_BUDGET:?}: {stderr}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let output = child.wait_with_output().expect("the server can be reaped");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// `GET path` over a fresh connection: the status line and the body, or
/// `None` when nothing answered.
pub fn get(port: u16, path: &str) -> Option<(String, String)> {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).ok()?;
    socket.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    socket.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    socket.read_to_string(&mut response).ok()?;
    let (head, body) = response.split_once("\r\n\r\n")?;
    Some((head.lines().next()?.to_string(), body.to_string()))
}

/// Poll `/healthz` until it answers, giving up as soon as `child` exits
/// or when [`STARTUP_BUDGET`] runs out.
///
/// A bound socket is not enough: the storage step runs before the bind,
/// so a server that answers is one that opened its database, migrated
/// it, and built every router over the stores it handed out. Nor is a
/// successful connect, which a loopback socket can make with no listener
/// at all when it is handed the target port as its own source port.
pub fn wait_for_health(port: u16, child: &mut Child) -> bool {
    let deadline = Instant::now() + STARTUP_BUDGET;
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return false;
        }
        if matches!(get(port, "/healthz"), Some((status, _)) if status.starts_with("HTTP/1.1 200"))
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// A port nothing is listening on right now, which the kernel hands
/// back once the listener is dropped. Losing the race to another process
/// costs a failed bind, not a wrong answer, so the case that uses this
/// fails loudly rather than passing by accident. The exception is a
/// server another case started on the same port, which answers for both,
/// so cases that start servers in parallel must not pick ports at once.
pub fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("a loopback port is available")
        .local_addr()
        .expect("a bound listener has an address")
        .port()
}
