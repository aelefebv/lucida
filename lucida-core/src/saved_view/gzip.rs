//! The gzip member a `#view=` payload carries, framed here around
//! `miniz_oxide`'s raw deflate. flate2 does the same in one call, but in the
//! WASM module every viewer downloads it costs nearly twice as much.
//!
//! The header and the deflate level are part of the payload's bytes, which
//! every client must agree on, so they stay what flate2 wrote.

use miniz_oxide::inflate::{TINFLStatus, decompress_to_vec_with_limit};

/// No name, no modification time, operating system unknown.
const HEADER: [u8; 10] = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff];
const LEVEL: u8 = 6;

/// `data` as one gzip member.
pub(super) fn compress(data: &[u8]) -> Vec<u8> {
    let deflated = miniz_oxide::deflate::compress_to_vec(data, LEVEL);
    let mut member = Vec::with_capacity(HEADER.len() + deflated.len() + 8);
    member.extend_from_slice(&HEADER);
    member.extend_from_slice(&deflated);
    member.extend_from_slice(&crc32(data).to_le_bytes());
    member.extend_from_slice(&(data.len() as u32).to_le_bytes());
    member
}

/// Why a gzip member did not decompress.
#[derive(Debug)]
pub(super) enum GunzipError {
    /// It inflates past the limit it was given.
    TooLarge,
    Corrupt(String),
}

/// The data in `member`, a single gzip member, refused once it inflates past
/// `limit` bytes.
pub(super) fn decompress(member: &[u8], limit: usize) -> Result<Vec<u8>, GunzipError> {
    let corrupt = |why: &str| GunzipError::Corrupt(why.to_owned());
    let body = skip_header(member).ok_or_else(|| corrupt("not a gzip header"))?;
    let (deflated, trailer) = body
        .split_last_chunk::<8>()
        .ok_or_else(|| corrupt("truncated"))?;
    let data = decompress_to_vec_with_limit(deflated, limit).map_err(|e| match e.status {
        TINFLStatus::HasMoreOutput => GunzipError::TooLarge,
        _ => GunzipError::Corrupt(e.to_string()),
    })?;
    let (crc, size) = trailer.split_at(4);
    if crc != crc32(&data).to_le_bytes() || size != (data.len() as u32).to_le_bytes() {
        return Err(corrupt("checksum mismatch"));
    }
    Ok(data)
}

/// What follows the header, which may carry any of RFC 1952's optional
/// fields: a payload from any gzip writer reads.
fn skip_header(member: &[u8]) -> Option<&[u8]> {
    const FHCRC: u8 = 1 << 1;
    const FEXTRA: u8 = 1 << 2;
    const FNAME: u8 = 1 << 3;
    const FCOMMENT: u8 = 1 << 4;
    const RESERVED: u8 = 0b1110_0000;

    let [0x1f, 0x8b, 8, flags, _, _, _, _, _, _, rest @ ..] = member else {
        return None;
    };
    if flags & RESERVED != 0 {
        return None;
    }
    let mut rest = rest;
    if flags & FEXTRA != 0 {
        let [lo, hi, extra @ ..] = rest else {
            return None;
        };
        rest = extra.get(usize::from(u16::from_le_bytes([*lo, *hi]))..)?;
    }
    for field in [FNAME, FCOMMENT] {
        if flags & field != 0 {
            rest = &rest[rest.iter().position(|&b| b == 0)? + 1..];
        }
    }
    if flags & FHCRC != 0 {
        rest = rest.get(2..)?;
    }
    Some(rest)
}

