use axum::http::StatusCode;
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};

use crate::error::ApiError;

pub fn expect_body_object(payload: Value) -> Result<Map<String, Value>, ApiError> {
    payload.as_object().cloned().ok_or_else(|| {
        invalid_request_error(vec![json!({
            "loc": ["body"],
            "msg": "Input should be a valid dictionary.",
            "type": "dict_type",
        })])
    })
}

pub fn push_extra_forbidden_errors(
    object: &Map<String, Value>,
    allowed_keys: &[&str],
    errors: &mut Vec<Value>,
) {
    for key in object.keys() {
        if !allowed_keys.contains(&key.as_str()) {
            errors.push(json!({
                "loc": ["body", key],
                "msg": "Extra inputs are not permitted.",
                "type": "extra_forbidden",
            }));
        }
    }
}

pub fn parse_schema_version(object: &Map<String, Value>, errors: &mut Vec<Value>) -> u8 {
    match object.get("schema_version") {
        None => 1,
        Some(value) => {
            if let Some(raw) = value.as_u64() {
                raw as u8
            } else if let Some(raw) = value.as_i64() {
                if raw >= 0 {
                    raw as u8
                } else {
                    errors.push(json!({
                        "loc": ["body", "schema_version"],
                        "msg": "Input should be 1.",
                        "type": "literal_error",
                    }));
                    0
                }
            } else {
                errors.push(json!({
                    "loc": ["body", "schema_version"],
                    "msg": "Input should be 1.",
                    "type": "literal_error",
                }));
                0
            }
        }
    }
}

pub fn push_schema_version_literal_error(errors: &mut Vec<Value>) {
    errors.push(json!({
        "loc": ["body", "schema_version"],
        "msg": "Input should be 1.",
        "type": "literal_error",
    }));
}

pub fn parse_required_non_empty_string(
    object: &Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
) -> Option<String> {
    match object.get(key) {
        Some(value) => {
            if let Some(as_str) = value.as_str() {
                if as_str.is_empty() {
                    errors.push(json!({
                        "loc": ["body", key],
                        "msg": "String should have at least 1 character",
                        "type": "string_too_short",
                        "input": as_str,
                        "ctx": {"min_length": 1},
                    }));
                    None
                } else {
                    Some(as_str.to_owned())
                }
            } else {
                errors.push(json!({
                    "loc": ["body", key],
                    "msg": "Input should be a valid string.",
                    "type": "string_type",
                }));
                None
            }
        }
        None => {
            errors.push(json!({
                "loc": ["body", key],
                "msg": "Field required.",
                "type": "missing",
            }));
            None
        }
    }
}

pub fn parse_optional_non_empty_string(
    object: &Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
) -> Option<String> {
    let value = object.get(key)?;
    if value.is_null() {
        return None;
    }
    if let Some(as_str) = value.as_str() {
        if as_str.is_empty() {
            errors.push(json!({
                "loc": ["body", key],
                "msg": "String should have at least 1 character",
                "type": "string_too_short",
                "input": as_str,
                "ctx": {"min_length": 1},
            }));
            return None;
        }
        return Some(as_str.to_owned());
    }
    errors.push(json!({
        "loc": ["body", key],
        "msg": "Input should be a valid string.",
        "type": "string_type",
    }));
    None
}

pub fn parse_optional_bool(
    object: &Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
) -> Option<bool> {
    let value = object.get(key)?;
    if value.is_null() {
        return None;
    }
    if let Some(as_bool) = value.as_bool() {
        return Some(as_bool);
    }
    errors.push(json!({
        "loc": ["body", key],
        "msg": "Input should be a valid boolean.",
        "type": "bool_type",
    }));
    None
}

pub fn parse_optional_typed<T>(
    object: &Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
) -> Option<T>
where
    T: DeserializeOwned,
{
    let value = object.get(key)?;
    if value.is_null() {
        return None;
    }
    match serde_json::from_value::<T>(value.clone()) {
        Ok(parsed) => Some(parsed),
        Err(error) => {
            errors.push(json!({
                "loc": ["body", key],
                "msg": error.to_string(),
                "type": "value_error",
            }));
            None
        }
    }
}

pub fn parse_required_typed<T>(
    object: &Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
) -> Option<T>
where
    T: DeserializeOwned,
{
    let value = match object.get(key) {
        Some(value) => value,
        None => {
            errors.push(json!({
                "loc": ["body", key],
                "msg": "Field required.",
                "type": "missing",
            }));
            return None;
        }
    };
    match serde_json::from_value::<T>(value.clone()) {
        Ok(parsed) => Some(parsed),
        Err(error) => {
            errors.push(json!({
                "loc": ["body", key],
                "msg": error.to_string(),
                "type": "value_error",
            }));
            None
        }
    }
}

pub fn parse_required_positive_u64(
    object: &Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
    loc_prefix: &[&str],
) -> Option<u64> {
    let value = match object.get(key) {
        Some(value) => value,
        None => {
            let mut loc = loc_prefix
                .iter()
                .map(|item| Value::String((*item).to_owned()))
                .collect::<Vec<Value>>();
            loc.push(Value::String(key.to_owned()));
            errors.push(json!({
                "loc": loc,
                "msg": "Field required.",
                "type": "missing",
            }));
            return None;
        }
    };

    let parsed = if let Some(value) = value.as_u64() {
        Some(value)
    } else if let Some(value) = value.as_i64() {
        (value >= 0).then_some(value as u64)
    } else {
        None
    };
    let Some(parsed) = parsed else {
        let mut loc = loc_prefix
            .iter()
            .map(|item| Value::String((*item).to_owned()))
            .collect::<Vec<Value>>();
        loc.push(Value::String(key.to_owned()));
        errors.push(json!({
            "loc": loc,
            "msg": "Input should be a valid integer.",
            "type": "int_type",
        }));
        return None;
    };
    if parsed < 1 {
        let mut loc = loc_prefix
            .iter()
            .map(|item| Value::String((*item).to_owned()))
            .collect::<Vec<Value>>();
        loc.push(Value::String(key.to_owned()));
        errors.push(json!({
            "loc": loc,
            "msg": "Input should be greater than or equal to 1.",
            "type": "greater_than_equal",
        }));
        return None;
    }
    Some(parsed)
}

pub fn parse_optional_patch_list(
    object: &Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
    loc_prefix: &[&str],
) -> Option<Vec<Value>> {
    let value = object.get(key)?;
    if value.is_null() {
        return None;
    }
    let Some(array) = value.as_array() else {
        let mut loc = loc_prefix
            .iter()
            .map(|item| Value::String((*item).to_owned()))
            .collect::<Vec<Value>>();
        loc.push(Value::String(key.to_owned()));
        errors.push(json!({
            "loc": loc,
            "msg": "Input should be a valid list.",
            "type": "list_type",
        }));
        return None;
    };

    if array.iter().any(|item| !item.is_object()) {
        let mut loc = loc_prefix
            .iter()
            .map(|item| Value::String((*item).to_owned()))
            .collect::<Vec<Value>>();
        loc.push(Value::String(key.to_owned()));
        errors.push(json!({
            "loc": loc,
            "msg": "Input should be a valid list of dictionaries.",
            "type": "list_type",
        }));
        return None;
    }
    Some(array.clone())
}

pub fn invalid_request_error(errors: Vec<Value>) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_request",
        "Request validation failed.",
        Some(json!({ "errors": errors })),
    )
}
