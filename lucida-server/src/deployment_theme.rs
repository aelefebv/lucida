//! A deployment's theme: defaults for the appearance preferences and
//! per-preset token overrides, from the JSON file `LUCIDA_THEME_FILE`
//! names (ADR 0066).
//!
//! ```json
//! {
//!   "defaults": {"theme": "light", "accent": "#0f8278", "density": "compact", "canvasBackground": "white"},
//!   "tokens": {"dark": {"--lc-bg": "#101014"}, "light": {"--lc-radius": "4px"}}
//! }
//! ```
//!
//! Every key is optional. The file is read once at startup and refused
//! with a message naming the problem, so a typo stops the boot instead of
//! quietly shipping the built-in theme. [`ROUTE_PATH`] serves it without a
//! session, since the sign-in screen is themed too, and the SPA's
//! `index.html` carries the same JSON so its pre-paint script can apply
//! the theme on a first visit.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::http::header;
use axum::routing::get;
use serde::{Deserialize, Serialize};

pub const FILE_VAR: &str = "LUCIDA_THEME_FILE";
pub const ROUTE_PATH: &str = "/api/theme";

/// The comment in the SPA's `index.html` that [`DeploymentTheme::index_snippet`]
/// replaces. It sits above the pre-paint script, which reads the element
/// that takes its place.
pub const INDEX_MARKER: &str = "<!-- deployment theme -->";
const ELEMENT_ID: &str = "lucida-deployment-theme";

// These mirror lucida-web/src/theme. theme/deployment.test.ts there reads
// this file and fails when either side changes alone.
const THEME_OPTIONS: &[&str] = &["dark", "light", "system"];
const ACCENT_PRESETS: &[&str] = &["indigo", "blue", "teal", "green", "amber", "rose"];
const DENSITIES: &[&str] = &["comfortable", "compact"];
const CANVAS_BACKGROUNDS: &[&str] = &["black", "dark-gray", "white", "theme"];
const TOKEN_NAMES: &[&str] = &[
    "--lc-bg",
    "--lc-surface-1",
    "--lc-surface-2",
    "--lc-surface-3",
    "--lc-surface-float",
    "--lc-field-bg",
    "--lc-scrim",
    "--lc-thumb",
    "--lc-text",
    "--lc-text-muted",
    "--lc-text-subtle",
    "--lc-text-on-accent",
    "--lc-border",
    "--lc-border-strong",
    "--lc-accent",
    "--lc-accent-hover",
    "--lc-accent-subtle",
    "--lc-accent-text",
    "--lc-focus-ring",
    "--lc-danger",
    "--lc-danger-subtle",
    "--lc-warning",
    "--lc-warning-subtle",
    "--lc-success",
    "--lc-success-subtle",
    "--lc-info",
    "--lc-info-subtle",
    "--lc-chart-1",
    "--lc-chart-2",
    "--lc-chart-3",
    "--lc-chart-4",
    "--lc-chart-5",
    "--lc-chart-6",
    "--lc-chart-7",
    "--lc-chart-8",
    "--lc-chart-neutral",
    "--lc-canvas-bg",
    "--lc-canvas-stroke",
    "--lc-canvas-label",
    "--lc-canvas-axis-x",
    "--lc-canvas-axis-y",
    "--lc-canvas-axis-z",
    "--lc-canvas-viewport",
    "--lc-canvas-plane",
    "--lc-canvas-success",
    "--lc-canvas-warning",
    "--lc-canvas-danger",
    "--lc-canvas-info",
    "--lc-annotation-own",
    "--lc-annotation-peer",
    "--lc-annotation-ring",
    "--lc-annotation-shadow",
    "--lc-radius-sm",
    "--lc-radius",
    "--lc-radius-lg",
    "--lc-radius-full",
    "--lc-space-1",
    "--lc-space-2",
    "--lc-space-3",
    "--lc-space-4",
    "--lc-space-5",
    "--lc-space-6",
    "--lc-space-7",
    "--lc-space-8",
    "--lc-control-h",
    "--lc-control-h-sm",
    "--lc-target-min",
    "--lc-thumb-size",
    "--lc-safe-top",
    "--lc-safe-right",
    "--lc-safe-bottom",
    "--lc-safe-left",
    "--lc-font",
    "--lc-font-mono",
    "--lc-text-xs",
    "--lc-text-sm",
    "--lc-text-md",
    "--lc-text-lg",
    "--lc-text-xl",
    "--lc-text-2xl",
    "--lc-text-input",
    "--lc-shadow-1",
    "--lc-shadow-2",
    "--lc-motion-fast",
    "--lc-motion",
    "--lc-ease",
    "--lc-z-float",
    "--lc-z-panel",
    "--lc-z-dialog",
    "--lc-z-popover",
    "--lc-z-toast",
];

