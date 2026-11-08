//! What a chunk nobody wrote reads as: the array's fill value.

use lucida_content::DataType;
use serde::{Deserialize, Serialize};

use crate::backend::StoreError;

/// One sample of an array's fill value, as the wire carries it: its
/// little-endian bytes. A chunk the object store does not hold reads as
/// this sample repeated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FillValue {
    sample: [u8; 8],
    size: u8,
}

impl Default for FillValue {
    fn default() -> Self {
        FillValue {
            sample: [0; 8],
            size: 1,
        }
    }
}

impl FillValue {
    /// Parse an array's `fill_value` as a sample of `data_type`. Takes the
    /// forms Zarr v3 and Zarr v2 write: a number, `"NaN"`, `"Infinity"`, or
    /// `"-Infinity"`, and for floats Zarr v3's `"0x..."` bit pattern. A
    /// `null`, Zarr v2's "no fill value", reads as zero, as zarr-python
    /// reads it.
    pub fn parse(value: &serde_json::Value, data_type: DataType) -> Result<Self, StoreError> {
        let refused = || {
            StoreError::malformed_metadata(format!(
                "fill_value {value} is not a {data_type:?} value"
            ))
        };
        if value.is_null() {
            return Ok(Self::zero(data_type));
        }
        let sample = match data_type {
            DataType::Float32 => float(value).ok_or_else(refused).map(|bits| match bits {
                Float::Value(v) => (v as f32).to_le_bytes().to_vec(),
                Float::Bits(bits) => u32::try_from(bits)
                    .map(|b| b.to_le_bytes().to_vec())
                    .unwrap_or_default(),
            })?,
            DataType::Float64 => float(value).ok_or_else(refused).map(|bits| match bits {
                Float::Value(v) => v.to_le_bytes().to_vec(),
                Float::Bits(bits) => bits.to_le_bytes().to_vec(),
            })?,
            DataType::Float16 => float(value).ok_or_else(refused).map(|bits| match bits {
                Float::Value(v) => f16_bits(v as f32).to_le_bytes().to_vec(),
                Float::Bits(bits) => u16::try_from(bits)
                    .map(|b| b.to_le_bytes().to_vec())
                    .unwrap_or_default(),
            })?,
            _ => {
                let integer = integer(value).ok_or_else(refused)?;
                let fits = |bytes: Option<Vec<u8>>| bytes.ok_or_else(refused);
                match data_type {
                    DataType::Uint8 => fits(u8::try_from(integer).ok().map(|v| vec![v]))?,
                    DataType::Uint16 => fits(
                        u16::try_from(integer)
                            .ok()
                            .map(|v| v.to_le_bytes().to_vec()),
                    )?,
                    DataType::Uint32 => fits(
                        u32::try_from(integer)
                            .ok()
                            .map(|v| v.to_le_bytes().to_vec()),
                    )?,
                    DataType::Int8 => {
                        fits(i8::try_from(integer).ok().map(|v| v.to_le_bytes().to_vec()))?
                    }
                    DataType::Int16 => fits(
                        i16::try_from(integer)
                            .ok()
                            .map(|v| v.to_le_bytes().to_vec()),
                    )?,
                    DataType::Int32 => fits(
                        i32::try_from(integer)
                            .ok()
                            .map(|v| v.to_le_bytes().to_vec()),
                    )?,
                    DataType::Uint64 => fits(
                        u64::try_from(integer)
                            .ok()
                            .map(|v| v.to_le_bytes().to_vec()),
                    )?,
                    DataType::Int64 => fits(
                        i64::try_from(integer)
                            .ok()
                            .map(|v| v.to_le_bytes().to_vec()),
                    )?,
                    DataType::Float16 | DataType::Float32 | DataType::Float64 => {
                        unreachable!("floats parse above")
                    }
                }
            }
        };
        if sample.len() != data_type.size_bytes() {
            return Err(refused());
        }
        let mut bytes = [0; 8];
        bytes[..sample.len()].copy_from_slice(&sample);
        Ok(FillValue {
            sample: bytes,
            size: sample.len() as u8,
        })
    }

    fn zero(data_type: DataType) -> Self {
        FillValue {
            sample: [0; 8],
            size: data_type.size_bytes() as u8,
        }
    }

    /// Whether every byte of the fill is zero, so a fill buffer can be
    /// allocated zeroed.
    pub fn is_zero(&self) -> bool {
        self.sample.iter().all(|&b| b == 0)
    }

    /// `len` bytes of fill. A length that is not a whole number of samples
    /// ends part way through one.
    pub fn bytes(&self, len: usize) -> Vec<u8> {
        if self.is_zero() {
            return vec![0; len];
        }
        let sample = &self.sample[..self.size as usize];
        sample.iter().copied().cycle().take(len).collect()
    }
}

enum Float {
    Value(f64),
    /// The IEEE 754 bit pattern, as Zarr v3 writes one in hex.
    Bits(u64),
}

fn float(value: &serde_json::Value) -> Option<Float> {
    match value {
        serde_json::Value::Number(n) => n.as_f64().map(Float::Value),
        serde_json::Value::String(s) => match s.as_str() {
            "NaN" => Some(Float::Value(f64::NAN)),
            "Infinity" => Some(Float::Value(f64::INFINITY)),
            "-Infinity" => Some(Float::Value(f64::NEG_INFINITY)),
            hex => hex
                .strip_prefix("0x")
                .and_then(|digits| u64::from_str_radix(digits, 16).ok())
                .map(Float::Bits),
        },
        _ => None,
    }
}

