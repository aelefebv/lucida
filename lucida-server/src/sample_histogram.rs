//! Histograms of source samples in the source's own units, which generated
//! levels hand to auto-contrast in place of their pooled values.

use std::collections::BTreeMap;

use lucida_protocol::HistogramBin;

/// Mantissa bits a bin keeps. Six make a bin at most 1/64 of its values'
/// magnitude and give each integer below 128 a bin of its own, which keeps
/// a 16-bit timepoint and channel to a few hundred bins on the wire.
const MANTISSA_BITS: u32 = 6;
const BIN_SHIFT: u32 = 23 - MANTISSA_BITS;
const BIN_COUNT: usize = 1 << (32 - BIN_SHIFT);

/// The bin a finite value falls in: its `f32` bits, flipped so they order
/// as the values do, keeping the sign, the exponent, and the top mantissa
/// bits. Fixed edges are what let two histograms merge exactly.
fn bin_index(value: f64) -> u32 {
    let bits = (value as f32).to_bits();
    let ordered = if bits >> 31 == 1 {
        !bits
    } else {
        bits | 1 << 31
    };
    ordered >> BIN_SHIFT
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Bin {
    min: f64,
    max: f64,
    count: u64,
}

/// Counts of finite samples by bin, with the smallest and largest sample in
/// each. Merging is exact and independent of order, so a histogram built
/// chunk by chunk does not depend on which chunk came first.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SampleHistogram {
    bins: BTreeMap<u32, Bin>,
}

impl SampleHistogram {
    /// Every finite value in `values`. Non-finite samples have no place on
    /// a contrast scale, so they are left out.
    pub(crate) fn of(values: impl IntoIterator<Item = f64>) -> Self {
        let mut counts = vec![0_u64; BIN_COUNT];
        let mut mins = vec![f64::INFINITY; BIN_COUNT];
        let mut maxs = vec![f64::NEG_INFINITY; BIN_COUNT];
        for value in values {
            if !value.is_finite() {
                continue;
            }
            // Adding zero turns -0 into 0, so zero has one bin.
            let value = value + 0.0;
            let i = bin_index(value) as usize;
            counts[i] += 1;
            mins[i] = mins[i].min(value);
            maxs[i] = maxs[i].max(value);
        }
        let bins = counts
            .iter()
            .enumerate()
            .filter(|(_, count)| **count > 0)
            .map(|(i, &count)| {
                (
                    i as u32,
                    Bin {
                        min: mins[i],
                        max: maxs[i],
                        count,
                    },
                )
            })
            .collect();
        Self { bins }
    }

    pub(crate) fn merge(&mut self, other: &SampleHistogram) {
        for (index, bin) in &other.bins {
            self.bins
                .entry(*index)
                .and_modify(|mine| {
                    mine.min = mine.min.min(bin.min);
                    mine.max = mine.max.max(bin.max);
                    mine.count += bin.count;
                })
                .or_insert(*bin);
        }
    }

    /// The bins in ascending order, as the wire carries them.
    pub(crate) fn wire_bins(&self) -> Vec<HistogramBin> {
        self.bins
            .values()
            .map(|bin| HistogramBin(bin.min, bin.max, bin.count))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bins(values: &[f64]) -> Vec<HistogramBin> {
        SampleHistogram::of(values.iter().copied()).wire_bins()
    }

    #[test]
    fn small_integers_each_get_a_bin_and_bins_ascend() {
        assert_eq!(
            bins(&[5.0, -3.0, 0.0, -0.0, 127.0, 5.0, 64.0]),
            vec![
                HistogramBin(-3.0, -3.0, 1),
                HistogramBin(0.0, 0.0, 2),
                HistogramBin(5.0, 5.0, 2),
                HistogramBin(64.0, 64.0, 1),
                HistogramBin(127.0, 127.0, 1),
            ]
        );
    }

    #[test]
    fn a_bin_spans_at_most_one_sixty_fourth_of_its_values() {
        let values: Vec<f64> = (0..=65_535).map(f64::from).collect();
        let out = bins(&values);
        assert_eq!(out.iter().map(|b| b.2).sum::<u64>(), 65_536);
        for pair in out.windows(2) {
            assert!(pair[0].1 < pair[1].0, "bins overlap: {pair:?}");
        }
        for bin in &out {
            assert!(
                bin.1 - bin.0 <= bin.0.max(1.0) / 64.0,
                "bin too wide: {bin:?}"
            );
        }
        // 128 single-integer bins, then 64 per octave up to 2^16.
        assert_eq!(out.len(), 128 + 9 * 64);
    }

    #[test]
    fn non_finite_samples_are_left_out() {
        assert_eq!(
            bins(&[f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 2.5]),
            vec![HistogramBin(2.5, 2.5, 1)]
        );
    }

    #[test]
    fn merging_in_any_order_gives_one_histogram() {
        let a = SampleHistogram::of([1.0, 1000.0, 1001.0, 70_000.0]);
        let b = SampleHistogram::of([1000.5, 2.0, -1e-9, 1e300]);
        let c = SampleHistogram::of([999.0, 1.0]);
        let mut forward = SampleHistogram::default();
        for h in [&a, &b, &c] {
            forward.merge(h);
        }
        let mut backward = SampleHistogram::default();
        for h in [&c, &b, &a] {
            backward.merge(h);
        }
        assert_eq!(forward, backward);
        assert_eq!(
            forward,
            SampleHistogram::of([
                1.0, 1000.0, 1001.0, 70_000.0, 1000.5, 2.0, -1e-9, 1e300, 999.0, 1.0
            ])
        );
        // A value past the f32 range still keeps its own value as the bin's bound.
        assert_eq!(
            forward.wire_bins().last(),
            Some(&HistogramBin(1e300, 1e300, 1))
        );
    }
}
