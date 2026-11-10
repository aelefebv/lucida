//! What a chunk frame carries to a client that declared the codecs it
//! decodes: a source chunk's stored bytes as they are, or a chunk the server
//! made itself compressed for the link. Every other client, and every chunk
//! that does not qualify, gets decoded bytes. A request for some planes of a
//! chunk gets those planes, cut from the decoded chunk.

use std::net::IpAddr;

use std::borrow::Cow;

use lucida_content::SpatialAxis;
use lucida_protocol::codec::{BytesCodec, ChunkCodec, ChunkPlanes, ChunkRelaySetting, CodecSet};

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

/// The planes of a wire chunk a request asked for in place of all of it,
/// half-open along one of the chunk's own axes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlaneCut {
    planes: ChunkPlanes,
    /// The chunk's samples along Z, Y and X, the order its bytes run in.
    dims: [usize; 3],
}

impl PlaneCut {
    /// The cut of `planes` from a chunk of `dims` samples along Z, Y and X,
    /// or `None` when the range is empty, reaches past the chunk, or covers
    /// all of it. Each of those is answered with the whole chunk, which holds
    /// every plane.
    pub fn new(planes: ChunkPlanes, dims: [u64; 3]) -> Option<Self> {
        let dims = dims.map(|d| usize::try_from(d).unwrap_or(usize::MAX));
        let depth = dims[2 - planes.axis.xyz()];
        let [first, end] = planes.range.map(|p| p as usize);
        (first < end && end <= depth && end - first < depth).then_some(PlaneCut { planes, dims })
    }

    pub fn planes(self) -> ChunkPlanes {
        self.planes
    }

    /// The samples the chunk holds along the cut axis.
    fn depth(self) -> usize {
        self.dims[2 - self.planes.axis.xyz()]
    }

    /// The bytes of one run of a plane, and how many runs a plane takes, in a
    /// chunk of `len` bytes, or `None` when the chunk does not split evenly.
    /// A plane along Z is one run. One along Y is a row for each Z, and one
    /// along X a sample for each Z and Y.
    fn runs(self, len: usize) -> Option<(usize, usize)> {
        let [z, y, x] = self.dims;
        if self.planes.axis.is_z() {
            return len.is_multiple_of(z).then(|| (len / z, 1));
        }
        let samples = z.checked_mul(y)?.checked_mul(x)?;
        if samples == 0 || !len.is_multiple_of(samples) {
            return None;
        }
        let sample = len / samples;
        Some(match self.planes.axis {
            SpatialAxis::Y => (x * sample, z),
            _ => (sample, z * y),
        })
    }

    fn width(self) -> usize {
        (self.planes.range[1] - self.planes.range[0]) as usize
    }

    /// The bytes the planes take of a chunk of `len` bytes, or `None` when
    /// the chunk does not split into its planes evenly.
    pub fn len_of(self, len: usize) -> Option<usize> {
        let (run, count) = self.runs(len)?;
        Some(run * self.width() * count)
    }

    /// The planes out of the whole chunk's bytes, or `None` when the chunk
    /// does not split into its planes evenly. Planes along Z lie together;
    /// planes along Y or X are gathered from every row they cross.
    pub fn cut(self, chunk: &[u8]) -> Option<Cow<'_, [u8]>> {
        let (run, count) = self.runs(chunk.len())?;
        let first = run * self.planes.range[0] as usize;
        let taken = run * self.width();
        if count == 1 {
            return chunk.get(first..first + taken).map(Cow::Borrowed);
        }
        let mut out = Vec::with_capacity(taken * count);
        for row in chunk.chunks_exact(run * self.depth()) {
            out.extend_from_slice(&row[first..first + taken]);
        }
        Some(Cow::Owned(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn along(axis: SpatialAxis, range: [u32; 2]) -> ChunkPlanes {
        ChunkPlanes { axis, range }
    }

    #[test]
    fn a_plane_cut_takes_its_planes_of_the_chunk() {
        let chunk: Vec<u8> = (0..16).collect();
        let cut = PlaneCut::new(ChunkPlanes::z([1, 3]), [4, 2, 2]).unwrap();
        assert_eq!(cut.planes(), ChunkPlanes::z([1, 3]));
        assert_eq!(cut.cut(&chunk).as_deref(), Some(&chunk[4..12]));
        assert_eq!(cut.len_of(16), Some(8));
        // A chunk that is not four equal planes is served whole.
        assert_eq!(cut.cut(&chunk[..15]), None);
    }

    #[test]
    fn a_cut_along_y_or_x_gathers_its_planes_from_every_row() {
        // Two planes along Z of 3 rows of 2 samples, a byte each.
        let chunk: Vec<u8> = (0..12).collect();
        let rows = PlaneCut::new(along(SpatialAxis::Y, [1, 2]), [2, 3, 2]).unwrap();
        assert_eq!(rows.cut(&chunk).as_deref(), Some(&[2, 3, 8, 9][..]));
        assert_eq!(rows.len_of(12), Some(4));
        let columns = PlaneCut::new(along(SpatialAxis::X, [1, 2]), [2, 3, 2]).unwrap();
        assert_eq!(
            columns.cut(&chunk).as_deref(),
            Some(&[1, 3, 5, 7, 9, 11][..])
        );
        // Two-byte samples keep their bytes together.
        let wide: Vec<u8> = (0..24).collect();
        assert_eq!(
            columns.cut(&wide).as_deref(),
            Some(&[2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23][..])
        );
        // A chunk that is not a whole number of samples is served whole.
        assert_eq!(rows.cut(&chunk[..11]), None);
    }

    #[test]
    fn a_range_the_chunk_cannot_cut_is_served_whole() {
        let z = |range| PlaneCut::new(ChunkPlanes::z(range), [4, 8, 8]);
        assert_eq!(z([2, 2]), None);
        assert_eq!(z([3, 1]), None);
        assert_eq!(z([3, 5]), None);
        assert_eq!(z([0, 4]), None);
        assert_eq!(PlaneCut::new(ChunkPlanes::z([0, 1]), [1, 8, 8]), None);
        assert!(z([3, 4]).is_some());
        assert!(PlaneCut::new(along(SpatialAxis::Y, [5, 8]), [4, 8, 8]).is_some());
        assert_eq!(
            PlaneCut::new(along(SpatialAxis::X, [5, 9]), [4, 8, 8]),
            None
        );
    }

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
