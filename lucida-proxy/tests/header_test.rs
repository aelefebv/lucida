use std::io::Cursor;

use lucida_proxy::{ALGORITHM_VERSION, ProxyDtype, ProxyHeader, read_header, write_header};

#[test]
fn round_trip_equal() {
    let header = ProxyHeader {
        algorithm_version: ALGORITHM_VERSION,
        source_content_hash: [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ],
        dims: [32, 64, 128],
        dtype: ProxyDtype::U16,
    };

    let mut buf = Vec::new();
    write_header(&mut buf, &header).unwrap();
    assert_eq!(buf.len(), 64, "header must be exactly 64 bytes");

    let mut cur = Cursor::new(&buf);
    let parsed = read_header(&mut cur).unwrap();
    assert_eq!(parsed, header);
}

#[test]
fn mismatched_magic_errors() {
    // Build a valid header, corrupt the magic.
    let header = ProxyHeader {
        algorithm_version: ALGORITHM_VERSION,
        source_content_hash: [0u8; 32],
        dims: [4, 4, 4],
        dtype: ProxyDtype::U16,
    };
    let mut buf = Vec::new();
    write_header(&mut buf, &header).unwrap();
    buf[0] = b'X'; // corrupt magic byte

    let mut cur = Cursor::new(&buf);
    let err = read_header(&mut cur).expect_err("bad magic should error");
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
}

#[test]
fn mismatched_version_errors() {
    let header = ProxyHeader {
        algorithm_version: ALGORITHM_VERSION + 99,
        source_content_hash: [0u8; 32],
        dims: [4, 4, 4],
        dtype: ProxyDtype::U16,
    };
    let mut buf = Vec::new();
    write_header(&mut buf, &header).unwrap();

    let mut cur = Cursor::new(&buf);
    let err = read_header(&mut cur).expect_err("bad version should error");
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    let msg = format!("{err}");
    assert!(
        msg.contains("version"),
        "error message should mention version: {msg}"
    );
}

#[test]
fn unknown_dtype_errors() {
    // Manually craft 64 bytes with a bad dtype code.
    let mut buf = vec![0u8; 64];
    buf[0..4].copy_from_slice(b"LPRX");
    buf[4..8].copy_from_slice(&ALGORITHM_VERSION.to_le_bytes());
    // dims = [1,1,1]
    buf[8..12].copy_from_slice(&1u32.to_le_bytes());
    buf[12..16].copy_from_slice(&1u32.to_le_bytes());
    buf[16..20].copy_from_slice(&1u32.to_le_bytes());
    // dtype = 999 (unknown)
    buf[20..24].copy_from_slice(&999u32.to_le_bytes());

    let mut cur = Cursor::new(&buf);
    let err = read_header(&mut cur).expect_err("bad dtype should error");
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
}

#[test]
fn truncated_input_errors() {
    let buf = vec![0u8; 32]; // less than 64 bytes
    let mut cur = Cursor::new(&buf);
    assert!(read_header(&mut cur).is_err());
}