/// Tokens a user setting or the device decides, with what to set instead.
/// An override pinned to a theme preset would beat the user's choice, which
/// the deployment only sets the default of, or the size a touch screen
/// needs.
const PREFERENCE_TOKENS: &[(&str, &str)] = &[
    ("--lc-accent", "defaults.accent"),
    ("--lc-control-h", "defaults.density"),
    ("--lc-control-h-sm", "defaults.density"),
    ("--lc-canvas-bg", "defaults.canvasBackground"),
    ("--lc-canvas-stroke", "defaults.canvasBackground"),
    ("--lc-canvas-label", "defaults.canvasBackground"),
    ("--lc-canvas-axis-x", "defaults.canvasBackground"),
    ("--lc-canvas-axis-y", "defaults.canvasBackground"),
    ("--lc-canvas-axis-z", "defaults.canvasBackground"),
    ("--lc-canvas-viewport", "defaults.canvasBackground"),
    ("--lc-canvas-plane", "defaults.canvasBackground"),
    ("--lc-canvas-success", "defaults.canvasBackground"),
    ("--lc-canvas-warning", "defaults.canvasBackground"),
    ("--lc-canvas-danger", "defaults.canvasBackground"),
    ("--lc-canvas-info", "defaults.canvasBackground"),
    (
        "--lc-motion-fast",
        "nothing: the reduced-motion setting decides it",
    ),
    (
        "--lc-motion",
        "nothing: the reduced-motion setting decides it",
    ),
    ("--lc-target-min", "nothing: a coarse pointer decides it"),
    ("--lc-thumb-size", "nothing: a coarse pointer decides it"),
    ("--lc-text-input", "nothing: a coarse pointer decides it"),
];

/// Why the theme file was refused. Each variant names the variable and
/// the file, because the operator sees this with no other context than a
/// server that did not start.
#[derive(Debug, thiserror::Error)]
pub enum DeploymentThemeError {
    #[error("{}={}: cannot read the file: {source}", FILE_VAR, path.display())]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{}={}: {problem}", FILE_VAR, path.display())]
    Invalid {
        path: PathBuf,
        problem: ThemeProblem,
    },
}

/// What is wrong inside a theme file.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ThemeProblem {
    /// Unparseable JSON, a key the file does not take, or a value of the
    /// wrong type. serde names the key and the line.
    #[error("{0}")]
    Json(String),
    #[error("defaults.{key} is {value:?}, expected one of {}", .allowed.join(", "))]
    NotOneOf {
        key: &'static str,
        value: String,
        allowed: &'static [&'static str],
    },
    #[error(
        "defaults.accent is {value:?}, expected a six-digit hex color such as #3a7bd5 or one of {}",
        ACCENT_PRESETS.join(", ")
    )]
    Accent { value: String },
    #[error("tokens.{preset} names {token:?}, which is not a theme token")]
    UnknownToken { preset: &'static str, token: String },
    #[error("tokens.{preset} names {token:?}, which a user setting decides; set {instead}")]
    PreferenceToken {
        preset: &'static str,
        token: String,
        instead: &'static str,
    },
    #[error("tokens.{preset}.{token} is {value:?}, which {reason}")]
    TokenValue {
        preset: &'static str,
        token: String,
        value: String,
        reason: &'static str,
    },
}

/// A validated theme file. Serializes to the body [`ROUTE_PATH`] serves.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeploymentTheme {
    #[serde(default)]
    pub defaults: ThemeDefaults,
    #[serde(default)]
    pub tokens: TokenOverrides,
}

/// Defaults for the appearance preferences. A user's saved choice still
/// wins over each.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ThemeDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_background: Option<String>,
}

/// Token values per resolved theme preset, each applied only while that
/// preset is showing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TokenOverrides {
    #[serde(default)]
    pub dark: BTreeMap<String, String>,
    #[serde(default)]
    pub light: BTreeMap<String, String>,
}

impl DeploymentTheme {
    /// Read [`FILE_VAR`] from the process environment. `Ok(None)` means
    /// no file is configured and the client keeps its built-in defaults.
    pub fn from_env() -> Result<Option<Self>, DeploymentThemeError> {
        Self::from_env_map(|name| std::env::var(name).ok())
    }

