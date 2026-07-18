//! Reviewed transport allocation limits shared by HTTP, workspace WebSocket,
//! and browser-capture paths. Deployments may lower (or deliberately raise)
//! them within hard ceilings without rebuilding the CLI.

use crate::error::CliError;

pub const DEFAULT_HTTP_BODY_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_WS_MESSAGE_BYTES: usize = 256 * 1024 * 1024;
pub const DEFAULT_WS_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const DEFAULT_CAPTURE_BYTES: usize = 64 * 1024 * 1024;
pub const DEFAULT_CAPTURE_PIXELS: u64 = 100_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportLimits {
    pub http_body_bytes: usize,
    pub ws_message_bytes: usize,
    pub ws_frame_bytes: usize,
    pub capture_bytes: usize,
    pub capture_pixels: u64,
}

impl TransportLimits {
    pub fn from_env() -> Result<Self, CliError> {
        let limits = Self {
            http_body_bytes: env_usize(
                "LUCIDA_HTTP_BODY_LIMIT_BYTES",
                DEFAULT_HTTP_BODY_BYTES,
                1024,
                256 * 1024 * 1024,
            )?,
            ws_message_bytes: env_usize(
                "LUCIDA_WS_MESSAGE_LIMIT_BYTES",
                DEFAULT_WS_MESSAGE_BYTES,
                1024,
                512 * 1024 * 1024,
            )?,
            ws_frame_bytes: env_usize(
                "LUCIDA_WS_FRAME_LIMIT_BYTES",
                DEFAULT_WS_FRAME_BYTES,
                1024,
                256 * 1024 * 1024,
            )?,
            capture_bytes: env_usize(
                "LUCIDA_CAPTURE_LIMIT_BYTES",
                DEFAULT_CAPTURE_BYTES,
                1024,
                256 * 1024 * 1024,
            )?,
            capture_pixels: env_u64(
                "LUCIDA_CAPTURE_PIXEL_LIMIT",
                DEFAULT_CAPTURE_PIXELS,
                1,
                1_000_000_000,
            )?,
        };
        if limits.ws_frame_bytes > limits.ws_message_bytes {
            return Err(CliError::config(
                "LUCIDA_WS_FRAME_LIMIT_BYTES cannot exceed LUCIDA_WS_MESSAGE_LIMIT_BYTES",
            ));
        }
        Ok(limits)
    }
}

fn env_usize(
    name: &str,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> Result<usize, CliError> {
    match std::env::var(name) {
        Ok(value) => parse_limit(name, &value, minimum as u64, maximum as u64)
            .and_then(|value| usize::try_from(value).map_err(|_| CliError::config(name))),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(CliError::config(format!(
            "{name} is not valid Unicode: {error}"
        ))),
    }
}

fn env_u64(name: &str, default: u64, minimum: u64, maximum: u64) -> Result<u64, CliError> {
    match std::env::var(name) {
        Ok(value) => parse_limit(name, &value, minimum, maximum),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(CliError::config(format!(
            "{name} is not valid Unicode: {error}"
        ))),
    }
}

fn parse_limit(name: &str, value: &str, minimum: u64, maximum: u64) -> Result<u64, CliError> {
    let parsed = value.parse::<u64>().map_err(|_| {
        CliError::config(format!(
            "{name} must be an integer between {minimum} and {maximum}"
        ))
    })?;
    if !(minimum..=maximum).contains(&parsed) {
        return Err(CliError::config(format!(
            "{name} must be between {minimum} and {maximum}"
        )));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_limits_reject_non_numeric_and_out_of_range_values() {
        assert!(parse_limit("LIMIT", "nope", 1, 10).is_err());
        assert!(parse_limit("LIMIT", "0", 1, 10).is_err());
        assert!(parse_limit("LIMIT", "11", 1, 10).is_err());
        assert_eq!(parse_limit("LIMIT", "7", 1, 10).unwrap(), 7);
    }
}
