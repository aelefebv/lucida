//! BloscLZ, the LZ77 compressor native to Blosc1, decoded as c-blosc's
//! `blosclz_decompress` reads it, refusals included.
//!
//! A stream is a run of tokens. A control byte below 32 starts a literal of
//! that many bytes plus one. Any other control byte starts a match: its top
//! three bits are the length (seven meaning more length bytes follow), its
//! low five the high bits of a distance whose low byte follows, and a far
//! match spells a 16-bit distance after that.

/// Matches this far back and further are spelled with a 16-bit distance.
const MAX_DISTANCE: usize = 8191;

/// Decode `input` into exactly `len` bytes, or `None` where c-blosc's
/// decoder would refuse it or the bytes decode to another length.
pub(super) fn decompress(input: &[u8], len: usize) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(len);
    let Some(&first) = input.first() else {
        return (len == 0).then_some(out);
    };
    let mut ip = 1;
    let mut ctrl = usize::from(first & 31);
    loop {
        if ctrl >= 32 {
            let mut run = (ctrl >> 5) - 1;
            let ofs = (ctrl & 31) << 8;
            if run == 7 - 1 {
                loop {
                    if ip + 1 >= input.len() {
                        return None;
                    }
                    let code = input[ip];
                    ip += 1;
                    run += usize::from(code);
                    if code != 255 {
                        break;
                    }
                }
            } else if ip + 1 >= input.len() {
                return None;
            }
            let code = usize::from(input[ip]);
            ip += 1;
            run += 3;
            // The match starts this many bytes back from the end of `out`.
            let mut distance = ofs + code + 1;
            if code == 255 && ofs == 31 << 8 {
                if ip + 1 >= input.len() {
                    return None;
                }
                let far = (usize::from(input[ip]) << 8) | usize::from(input[ip + 1]);
                ip += 2;
                distance = far + MAX_DISTANCE + 1;
            }
            if out.len() + run > len || distance > out.len() {
                return None;
            }
            // c-blosc checks for the end of input before it copies a match,
            // so a stream that ends on a match drops it. An encoder always
            // ends on a literal.
            if ip >= input.len() {
                break;
            }
            ctrl = usize::from(input[ip]);
            ip += 1;
            let start = out.len() - distance;
            if distance >= run {
                out.extend_from_within(start..start + run);
            } else {
                // The match overlaps what it writes, so it repeats the
                // last `distance` bytes.
                for i in 0..run {
                    out.push(out[start + i]);
                }
            }
        } else {
            let run = ctrl + 1;
            if out.len() + run > len || ip + run > input.len() {
                return None;
            }
            out.extend_from_slice(&input[ip..ip + run]);
            ip += run;
            if ip >= input.len() {
                break;
            }
            ctrl = usize::from(input[ip]);
            ip += 1;
        }
    }
    (out.len() == len).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_literal_alone_decodes_to_itself() {
        // Control 2: a literal of three bytes.
        assert_eq!(decompress(&[2, b'a', b'b', b'c'], 3), Some(b"abc".to_vec()));
    }

    #[test]
    fn a_match_repeats_bytes_already_written() {
        // Literal "ab", then a match of length 4 at distance 2 ("abab"), then
        // a literal "z". A match control's top three bits hold the length
        // less two: 4 - 2 = 2, so 2 << 5 = 0x40; the distance less one, 1,
        // is split into 0 in the low five bits and 1 in the next byte.
        let stream = [1, b'a', b'b', 0x40, 1, 0, b'z'];
        assert_eq!(decompress(&stream, 7), Some(b"abababz".to_vec()));
    }

    #[test]
    fn a_run_of_one_byte_is_a_match_one_back() {
        // Literal "x", a match of length 5 at distance 1, a literal "y".
        let stream = [0, b'x', 0x60, 0, 0, b'y'];
        assert_eq!(decompress(&stream, 7), Some(b"xxxxxxy".to_vec()));
    }

    #[test]
    fn a_stream_that_reaches_before_its_start_or_past_its_length_is_refused() {
        // A match at distance 3 after one literal byte.
        assert_eq!(decompress(&[0, b'x', 0x20, 2, 0, b'y'], 4), None);
        // A literal longer than the block.
        assert_eq!(decompress(&[3, 1, 2, 3, 4], 2), None);
        // A literal cut short.
        assert_eq!(decompress(&[3, 1, 2], 4), None);
        // Bytes that decode short of the block.
        assert_eq!(decompress(&[1, 1, 2], 3), None);
    }
}