    /// [`Self::from_env`] over any reader, so tests need no process state.
    /// Unset and blank both mean off, as for the other optional features.
    pub fn from_env_map<F>(read: F) -> Result<Option<Self>, DeploymentThemeError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let Some(path) = read(FILE_VAR)
            .map(|raw| raw.trim().to_string())
            .filter(|path| !path.is_empty())
        else {
            return Ok(None);
        };
        Self::load(Path::new(&path)).map(Some)
    }

    pub fn load(path: &Path) -> Result<Self, DeploymentThemeError> {
        let text = std::fs::read_to_string(path).map_err(|source| DeploymentThemeError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        Self::parse(&text).map_err(|problem| DeploymentThemeError::Invalid {
            path: path.to_path_buf(),
            problem,
        })
    }

    pub fn parse(text: &str) -> Result<Self, ThemeProblem> {
        let theme: Self =
            serde_json::from_str(text).map_err(|e| ThemeProblem::Json(e.to_string()))?;
        theme.validate()?;
        Ok(theme)
    }

    fn validate(&self) -> Result<(), ThemeProblem> {
        let d = &self.defaults;
        one_of("theme", d.theme.as_deref(), THEME_OPTIONS)?;
        one_of("density", d.density.as_deref(), DENSITIES)?;
        one_of(
            "canvasBackground",
            d.canvas_background.as_deref(),
            CANVAS_BACKGROUNDS,
        )?;
        if let Some(accent) = d.accent.as_deref()
            && !ACCENT_PRESETS.contains(&accent)
            && !is_hex_color(accent)
        {
            return Err(ThemeProblem::Accent {
                value: accent.to_string(),
            });
        }
        for (preset, tokens) in [("dark", &self.tokens.dark), ("light", &self.tokens.light)] {
            for (token, value) in tokens {
                validate_token(preset, token, value)?;
            }
        }
        Ok(())
    }

    /// The [`ROUTE_PATH`] body: this theme, or the fixed shape with
    /// `configured: false` when there is none.
    pub fn body(theme: Option<&Self>) -> String {
        #[derive(Serialize)]
        struct Body<'a> {
            configured: bool,
            #[serde(flatten)]
            theme: &'a DeploymentTheme,
        }
        let unconfigured = Self::default();
        serde_json::to_string(&Body {
            configured: theme.is_some(),
            theme: theme.unwrap_or(&unconfigured),
        })
        .expect("strings and maps of strings always serialize")
    }

    /// The element that replaces [`INDEX_MARKER`]: the route body as a
    /// JSON data block. `<` is escaped so no value can close the element.
    pub fn index_snippet(&self) -> String {
        let json = Self::body(Some(self)).replace('<', "\\u003c");
        format!(r#"<script type="application/json" id="{ELEMENT_ID}">{json}</script>"#)
    }
}

fn one_of(
    key: &'static str,
    value: Option<&str>,
    allowed: &'static [&'static str],
) -> Result<(), ThemeProblem> {
    match value {
        Some(v) if !allowed.contains(&v) => Err(ThemeProblem::NotOneOf {
            key,
            value: v.to_string(),
            allowed,
        }),
        _ => Ok(()),
    }
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn validate_token(preset: &'static str, token: &str, value: &str) -> Result<(), ThemeProblem> {
    if let Some((_, instead)) = PREFERENCE_TOKENS.iter().find(|(name, _)| *name == token) {
        return Err(ThemeProblem::PreferenceToken {
            preset,
            token: token.to_string(),
            instead,
        });
    }
    if !TOKEN_NAMES.contains(&token) {
        return Err(ThemeProblem::UnknownToken {
            preset,
            token: token.to_string(),
        });
    }
    if let Some(reason) = unsafe_css_value(value) {
        return Err(ThemeProblem::TokenValue {
            preset,
            token: token.to_string(),
            value: value.to_string(),
            reason,
        });
    }
    Ok(())
}

/// Why `value` cannot go into a declaration as written, if it cannot. The
/// client writes each value into a stylesheet verbatim, so a value must
/// not end its declaration, rule, or element, or swallow the ones after it.
fn unsafe_css_value(value: &str) -> Option<&'static str> {
    if value.trim().is_empty() {
        return Some("is blank");
    }
    if value.chars().any(char::is_control) {
        return Some("holds a line break or control character");
    }
    if value.contains([';', '{', '}', '<', '>', '!', '\\']) {
        return Some("holds one of ; { } < > ! \\");
    }
    if value.contains("/*") {
        return Some("holds a comment");
    }
    let mut depth = 0i32;
    for c in value.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if depth < 0 {
            break;
        }
    }
    if depth != 0 {
        return Some("leaves a parenthesis unbalanced");
    }
    None
}

