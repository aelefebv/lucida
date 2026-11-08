//! Chunk keys: a chunk's address within one image, parsed once where a
//! request enters ([`ChunkKey::parse`]).
//!
//! Only the canonical spelling parses, so a key prints back as the exact
//! string it was parsed from. A reply keyed by that string lands on the
//! request that asked, and a key that drifted from the grammar is refused
//! rather than read as level 0 or as fill.

use std::fmt;
use std::str::FromStr;

/// The parts of a key, in the order they are written.
const PARTS: [&str; 6] = ["level", "t", "c", "z", "y", "x"];

/// `level/t/c/z/y/x`: `t` and `c` count samples, and `z`, `y` and `x` count
/// chunks along their axes of the level's chunk grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ChunkKey {
    pub level: u32,
    pub t: u64,
    pub c: u64,
    pub z: u64,
    pub y: u64,
    pub x: u64,
}

/// Why a string is not a [`ChunkKey`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkKeyError {
    /// The key does not have six `/`-separated parts.
    PartCount { found: usize },
    /// A part is not a decimal integer in canonical form: digits only, no
    /// sign, no leading zero, and within its range.
    Part { name: &'static str, value: String },
}

impl fmt::Display for ChunkKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ChunkKeyError::PartCount { found } => write!(
                f,
                "a chunk key has 6 parts, level/t/c/z/y/x, and this one has {found}"
            ),
            ChunkKeyError::Part { name, value } => write!(
                f,
                "chunk key part {name} is {value:?}, not a canonical decimal integer"
            ),
        }
    }
}

impl std::error::Error for ChunkKeyError {}

impl ChunkKey {
    pub fn parse(input: &str) -> Result<ChunkKey, ChunkKeyError> {
        let parts: Vec<&str> = input.split('/').collect();
        let [level, t, c, z, y, x] = parts[..] else {
            return Err(ChunkKeyError::PartCount { found: parts.len() });
        };
        Ok(ChunkKey {
            level: canonical(PARTS[0], level)?,
            t: canonical(PARTS[1], t)?,
            c: canonical(PARTS[2], c)?,
            z: canonical(PARTS[3], z)?,
            y: canonical(PARTS[4], y)?,
            x: canonical(PARTS[5], x)?,
        })
    }
}

/// `value` as a `T`, if it is spelled the one way `T` prints it.
fn canonical<T: FromStr + ToString>(name: &'static str, value: &str) -> Result<T, ChunkKeyError> {
    let refuse = || ChunkKeyError::Part {
        name,
        value: value.to_string(),
    };
    if !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(refuse());
    }
    let parsed: T = value.parse().map_err(|_| refuse())?;
    // Rejects the leading zeros the digit check let through.
    if parsed.to_string() != value {
        return Err(refuse());
    }
    Ok(parsed)
}

impl fmt::Display for ChunkKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ChunkKey {
            level,
            t,
            c,
            z,
            y,
            x,
        } = self;
        write!(f, "{level}/{t}/{c}/{z}/{y}/{x}")
    }
}

impl FromStr for ChunkKey {
    type Err = ChunkKeyError;

    fn from_str(input: &str) -> Result<Self, Self::Err> {
        ChunkKey::parse(input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_canonical_key_parses_to_its_parts_and_prints_back() {
        let key = ChunkKey::parse("2/0/13/4/0/7").unwrap();
        assert_eq!(
            key,
            ChunkKey {
                level: 2,
                t: 0,
                c: 13,
                z: 4,
                y: 0,
                x: 7
            }
        );
        assert_eq!(key.to_string(), "2/0/13/4/0/7");
    }

    #[test]
    fn each_malformed_shape_names_what_is_wrong() {
        assert_eq!(
            ChunkKey::parse("0/0/1"),
            Err(ChunkKeyError::PartCount { found: 3 })
        );
        assert_eq!(
            ChunkKey::parse("0/0/0/0/0/0/0"),
            Err(ChunkKeyError::PartCount { found: 7 })
        );
        assert_eq!(
            ChunkKey::parse("0/0/1/0/two/3"),
            Err(ChunkKeyError::Part {
                name: "y",
                value: "two".into()
            })
        );
        for (input, name) in [
            ("01/0/0/0/0/0", "level"),
            ("0/+1/0/0/0/0", "t"),
            ("0/0/-1/0/0/0", "c"),
            ("0/0/0/ 1/0/0", "z"),
            ("0/0/0/0//0", "y"),
            ("0/0/0/0/0/18446744073709551616", "x"),
            ("4294967296/0/0/0/0/0", "level"),
        ] {
            match ChunkKey::parse(input) {
                Err(ChunkKeyError::Part { name: found, .. }) => assert_eq!(found, name, "{input}"),
                other => panic!("{input:?} parsed as {other:?}"),
            }
        }
    }

    /// A small deterministic generator, so the property below runs the same
    /// cases on every machine and needs no dependency.
    struct Xorshift(u64);

    impl Xorshift {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    /// The grammar, stated independently of the parser.
    fn is_canonical(input: &str) -> bool {
        let parts: Vec<&str> = input.split('/').collect();
        parts.len() == 6
            && parts.iter().enumerate().all(|(index, part)| {
                let digits = !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
                let no_leading_zero = *part == "0" || !part.starts_with('0');
                let in_range = if index == 0 {
                    part.parse::<u32>().is_ok()
                } else {
                    part.parse::<u64>().is_ok()
                };
                digits && no_leading_zero && in_range
            })
    }

    /// Strings near the grammar, by mutating canonical keys and by drawing
    /// from the characters keys are made of, are refused unless they happen
    /// to be canonical, and every key that parses prints back as its input.
    #[test]
    fn every_string_off_the_grammar_is_refused() {
        const ALPHABET: &[u8] = b"0123456789//+- .ax\0";
        let mut rng = Xorshift(0x9e37_79b9_7f4a_7c15);
        let mut refused = 0;
        for case in 0..20_000 {
            let input = if case % 2 == 0 {
                let mut key = ChunkKey {
                    level: rng.below(12) as u32,
                    t: rng.below(3) as u64,
                    c: rng.below(40) as u64,
                    z: rng.next() % 1_000,
                    y: rng.next(),
                    x: rng.below(9) as u64,
                }
                .to_string()
                .into_bytes();
                for _ in 0..=rng.below(3) {
                    let at = rng.below(key.len() + 1);
                    let byte = ALPHABET[rng.below(ALPHABET.len())];
                    match rng.below(3) {
                        0 => key.insert(at, byte),
                        1 if at < key.len() => key[at] = byte,
                        _ if at < key.len() => {
                            key.remove(at);
                        }
                        _ => key.push(byte),
                    }
                }
                String::from_utf8(key).unwrap()
            } else {
                (0..rng.below(24))
                    .map(|_| ALPHABET[rng.below(ALPHABET.len())] as char)
                    .collect()
            };
            match ChunkKey::parse(&input) {
                Ok(key) => {
                    assert!(is_canonical(&input), "{input:?} parsed as {key:?}");
                    assert_eq!(key.to_string(), input);
                }
                Err(_) => {
                    assert!(!is_canonical(&input), "{input:?} was refused");
                    refused += 1;
                }
            }
        }
        // Most mutations break the grammar; a generator that stopped doing so
        // would pass the loop above while proving nothing.
        assert!(refused > 15_000, "only {refused} of 20000 refused");
    }
}
