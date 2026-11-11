//! The channel half of the view links: a channel's contrast and colormap
//! follow from the dataset one view links by to the other's, channel by
//! channel. Channels pair by name, and any left over by their place in the
//! list, which the link popover shows so a pairing by place between
//! channels named apart is never silent.

use lucida_content::DatasetId;
use serde::Serialize;

use super::{Colormap, Scene, declared_channels};
use crate::command::{Command, ViewportCommand};

/// How two channels came to pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PairedBy {
    /// They carry one name.
    Name,
    /// Neither found its name across, so they pair by their place.
    Index,
}

/// A channel of the first view's dataset and the one of the second's that
/// follows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChannelPair {
    pub first: u32,
    pub second: u32,
    pub first_name: String,
    pub second_name: String,
    pub by: PairedBy,
}

/// A change to one channel that a channel link carries across.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ChannelChange {
    Contrast {
        dataset: DatasetId,
        channel: u32,
        window: [f64; 2],
    },
    Colormap {
        dataset: DatasetId,
        channel: u32,
        colormap: Colormap,
    },
}

impl ChannelChange {
    /// The channel change `cmd` makes, if it makes one.
    pub(crate) fn of(cmd: &Command) -> Option<ChannelChange> {
        match cmd {
            Command::Viewport(ViewportCommand::SetChannelContrast {
                dataset_id,
                channel,
                min,
                max,
            }) => Some(ChannelChange::Contrast {
                dataset: DatasetId::from(dataset_id.as_str()),
                channel: *channel,
                window: [*min, *max],
            }),
            Command::Viewport(ViewportCommand::SetChannelColormap {
                dataset_id,
                channel,
                colormap,
            }) => Some(ChannelChange::Colormap {
                dataset: DatasetId::from(dataset_id.as_str()),
                channel: *channel,
                colormap: *colormap,
            }),
            _ => None,
        }
    }
}

impl Scene {
    /// A channel's name as its layer row shows it: the name someone gave
    /// it, else the one the dataset declares, else its place from 1.
    fn channel_name(&self, dataset_id: &DatasetId, channel: u32) -> String {
        let given = self
            .dataset_settings
            .get(dataset_id)
            .and_then(|s| s.channel_settings.get(channel as usize))
            .and_then(|c| c.name.clone());
        let declared = || {
            let manifest = self.document.manifests.get(dataset_id)?;
            Some(
                declared_channels(manifest)
                    .get(channel as usize)?
                    .label
                    .clone(),
            )
        };
        given
            .or_else(declared)
            .unwrap_or_else(|| format!("Channel {}", channel + 1))
    }

    fn channel_count(&self, dataset_id: &DatasetId) -> u32 {
        self.document
            .manifests
            .get(dataset_id)
            .map_or(0, |m| super::LayerExtent::of(m).c)
    }

    /// The channels of `first` paired with those of `second`: each first
    /// channel with the first unpaired one of the same name, ignoring case,
    /// and each still unpaired with the second channel at its place, when
    /// that one is unpaired too.
    pub(super) fn channel_pairs(&self, [first, second]: &[DatasetId; 2]) -> Vec<ChannelPair> {
        let names = |id: &DatasetId| -> Vec<String> {
            (0..self.channel_count(id))
                .map(|c| self.channel_name(id, c))
                .collect()
        };
        let (a, b) = (names(first), names(second));
        let mut taken = vec![false; b.len()];
        let mut paired: Vec<Option<(usize, PairedBy)>> = a
            .iter()
            .map(|name| {
                let key = name.trim().to_lowercase();
                let at = (0..b.len()).find(|&j| !taken[j] && b[j].trim().to_lowercase() == key)?;
                taken[at] = true;
                Some((at, PairedBy::Name))
            })
            .collect();
        for (i, pair) in paired.iter_mut().enumerate() {
            if pair.is_none() && i < b.len() && !taken[i] {
                taken[i] = true;
                *pair = Some((i, PairedBy::Index));
            }
        }
        paired
            .into_iter()
            .enumerate()
            .filter_map(|(i, pair)| {
                let (j, by) = pair?;
                Some(ChannelPair {
                    first: i as u32,
                    second: j as u32,
                    first_name: a[i].clone(),
                    second_name: b[j].clone(),
                    by,
                })
            })
            .collect()
    }