/// `GET` [`ROUTE_PATH`], which answers whether or not a theme is
/// configured. Merge into the **public** router half.
pub fn router(theme: Option<&DeploymentTheme>) -> Router {
    let body: Arc<str> = DeploymentTheme::body(theme).into();
    Router::new().route(
        ROUTE_PATH,
        get(move || {
            let body = Arc::clone(&body);
            async move {
                (
                    [
                        (header::CONTENT_TYPE, "application/json"),
                        // Revalidate, so a restart with a new file shows on
                        // the next load.
                        (header::CACHE_CONTROL, "no-cache"),
                    ],
                    body.to_string(),
                )
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use serde_json::{Value, json};
    use tower::ServiceExt as _;

    use super::*;

    fn problem(text: &str) -> ThemeProblem {
        DeploymentTheme::parse(text).expect_err("the file is refused")
    }

    async fn get_body(app: Router) -> (StatusCode, Option<String>, Value) {
        let res = app
            .oneshot(
                Request::builder()
                    .uri(ROUTE_PATH)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        let content_type = res
            .headers()
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap().to_string());
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        (
            status,
            content_type,
            serde_json::from_slice(&bytes).unwrap(),
        )
    }

    #[test]
    fn unset_or_blank_means_no_theme() {
        for value in [None, Some(""), Some("  ")] {
            let theme = DeploymentTheme::from_env_map(|_| value.map(str::to_string))
                .expect("off is not an error");
            assert!(theme.is_none(), "{value:?}");
        }
    }

    #[test]
    fn a_missing_file_names_the_variable_and_the_path() {
        let err = DeploymentTheme::from_env_map(|_| Some("/no/such/theme.json".to_string()))
            .expect_err("the file is missing");
        let message = err.to_string();
        assert!(
            message.starts_with("LUCIDA_THEME_FILE=/no/such/theme.json: cannot read the file"),
            "{message}"
        );
    }

    #[test]
    fn a_full_file_loads_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("theme.json");
        std::fs::write(
            &path,
            r##"{
              "defaults": {"theme": "light", "accent": "#0F8278", "density": "compact", "canvasBackground": "white"},
              "tokens": {"dark": {"--lc-bg": "#101014"}, "light": {"--lc-font": "\"Inter\", system-ui"}}
            }"##,
        )
        .unwrap();
        let theme = DeploymentTheme::from_env_map(|_| Some(path.display().to_string()))
            .unwrap()
            .expect("configured");
        assert_eq!(theme.defaults.theme.as_deref(), Some("light"));
        assert_eq!(theme.defaults.accent.as_deref(), Some("#0F8278"));
        assert_eq!(theme.defaults.density.as_deref(), Some("compact"));
        assert_eq!(theme.defaults.canvas_background.as_deref(), Some("white"));
        assert_eq!(theme.tokens.dark["--lc-bg"], "#101014");
        assert_eq!(theme.tokens.light["--lc-font"], "\"Inter\", system-ui");
    }

    #[test]
    fn every_key_is_optional() {
        assert_eq!(
            DeploymentTheme::parse("{}").unwrap(),
            DeploymentTheme::default()
        );
        let theme = DeploymentTheme::parse(r#"{"defaults": {"accent": "teal"}}"#).unwrap();
        assert_eq!(theme.defaults.accent.as_deref(), Some("teal"));
        assert!(theme.tokens.dark.is_empty() && theme.tokens.light.is_empty());
    }

    #[test]
    fn malformed_json_and_unknown_keys_are_named() {
        assert!(matches!(problem("{"), ThemeProblem::Json(_)));
        let ThemeProblem::Json(message) = problem(r#"{"default": {}}"#) else {
            panic!("expected a JSON problem");
        };
        assert!(message.contains("unknown field `default`"), "{message}");
        let ThemeProblem::Json(message) = problem(r#"{"tokens": {"sepia": {}}}"#) else {
            panic!("expected a JSON problem");
        };
        assert!(message.contains("unknown field `sepia`"), "{message}");
        let ThemeProblem::Json(message) = problem(r#"{"tokens": {"dark": {"--lc-radius": 4}}}"#)
        else {
            panic!("expected a JSON problem");
        };
        assert!(message.contains("expected a string"), "{message}");
    }

    #[test]
    fn a_default_outside_its_choices_is_refused() {
        assert_eq!(
            problem(r#"{"defaults": {"theme": "sepia"}}"#).to_string(),
            r#"defaults.theme is "sepia", expected one of dark, light, system"#
        );
        assert!(matches!(
            problem(r#"{"defaults": {"density": "roomy"}}"#),
            ThemeProblem::NotOneOf { key: "density", .. }
        ));
        assert!(matches!(
            problem(r#"{"defaults": {"canvasBackground": "red"}}"#),
            ThemeProblem::NotOneOf {
                key: "canvasBackground",
                ..
            }
        ));
        for accent in ["#12ab9", "#12ab9fz", "12ab9f", "purple"] {
            assert_eq!(
                problem(&format!(r#"{{"defaults": {{"accent": "{accent}"}}}}"#)),
                ThemeProblem::Accent {
                    value: accent.to_string()
                }
            );
        }
    }

    #[test]
    fn an_unknown_token_is_refused_with_its_preset() {
        assert_eq!(
            problem(r##"{"tokens": {"light": {"--lc-surface-9": "#fff"}}}"##).to_string(),
            r#"tokens.light names "--lc-surface-9", which is not a theme token"#
        );
    }

    #[test]
    fn a_token_a_user_setting_decides_points_at_the_default_instead() {
        assert_eq!(
            problem(r##"{"tokens": {"dark": {"--lc-accent": "#ff0000"}}}"##).to_string(),
            r#"tokens.dark names "--lc-accent", which a user setting decides; set defaults.accent"#
        );
        for (token, _) in PREFERENCE_TOKENS {
            assert!(
                TOKEN_NAMES.contains(token),
                "{token} is a preference token but not a token"
            );
        }
    }

    #[test]
    fn a_value_that_could_escape_its_declaration_is_refused() {
        for value in [
            "",
            " ",
            "red; --lc-text: blue",
            "red}",
            "red</style>",
            "red !important",
            "red\\9",
            "red /* x",
            "rgb(0 0 0",
            "rgb(0 0 0))",
            "line\nbreak",
        ] {
            let text =
                serde_json::to_string(&json!({"tokens": {"dark": {"--lc-bg": value}}})).unwrap();
            assert!(
                matches!(problem(&text), ThemeProblem::TokenValue { .. }),
                "{value:?}"
            );
        }
        let ok = json!({"tokens": {"dark": {
            "--lc-bg": "rgba(0, 0, 0, 0.5)",
            "--lc-surface-3": "color-mix(in oklab, var(--lc-text) 8%, transparent)",
            "--lc-font": "\"Segoe UI\", 'Inter', sans-serif",
            "--lc-shadow-1": "0 1px 2px rgb(0 0 0 / 35%)",
        }}});
        DeploymentTheme::parse(&ok.to_string()).expect("ordinary CSS values pass");
    }

    #[tokio::test]
    async fn the_route_says_when_nothing_is_configured() {
        let (status, content_type, body) = get_body(router(None)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type.as_deref(), Some("application/json"));
        assert_eq!(
            body,
            json!({"configured": false, "defaults": {}, "tokens": {"dark": {}, "light": {}}})
        );
    }

    #[tokio::test]
    async fn the_route_serves_the_configured_theme() {
        let theme = DeploymentTheme::parse(
            r##"{"defaults": {"theme": "light", "accent": "#0f8278"}, "tokens": {"light": {"--lc-bg": "#fafafa"}}}"##,
        )
        .unwrap();
        let (status, _, body) = get_body(router(Some(&theme))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "configured": true,
                "defaults": {"theme": "light", "accent": "#0f8278"},
                "tokens": {"dark": {}, "light": {"--lc-bg": "#fafafa"}},
            })
        );
    }

    #[test]
    fn the_index_snippet_is_the_route_body_and_cannot_close_its_element() {
        // Validation refuses `<` in a value, so build the theme directly to
        // prove the snippet would escape one anyway.
        let mut theme = DeploymentTheme::default();
        theme
            .tokens
            .dark
            .insert("--lc-font".into(), "\"</script>\", serif".into());
        let snippet = theme.index_snippet();
        let open = r#"<script type="application/json" id="lucida-deployment-theme">"#;
        let json = snippet
            .strip_prefix(open)
            .and_then(|s| s.strip_suffix("</script>"))
            .expect("one data element");
        assert!(!json.contains('<'), "{json}");
        let parsed: Value = serde_json::from_str(json).unwrap();
        let body: Value = serde_json::from_str(&DeploymentTheme::body(Some(&theme))).unwrap();
        assert_eq!(parsed, body);
    }
}