/// The IEEE 754 half-precision bits nearest `value`, ties to even. A value
/// past the largest half is infinite, and a NaN stays a NaN.
fn f16_bits(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32;
    let mantissa = bits & 0x7f_ffff;
    if exponent == 0xff {
        let nan = if mantissa != 0 { 0x200 } else { 0 };
        return sign | 0x7c00 | nan;
    }
    // The half exponent, unbiased from float32's 127 and rebiased to 15.
    let half_exponent = exponent - 127 + 15;
    if half_exponent >= 0x1f {
        return sign | 0x7c00;
    }
    if half_exponent <= 0 {
        // Subnormal or zero: shift the implicit bit into the mantissa.
        if half_exponent < -10 {
            return sign;
        }
        let full = mantissa | 0x80_0000;
        let shift = (14 - half_exponent) as u32;
        let half = full >> shift;
        let rest = full & ((1 << shift) - 1);
        let halfway = 1 << (shift - 1);
        let round_up = rest > halfway || (rest == halfway && half & 1 == 1);
        return sign | (half + round_up as u32) as u16;
    }
    let half = ((half_exponent as u32) << 10) | (mantissa >> 13);
    let rest = mantissa & 0x1fff;
    let round_up = rest > 0x1000 || (rest == 0x1000 && half & 1 == 1);
    // A carry out of the mantissa steps the exponent, up to infinity.
    sign | (half + round_up as u32) as u16
}

/// An integer fill value, written as an integer or as a float that is one.
fn integer(value: &serde_json::Value) -> Option<i128> {
    let n = value.as_number()?;
    if let Some(i) = n.as_i64() {
        return Some(i.into());
    }
    if let Some(u) = n.as_u64() {
        return Some(u.into());
    }
    let f = n.as_f64()?;
    (f.fract() == 0.0 && f.abs() < 1e18).then_some(f as i128)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fill(value: serde_json::Value, data_type: DataType) -> FillValue {
        FillValue::parse(&value, data_type).unwrap()
    }

    #[test]
    fn zero_and_null_fill_with_zeros() {
        for value in [json!(0), json!(null), json!(0.0)] {
            let f = fill(value, DataType::Uint16);
            assert!(f.is_zero());
            assert_eq!(f.bytes(4), vec![0; 4]);
        }
    }

    #[test]
    fn an_integer_fill_repeats_its_little_endian_bytes() {
        assert_eq!(
            fill(json!(258), DataType::Uint16).bytes(6),
            [2, 1, 2, 1, 2, 1]
        );
        assert_eq!(fill(json!(-2), DataType::Int8).bytes(2), [0xfe, 0xfe]);
        assert_eq!(fill(json!(7.0), DataType::Int32).bytes(4), [7, 0, 0, 0]);
    }

    #[test]
    fn float_fills_take_every_written_form() {
        let nan = fill(json!("NaN"), DataType::Float32).bytes(4);
        assert!(f32::from_le_bytes(nan.try_into().unwrap()).is_nan());
        let inf = fill(json!("-Infinity"), DataType::Float64).bytes(8);
        assert_eq!(
            f64::from_le_bytes(inf.try_into().unwrap()),
            f64::NEG_INFINITY
        );
        let bits = fill(json!("0x3fc00000"), DataType::Float32).bytes(4);
        assert_eq!(f32::from_le_bytes(bits.try_into().unwrap()), 1.5);
        let value = fill(json!(-0.5), DataType::Float32).bytes(4);
        assert_eq!(f32::from_le_bytes(value.try_into().unwrap()), -0.5);
    }

    #[test]
    fn a_half_fill_is_the_nearest_half() {
        let half = |value: serde_json::Value| {
            let bytes = fill(value, DataType::Float16).bytes(2);
            u16::from_le_bytes(bytes.try_into().unwrap())
        };
        assert_eq!(half(json!(1.0)), 0x3c00);
        assert_eq!(half(json!(-2.5)), 0xc100);
        assert_eq!(half(json!(65504.0)), 0x7bff);
        assert_eq!(half(json!(1e6)), 0x7c00);
        assert_eq!(half(json!("-Infinity")), 0xfc00);
        assert_eq!(half(json!("NaN")) & 0x7c00, 0x7c00);
        assert_ne!(half(json!("NaN")) & 0x3ff, 0);
        // The smallest subnormal, and halfway below it rounding to even zero.
        assert_eq!(half(json!(5.960_464_5e-8)), 0x0001);
        assert_eq!(half(json!(2.980_232_2e-8)), 0x0000);
        // 1 + 2^-11 is halfway between 1 and the next half: ties to even.
        assert_eq!(half(json!(1.000_488_281_25)), 0x3c00);
        assert_eq!(half(json!("0x3555")), 0x3555);
    }

    #[test]
    fn a_64_bit_integer_fill_takes_its_whole_range() {
        let max = fill(json!(u64::MAX), DataType::Uint64).bytes(8);
        assert_eq!(u64::from_le_bytes(max.try_into().unwrap()), u64::MAX);
        let min = fill(json!(i64::MIN), DataType::Int64).bytes(8);
        assert_eq!(i64::from_le_bytes(min.try_into().unwrap()), i64::MIN);
    }

    #[test]
    fn a_fill_the_data_type_cannot_hold_is_refused() {
        for (value, data_type) in [
            (json!(256), DataType::Uint8),
            (json!(-1), DataType::Uint16),
            (json!(1.5), DataType::Int32),
            (json!("NaN"), DataType::Uint16),
            (json!("0x7ff8000000000000"), DataType::Float32),
            (json!("0x7e000"), DataType::Float16),
            (json!(-1), DataType::Uint64),
            (json!([0]), DataType::Float64),
        ] {
            let err = FillValue::parse(&value, data_type).unwrap_err();
            assert!(err.to_string().contains(&value.to_string()), "{err}");
        }
    }
}