    /// The contrast window and colormap of `channel` of `dataset_id`.
    fn channel_look(&self, dataset_id: &DatasetId, channel: u32) -> Option<([f64; 2], Colormap)> {
        let settings = self.dataset_settings.get(dataset_id)?;
        let shown = settings.channel_settings.get(channel as usize)?;
        Some(([shown.contrast_min, shown.contrast_max], shown.colormap))
    }

    /// Write `change` into the channel it names. Says whether it changed
    /// anything.
    fn write_channel(&mut self, change: &ChannelChange) -> bool {
        let (dataset, channel) = match change {
            ChannelChange::Contrast {
                dataset, channel, ..
            }
            | ChannelChange::Colormap {
                dataset, channel, ..
            } => (dataset.clone(), *channel),
        };
        let Some(settings) = self.channel_settings_mut(&dataset, channel) else {
            return false;
        };
        match change {
            ChannelChange::Contrast { window, .. } => {
                let before = [settings.contrast_min, settings.contrast_max];
                [settings.contrast_min, settings.contrast_max] = *window;
                before != *window
            }
            ChannelChange::Colormap { colormap, .. } => {
                let before = settings.colormap;
                settings.colormap = *colormap;
                before != *colormap
            }
        }
    }

    /// Carry `change`, just made to one of the linked datasets, to the
    /// channel its channel pairs with in the other, through the contrast or
    /// colormap link. A dataset neither view links by, or one dataset in
    /// both views, whose channels share their settings already, carries
    /// nothing.
    pub(crate) fn follow_channel_link(&mut self, change: &ChannelChange) {
        let Some(pair) = self.links.pair() else {
            return;
        };
        let (dataset, channel) = match change {
            ChannelChange::Contrast {
                dataset, channel, ..
            }
            | ChannelChange::Colormap {
                dataset, channel, ..
            } => (dataset, *channel),
        };
        let forward = *dataset == pair[0];
        if pair[0] == pair[1] || !(forward || *dataset == pair[1]) {
            return;
        }
        let other = pair[usize::from(forward)].clone();
        let pairs = self.channel_pairs(&pair);
        let Some(paired) = pairs
            .iter()
            .find(|p| channel == if forward { p.first } else { p.second })
        else {
            return;
        };
        let (first, follower) = (
            paired.first,
            if forward { paired.second } else { paired.first },
        );
        let carried = match change {
            ChannelChange::Contrast { window, .. } => {
                let shift = match self.link_mode(super::LinkProperty::Contrast) {
                    super::LinkMode::Off => return,
                    super::LinkMode::Linked => [0.0, 0.0],
                    super::LinkMode::Relative => {
                        let offset = self.contrast_offset(first).unwrap_or([0.0, 0.0]);
                        if forward { offset } else { offset.map(|v| -v) }
                    }
                };
                ChannelChange::Contrast {
                    dataset: other,
                    channel: follower,
                    window: [window[0] + shift[0], window[1] + shift[1]],
                }
            }
            ChannelChange::Colormap { colormap, .. } => {
                if self.link_mode(super::LinkProperty::Colormap) != super::LinkMode::Linked {
                    return;
                }
                ChannelChange::Colormap {
                    dataset: other,
                    channel: follower,
                    colormap: *colormap,
                }
            }
        };
        self.write_channel(&carried);
    }

