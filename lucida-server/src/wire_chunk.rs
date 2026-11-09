//! What a chunk frame carries to a client that declared the codecs it
//! decodes: a source chunk's stored bytes as they are, or a chunk the server
//! made itself compressed for the link. Every other client, and every chunk
//! that does not qualify, gets decoded bytes.

use std::net::IpAddr;

use lucida_protocol::codec::{BytesCodec, ChunkCodec, ChunkRelaySetting, CodecSet};

/// Whether a connection is sent chunks still encoded once it declares the
/// codecs it decodes.
///
/// `auto` relays to a connection from another machine and not to one from
/// this machine. Over loopback the link costs nothing, and the page's zstd,
/// about a quarter as fast as the server's, would only slow every chunk
/// down. A link throttle stands in for a network, so under one `auto`
/// relays to loopback as well, which is how throttled perf runs measure
/// the relay.
///
/// `peer` is the socket's remote address, `None` when the server was not
/// told it. Behind a reverse proxy the peer is the proxy, which on another
/// machine is not loopback, so a deployed server relays. A proxy on this
/// machine names its client in `forwarded_for`, the first address of
/// `X-Forwarded-For`, and that client decides instead. A forged header can
/// only choose how chunks are encoded, never what a caller may read.
pub fn relays_to(
    setting: ChunkRelaySetting,
    peer: Option<IpAddr>,
    forwarded_for: Option<IpAddr>,
    link_throttled: bool,
) -> bool {
    match setting {
        ChunkRelaySetting::Always => true,
        ChunkRelaySetting::Never => false,
        ChunkRelaySetting::Auto => {
            let remote = forwarded_for.or(peer).is_none_or(|ip| !ip.is_loopback());
            remote || link_throttled
        }
    }
}

/// The first address of an `X-Forwarded-For` header, the client a proxy
/// forwarded, when it is one.
pub fn forwarded_client(header: Option<&str>) -> Option<IpAddr> {
    header?.split(',').next()?.trim().parse().ok()
}

/// Whether `wire` bytes in place of `decoded` ones save enough of the link
/// to be worth the client decoding them. The page's zstd decodes about
/// 160 MB/s on one core, so a chunk that barely compresses would only move
/// its decode from the server to the page. A quarter saved is several
/// milliseconds of transfer per chunk on a link of a few hundred Mbit/s.
pub fn saves_enough(wire: usize, decoded: usize) -> bool {
    wire.saturating_mul(4) <= decoded.saturating_mul(3)
}

/// The one codec the server compresses its own chunks with. lz4 is the
/// fastest to write here and to undo in the page's decode worker.
pub const PRODUCED_CODEC: BytesCodec = BytesCodec::Lz4;

/// A chunk the server made itself, a generated coarse-tier chunk or the fill
/// of an absent one, compressed for a client that decodes
/// [`PRODUCED_CODEC`] when that saves enough.
pub fn compress_produced(codecs: CodecSet, decoded: &[u8]) -> Option<Vec<u8>> {
    if !codecs.contains(ChunkCodec::Lz4) {
        return None;
    }
    let compressed = lz4_flex::compress_prepend_size(decoded);
    saves_enough(compressed.len(), decoded.len()).then_some(compressed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lz4() -> CodecSet {
        [ChunkCodec::Lz4].into_iter().collect()
    }

    const LOOPBACK: Option<IpAddr> = Some(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    const REMOTE: Option<IpAddr> = Some(IpAddr::V4(std::net::Ipv4Addr::new(10, 1, 2, 3)));

    #[test]
    fn auto_relays_to_another_machine_and_not_over_loopback() {
        let auto = ChunkRelaySetting::Auto;
        assert!(!relays_to(auto, LOOPBACK, None, false));
        assert!(!relays_to(auto, Some("::1".parse().unwrap()), None, false));
        assert!(relays_to(auto, REMOTE, None, false));
        // Nothing says the peer is this machine.
        assert!(relays_to(auto, None, None, false));
    }

    #[test]
    fn auto_relays_over_loopback_under_a_link_throttle() {
        assert!(relays_to(ChunkRelaySetting::Auto, LOOPBACK, None, true));
    }

    #[test]
    fn a_proxy_on_this_machine_is_judged_by_the_client_it_forwards() {
        let auto = ChunkRelaySetting::Auto;
        assert!(relays_to(auto, LOOPBACK, REMOTE, false));
        assert!(!relays_to(auto, LOOPBACK, LOOPBACK, false));
        assert_eq!(
            forwarded_client(Some("203.0.113.7, 10.0.0.1")),
            "203.0.113.7".parse().ok()
        );
        assert_eq!(forwarded_client(Some("unknown")), None);
        assert_eq!(forwarded_client(None), None);
    }

    #[test]
    fn always_and_never_ignore_the_peer() {
        for (peer, throttled) in [(LOOPBACK, false), (REMOTE, false), (LOOPBACK, true)] {
            assert!(relays_to(ChunkRelaySetting::Always, peer, None, throttled));
            assert!(!relays_to(ChunkRelaySetting::Never, peer, None, throttled));
        }
    }

    #[test]
    fn a_quarter_saved_is_enough_and_less_is_not() {
        assert!(saves_enough(768, 1024));
        assert!(!saves_enough(769, 1024));
    }

    #[test]
    fn a_produced_chunk_is_compressed_only_for_a_client_that_decodes_lz4() {
        let fill = vec![0u8; 64 * 1024];
        let compressed = compress_produced(lz4(), &fill).unwrap();
        assert!(compressed.len() < 1024);
        assert_eq!(
            lz4_flex::decompress_size_prepended(&compressed).unwrap(),
            fill
        );
        assert_eq!(compress_produced(CodecSet::default(), &fill), None);
    }

    #[test]
    fn a_produced_chunk_that_barely_compresses_goes_decoded() {
        let mut x = 0x9e37_79b9_u32;
        let noise: Vec<u8> = (0..64 * 1024)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect();
        assert_eq!(compress_produced(lz4(), &noise), None);
    }
}