/// CRC-32 (IEEE), bytewise from one table. crc32fast's sixteen tables would
/// add 16 KB to the WASM module, to speed up payloads of a few kilobytes.
fn crc32(data: &[u8]) -> u32 {
    const TABLE: [u32; 256] = {
        let mut table = [0; 256];
        let mut i = 0;
        while i < 256 {
            let mut c = i as u32;
            let mut bit = 0;
            while bit < 8 {
                c = if c & 1 == 1 {
                    0xedb8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
                bit += 1;
            }
            table[i] = c;
            i += 1;
        }
        table
    };
    !data
        .iter()
        .fold(!0, |c, &b| TABLE[usize::from(c as u8 ^ b)] ^ (c >> 8))
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use flate2::write::GzEncoder;
    use flate2::{Compression, GzBuilder};

    use super::*;

    fn flate2_gzip(data: &[u8]) -> Vec<u8> {
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(data).unwrap();
        gz.finish().unwrap()
    }

    /// Short and long, repetitive and not, past one deflate block.
    fn samples() -> Vec<Vec<u8>> {
        let mut noise = Vec::new();
        let mut x = 0x2545_f491_u32;
        for _ in 0..200_000 {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            noise.push(b"{}[],:0123456789.e-\"abcdefgh"[(x % 28) as usize]);
        }
        let json = br#"{"v":2,"camera":{"mode":"slice","center":[1024.5,-512.25],"zoom":1.5}}"#;
        vec![
            Vec::new(),
            b"a".to_vec(),
            json.to_vec(),
            json.repeat(5_000),
            noise,
        ]
    }

    #[test]
    fn it_writes_the_bytes_flate2_wrote() {
        for data in samples() {
            assert_eq!(compress(&data), flate2_gzip(&data), "{} bytes", data.len());
        }
    }

    #[test]
    fn it_reads_what_flate2_reads() {
        for data in samples() {
            let member = compress(&data);
            let mut back = Vec::new();
            flate2::read::GzDecoder::new(member.as_slice())
                .read_to_end(&mut back)
                .unwrap();
            assert_eq!(back, data);
            assert_eq!(decompress(&member, usize::MAX).unwrap(), data);
        }
    }

    #[test]
    fn it_reads_every_optional_header_field() {
        let data = b"{\"v\":2}";
        let mut gz = GzBuilder::new()
            .extra(vec![1, 2, 3])
            .filename("view.json")
            .comment("a comment")
            .mtime(1_700_000_000)
            .operating_system(3)
            .write(Vec::new(), Compression::best());
        gz.write_all(data).unwrap();
        assert_eq!(decompress(&gz.finish().unwrap(), usize::MAX).unwrap(), data);

        // A header checksum, which flate2 does not write.
        let mut member = compress(data);
        member[3] = 1 << 1;
        member.splice(10..10, [0xab, 0xcd]);
        assert_eq!(decompress(&member, usize::MAX).unwrap(), data);
    }

    #[test]
    fn a_damaged_member_is_refused() {
        let member = compress(b"{\"v\":2,\"camera\":{}}");
        let corrupt =
            |member: &[u8]| matches!(decompress(member, usize::MAX), Err(GunzipError::Corrupt(_)));

        let mut flipped = member.clone();
        let last = flipped.len() - 1;
        flipped[last] ^= 1;
        assert!(corrupt(&flipped), "a wrong length");
        let mut flipped = member.clone();
        flipped[member.len() - 8] ^= 1;
        assert!(corrupt(&flipped), "a wrong checksum");
        assert!(corrupt(&member[..member.len() - 1]), "a cut trailer");
        let trailer = &member[member.len() - 8..];
        assert!(corrupt(&[&member[..12], trailer].concat()), "a cut body");
        assert!(corrupt(&[&member[..10], trailer].concat()), "an empty body");
        assert!(corrupt(&member[..10]), "no trailer");
        assert!(corrupt(&member[1..]), "no magic");
        let mut reserved = member.clone();
        reserved[3] = 0x20;
        assert!(corrupt(&reserved), "a reserved flag");
    }

    #[test]
    fn the_limit_is_inclusive() {
        let data = vec![b' '; 4096];
        let member = compress(&data);
        assert_eq!(decompress(&member, 4096).unwrap(), data);
        assert!(matches!(
            decompress(&member, 4095),
            Err(GunzipError::TooLarge)
        ));
    }

    #[test]
    fn crc32_matches_the_check_value() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b""), 0);
    }
}