    /// Start a channel link from the datasets as they stand: a linked one
    /// brings every paired channel of the other dataset to `leader`'s, and a
    /// relative contrast keeps the offsets between their windows. Says
    /// whether a channel changed.
    pub(super) fn settle_channel_link(
        &mut self,
        property: super::LinkProperty,
        leader: DatasetId,
    ) -> bool {
        let Some(pair) = self.links.pair() else {
            return false;
        };
        if pair[0] == pair[1] {
            return false;
        }
        let forward = leader == pair[0];
        let pairs = self.channel_pairs(&pair);
        let mode = self.link_mode(property);
        let mut changed = false;
        let mut offsets = Vec::new();
        for paired in &pairs {
            let (from, to) = if forward {
                (paired.first, paired.second)
            } else {
                (paired.second, paired.first)
            };
            let other = pair[usize::from(forward)].clone();
            let Some((window, colormap)) = self.channel_look(&pair[usize::from(!forward)], from)
            else {
                continue;
            };
            let own = self
                .channel_look(&other, to)
                .map(|(own, _)| own)
                .unwrap_or(window);
            match (property, mode) {
                (super::LinkProperty::Contrast, super::LinkMode::Linked) => {
                    changed |= self.write_channel(&ChannelChange::Contrast {
                        dataset: other,
                        channel: to,
                        window,
                    });
                }
                (super::LinkProperty::Contrast, super::LinkMode::Relative) => {
                    // Kept as the second dataset's window against the first's.
                    let [first, second] = if forward {
                        [window, own]
                    } else {
                        [own, window]
                    };
                    offsets.push((paired.first, [second[0] - first[0], second[1] - first[1]]));
                }
                (super::LinkProperty::Colormap, super::LinkMode::Linked) => {
                    changed |= self.write_channel(&ChannelChange::Colormap {
                        dataset: other,
                        channel: to,
                        colormap,
                    });
                }
                _ => {}
            }
        }
        if property == super::LinkProperty::Contrast {
            self.set_contrast_offsets(offsets);
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::PhysicalSpace;

    use super::super::test_helpers::make_dataset_opened_with_shape;
    use super::*;
    use crate::scene::{LinkMode, LinkProperty, Unlinkable};
    use crate::view::{ViewDatasets, ViewId, ViewLayout};

    /// A micrometer volume over one region whose channels are named `names`.
    fn open(scene: &mut Scene, id: &str, names: &[&str]) {
        let channels = names.len() as u64;
        let mut opened = make_dataset_opened_with_shape(
            id,
            id,
            channels,
            [1, channels, 8, 32, 32],
            [1, 1, 8, 32, 32],
            1,
        );
        let unit = Some("micrometer".to_string());
        opened.manifest = opened.manifest.with_space(PhysicalSpace {
            units: [unit.clone(), unit.clone(), unit],
            origin: [0.0; 3],
        });
        scene.apply(crate::command::DocumentCommand::DatasetOpened(opened).into());
        for (channel, name) in names.iter().enumerate() {
            let (dataset_id, name) = (id.to_string(), Some(name.to_string()));
            let channel = channel as u32;
            viewport(
                scene,
                ViewportCommand::SetChannelName {
                    dataset_id,
                    channel,
                    name,
                },
            );
        }
    }

    fn viewport(scene: &mut Scene, cmd: ViewportCommand) {
        scene.apply(Command::Viewport(cmd));
    }

    /// A in the first view and B in the second, the first active.
    fn side_by_side() -> (Scene, [ViewId; 2]) {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", &["DAPI", "GFP", "RFP"]);
        open(&mut scene, "b", &["gfp", "DAPI", "Cy5"]);
        let layout = ViewLayout::Columns;
        viewport(&mut scene, ViewportCommand::SetViewLayout { layout });
        let views = [scene.views()[0].id(), scene.views()[1].id()];
        for (view, id) in views.into_iter().zip(["a", "b"]) {
            let datasets = ViewDatasets::Only(vec![DatasetId::from(id)]);
            viewport(
                &mut scene,
                ViewportCommand::SetViewDatasets { view, datasets },
            );
        }
        viewport(
            &mut scene,
            ViewportCommand::SetActiveView { view: views[0] },
        );
        (scene, views)
    }

    fn link(scene: &mut Scene, property: LinkProperty, mode: LinkMode) {
        viewport(scene, ViewportCommand::SetViewLink { property, mode });
    }

    fn contrast(scene: &mut Scene, id: &str, channel: u32, [min, max]: [f64; 2]) {
        let dataset_id = id.to_string();
        viewport(
            scene,
            ViewportCommand::SetChannelContrast {
                dataset_id,
                channel,
                min,
                max,
            },
        );
    }

    fn window(scene: &Scene, id: &str, channel: u32) -> [f64; 2] {
        scene
            .channel_look(&DatasetId::from(id), channel)
            .expect("a channel")
            .0
    }

    #[test]
    fn channels_pair_by_name_and_the_rest_by_their_place() {
        let (scene, _) = side_by_side();
        let links = scene.links().unwrap();
        let pairs: Vec<(u32, u32, PairedBy)> = links
            .channels
            .iter()
            .map(|p| (p.first, p.second, p.by))
            .collect();
        assert_eq!(
            pairs,
            vec![
                (0, 1, PairedBy::Name),
                (1, 0, PairedBy::Name),
                (2, 2, PairedBy::Index)
            ]
        );
        assert_eq!(
            (
                links.channels[2].first_name.as_str(),
                links.channels[2].second_name.as_str()
            ),
            ("RFP", "Cy5")
        );
        // They stay off until someone links them.
        let modes: Vec<LinkMode> = links.properties[5..].iter().map(|p| p.mode).collect();
        assert_eq!(modes, vec![LinkMode::Off, LinkMode::Off]);
    }

    #[test]
    fn a_linked_contrast_reaches_the_channel_it_pairs_with_either_way() {
        let (mut scene, _) = side_by_side();
        contrast(&mut scene, "a", 1, [100.0, 900.0]);
        link(&mut scene, LinkProperty::Contrast, LinkMode::Linked);
        // Linking brings B's GFP, its channel 0, to A's at once.
        assert_eq!(window(&scene, "b", 0), [100.0, 900.0]);
        let epoch = scene.epochs.selection;
        contrast(&mut scene, "a", 0, [5.0, 50.0]);
        assert_eq!(window(&scene, "b", 1), [5.0, 50.0]);
        assert_eq!(scene.epochs.selection, epoch + 1, "one move of the epoch");
        contrast(&mut scene, "b", 2, [7.0, 70.0]);
        assert_eq!(window(&scene, "a", 2), [7.0, 70.0]);
    }

    #[test]
    fn a_relative_contrast_keeps_the_offset_between_the_windows() {
        let (mut scene, _) = side_by_side();
        contrast(&mut scene, "a", 0, [10.0, 100.0]);
        contrast(&mut scene, "b", 1, [30.0, 150.0]);
        link(&mut scene, LinkProperty::Contrast, LinkMode::Relative);
        contrast(&mut scene, "a", 0, [20.0, 120.0]);
        assert_eq!(window(&scene, "b", 1), [40.0, 170.0]);
        contrast(&mut scene, "b", 1, [0.0, 50.0]);
        assert_eq!(window(&scene, "a", 0), [-20.0, 0.0]);
    }

    #[test]
    fn a_colormap_links_or_stays_off() {
        let (mut scene, _) = side_by_side();
        link(&mut scene, LinkProperty::Colormap, LinkMode::Relative);
        assert_eq!(scene.link_mode(LinkProperty::Colormap), LinkMode::Off);
        link(&mut scene, LinkProperty::Colormap, LinkMode::Linked);
        let colormap = Colormap::Magenta;
        let dataset_id = "a".to_string();
        viewport(
            &mut scene,
            ViewportCommand::SetChannelColormap {
                dataset_id,
                channel: 2,
                colormap,
            },
        );
        assert_eq!(
            scene.channel_look(&DatasetId::from("b"), 2).unwrap().1,
            colormap
        );
        // A contrast link left off carries no window.
        contrast(&mut scene, "a", 2, [1.0, 2.0]);
        assert_ne!(window(&scene, "b", 2), [1.0, 2.0]);
        assert!(scene.links().unwrap().properties[5].unlinkable != Some(Unlinkable::Shared));
    }
}
