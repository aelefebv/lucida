//! Gate-controlled WASM-side logger that mirrors the JS bridgeLog
//! convention. JS calls `set_debug_categories(...)` to push the enabled
//! set; the [`wasm_log!`] macro checks it before building any payload.
//!
//! See `wiki/decisions/logging-conventions.md`.

use std::cell::RefCell;
use std::collections::HashSet;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(s: &str);
}

thread_local! {
    static ENABLED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

/// Replace the enabled-category set. Called from JS via the
/// `set_debug_categories` wasm-bindgen entry point.
pub fn set_categories<S: AsRef<str>>(cats: &[S]) {
    ENABLED.with(|e| {
        let mut set = e.borrow_mut();
        set.clear();
        for c in cats {
            set.insert(c.as_ref().to_string());
        }
    });
}

pub fn is_enabled(category: &str) -> bool {
    ENABLED.with(|e| e.borrow().contains(category))
}

/// Emit one line. Use the [`wasm_log!`] macro instead so the payload
/// build is gated.
pub fn log_raw(event: &str, data: &serde_json::Value) {
    let payload = serde_json::to_string(data).unwrap_or_else(|_| "{}".to_string());
    let line = format!("[wasm] {} {}", event, payload);
    #[cfg(target_arch = "wasm32")]
    console_log(&line);
    #[cfg(not(target_arch = "wasm32"))]
    let _ = line;
}

/// Gate, then build, then log. Disabled logs cost one HashSet lookup.
#[macro_export]
macro_rules! wasm_log {
    ($event:expr, $($json:tt)+) => {{
        if $crate::wasm_log::is_enabled("wasm") {
            $crate::wasm_log::log_raw($event, &::serde_json::json!($($json)+));
        }
    }};
}
