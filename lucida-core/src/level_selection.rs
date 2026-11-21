//! The level selection: which level each part of a view draws at, within the
//! memory budget.
//!
//! The target level ([`crate::target_level`]) is the level the screen calls
//! for, one per entity, measured where the center ray meets it. A volume's
//! every pixel looks through its whole depth, so the chunks of that one level
//! in view grow with the depth and outgrow any budget. The selection instead
//! starts every visible chunk at the coarsest level and refines, one chunk at
//! a time, the chunk whose samples span the most device pixels, until each
//! chunk's samples span at most one device pixel or the next refinement would
//! not fit. It fits the budget by construction, and its work is bounded by
//! the chunks it selects rather than by the chunks in view.
//!
//! A frame drawn at a fraction of the screen's resolution, as a gesture's
//! is, can resolve a coarser level than the selection chose. So the
//! selection can keep each selected cell's ancestors resident beside it: the
//! coarser cells over it that such a frame would sample, charged to the same
//! budget.
//!
//! It reads the camera, the level geometry, the budget and the previous
//! selection, and nothing else, so every client gets the same selection for
//! the same inputs.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

use lucida_content::LevelGeometry;

use crate::chunk::{self, ChunkQuery, ChunkView, CullCounts, ScoredChunk};
use crate::target_level::{HYSTERESIS_OCTAVES, level_shape_ratios};

/// The detail levels one entity draws from at once: the renderer binds one
/// level pool per source, `MAX_LEVEL_SOURCES` in
/// `lucida-web/src/renderer/volume.wgsl` and `DESCRIPTOR_MAX_LEVEL_SOURCES`
/// in `lucida-web/src/renderer/descriptor/layout.ts`, from the finest level
/// it holds through the next coarser ones.
pub const MAX_LEVEL_SOURCES: u32 = 4;

/// Bytes on each side of the page: what the CPU cache holds and what the GPU
/// pools hold. A chunk costs both, and either budget can bind.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Cost {
    pub cpu: f64,
    pub gpu: f64,
}

impl Cost {
    fn add(self, other: Cost) -> Cost {
        Cost {
            cpu: self.cpu + other.cpu,
            gpu: self.gpu + other.gpu,
        }
    }

    fn sub(self, other: Cost) -> Cost {
        Cost {
            cpu: self.cpu - other.cpu,
            gpu: self.gpu - other.gpu,
        }
    }

    fn scaled(self, by: f64) -> Cost {
        Cost {
            cpu: self.cpu * by,
            gpu: self.gpu * by,
        }
    }

    fn within(self, budget: Cost) -> bool {
        self.cpu <= budget.cpu && self.gpu <= budget.gpu
    }
}

/// One chunk cell of one level of one entity. `entity` indexes the entities
/// the selection was given.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Cell {
    pub entity: u32,
    pub level: u32,
    pub z: u32,
    pub y: u32,
    pub x: u32,
}

/// A multiply-rotate hash over a cell's five numbers. The selection hashes a
/// cell several times for each cell it selects, and std's keyed hash, built
/// to resist chosen keys, is slow for keys the core makes itself.
#[derive(Default)]
pub struct CellHasher(u64);

impl Hasher for CellHasher {
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.write_u32(u32::from(byte));
        }
    }

    fn write_u32(&mut self, n: u32) {
        self.0 = (self.0.rotate_left(5) ^ u64::from(n)).wrapping_mul(0x517c_c1b7_2722_0a95);
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

/// A set of cells under [`CellHasher`].
pub type CellSet = HashSet<Cell, BuildHasherDefault<CellHasher>>;

type CellMap<V> = HashMap<Cell, V, BuildHasherDefault<CellHasher>>;

/// A selected cell, its measure, the device pixels one of its samples spans
/// where it is nearest the eye, and how far its center lies from the view's
/// focus, in level-0 samples, as [`ScoredChunk::distance`] measures it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SelectedCell {
    pub cell: Cell,
    pub measure: f64,
    pub distance: f64,
}

/// One visible image-bearing entity, as the selection reads it.
pub struct SelectionEntity<'a> {
    view: &'a ChunkView,
    /// Each pyramid level placed in the view, by level index.
    queries: Vec<ChunkQuery>,
    /// How many times coarser than level 0 each level is along the axes the
    /// view resolves ([`level_shape_ratios`]).
    ratios: Vec<f64>,
    /// What one cell of each level costs, over every channel shown.
    costs: Vec<Cost>,
    /// The levels the detail tier may hold, ascending.
    sources: Vec<u32>,
    start: u32,
    /// Whether the coarse tier holds the start level, so it costs the
    /// detail budget nothing.
    start_free: bool,
    pin: Option<u32>,
}

impl<'a> SelectionEntity<'a> {
    /// `levels` are the entity's pyramid by level index, `costs` what one
    /// cell of each costs, and `sources` the levels the detail tier may hold.
    /// `coarse` is the level the coarse tier holds for it, where the
    /// selection starts at no cost; without one it starts at its coarsest
    /// source level and pays for it. `pin` is a level pin, which the entity
    /// refines toward whatever the screen calls for.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        view: &'a ChunkView,
        position: [f64; 2],
        levels: &[LevelGeometry],
        costs: Vec<Cost>,
        mut sources: Vec<u32>,
        coarse: Option<u32>,
        pin: Option<u32>,
        radius_view: f64,
    ) -> Self {
        let queries = match levels.first() {
            Some(full) => levels
                .iter()
                .map(|level| ChunkQuery::new(level, full, position, radius_view))
                .collect(),
            None => Vec::new(),
        };
        let ratios = level_shape_ratios(levels, view.measure().resolved_axes());
        sources.retain(|&level| (level as usize) < levels.len());
        sources.sort_unstable();
        sources.dedup();
        let (start, start_free) = match coarse {
            Some(level) if (level as usize) < levels.len() => (level, true),
            _ => (sources.last().copied().unwrap_or(0), false),
        };
        Self {
            view,
            queries,
            ratios,
            costs,
            sources,
            start,
            start_free,
            pin,
        }
    }

    /// The next finer level the detail tier may hold below `level`.
    fn finer(&self, level: u32) -> Option<u32> {
        self.sources.iter().rev().copied().find(|&s| s < level)
    }

    /// The next coarser level the detail tier may hold above `level`, short
    /// of a start level the coarse tier holds.
    fn coarser(&self, level: u32) -> Option<u32> {
        self.sources
            .iter()
            .copied()
            .find(|&s| s > level)
            .filter(|&s| s < self.start || !self.start_free)
    }

    fn cost(&self, level: u32) -> Cost {
        self.costs.get(level as usize).copied().unwrap_or_default()
    }

    /// Whether a cell at `level` costs the detail budget.
    fn charged(&self, level: u32) -> bool {
        level != self.start || !self.start_free
    }
}

/// What the last selection chose, which this one leans toward.
#[derive(Debug, Clone, Default)]
pub struct PreviousSelection {
    /// Cells it selected.
    pub kept: CellSet,
    /// Cells it replaced with finer ones.
    pub refined: CellSet,
    /// Cells it kept as ancestors.
    pub ancestors: CellSet,
}

/// The ancestors a selection keeps for frames drawn at a fraction of the
/// screen's resolution.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ancestors {
    /// The lowest share of the screen's resolution a frame draws at. Each
    /// selected cell keeps the coarser cells over it that such a frame would
    /// sample: those whose samples span at most one of its pixels where the
    /// cell is nearest the eye.
    pub scale: f64,
    /// The share of the budget the selected cells and their ancestors may
    /// take together. The selected cells alone stay within the selection's
    /// own share, so the ancestors take room only from what that share
    /// leaves, and none where no frame would sample them.
    pub share: f64,
}

/// Which way the view last zoomed, and so which cells beyond the selection
/// are worth fetching ahead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lookahead {
    None,
    /// The refinements the selection would make next, given more room.
    Finer,
    /// The coarser cells above the finest selected ones.
    Coarser,
}

/// A view's selection.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LevelSelection {
    /// The selected cells, in fetch order ([`fetch_order`]).
    pub cells: Vec<SelectedCell>,
    /// The ancestors the selected cells keep resident, in fetch order: the
    /// coarser cells over each selected cell that a frame at the ancestors'
    /// scale would sample, and none beyond the levels the renderer binds.
    /// Never a selected cell.
    pub ancestors: Vec<SelectedCell>,
    /// Cells beyond the selection worth fetching ahead, in order, which fit
    /// the room the selection leaves.
    pub lookahead: Vec<SelectedCell>,
    /// Cells the selection replaced with finer ones, for the next selection
    /// to lean toward.
    pub refined: Vec<Cell>,
    /// What the selected cells cost the detail budget.
    pub used: Cost,
    /// What the ancestors cost it, beside them.
    pub ancestors_used: Cost,
    /// The measure of the refinement the budget refused, when it refused
    /// one: how many device pixels a sample spans where the selection draws
    /// coarser than the screen calls for. `None` when every cell reached the
    /// level the screen calls for.
    pub limit: Option<f64>,
    /// What the enumerations behind it culled.
    pub counts: CullCounts,
}

/// The quarter octave the target level holds a boundary by.
fn band() -> f64 {
    2f64.powf(HYSTERESIS_OCTAVES)
}

/// The order a view fetches its cells in: coarser levels first, so a slow
/// link fills the whole view before it sharpens, then larger measure, then
/// nearer the focus, which orders a slice view's cells center out.
pub fn fetch_order(a: &SelectedCell, b: &SelectedCell) -> Ordering {
    b.cell
        .level
        .cmp(&a.cell.level)
        .then_with(|| b.measure.total_cmp(&a.measure))
        .then_with(|| a.distance.total_cmp(&b.distance))
        .then_with(|| a.cell.cmp(&b.cell))
}

/// Take one from `level`'s count, dropping the level at none.
fn count_down(levels: &mut BTreeMap<u32, usize>, level: u32) {
    if let Some(count) = levels.get_mut(&level) {
        *count -= 1;
        if *count == 0 {
            levels.remove(&level);
        }
    }
}

/// A cell some selected cells keep as an ancestor: how many, and how far its
/// center lies from the view's focus.
#[derive(Debug, Clone, Copy)]
struct Held {
    holders: u32,
    distance: f64,
}

/// A selected cell waiting to be refined, ordered by priority, then by cell
/// so that equal priorities pop in one order.
#[derive(Debug, Clone, Copy)]
struct Candidate {
    priority: f64,
    cell: Cell,
}

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Candidate {}

impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.priority
            .total_cmp(&other.priority)
            .then_with(|| other.cell.cmp(&self.cell))
    }
}

/// The cells a lookahead collects and the room they take.
struct Ahead {
    cells: Vec<Cell>,
    spent: Cost,
    room: Cost,
}

/// The refinement state of one selection.
struct Refiner<'s, 'a> {
    entities: &'s [SelectionEntity<'a>],
    previous: &'s PreviousSelection,
    /// Which ancestors each selected cell keeps, if any.
    ancestors: Option<Ancestors>,
    /// Selected cells, each with its measure and distance.
    selected: CellMap<SelectedCell>,
    refined: CellSet,
    /// Per entity, how many charged cells each detail level holds, which
    /// keeps the levels within the renderer's sources.
    detail_levels: Vec<BTreeMap<u32, usize>>,
    /// Ancestors of the selected cells, selected themselves or not.
    held: CellMap<Held>,
    /// Per entity, how many ancestors that are not selected each charged
    /// level holds, within the reach or beyond it.
    held_levels: Vec<BTreeMap<u32, usize>>,
    /// Per entity, the coarsest level the renderer binds beside the finest
    /// selected one. It only falls as the refinement goes finer, and an
    /// ancestor past it costs nothing, since nothing could sample it.
    reach: Vec<u32>,
    heap: BinaryHeap<Candidate>,
    /// What the selected cells and the ancestors cost together.
    used: Cost,
    /// What the ancestors cost, of `used`.
    held_used: Cost,
    counts: CullCounts,
    found: Vec<ScoredChunk>,
}

impl<'s, 'a> Refiner<'s, 'a> {
    fn new(
        entities: &'s [SelectionEntity<'a>],
        previous: &'s PreviousSelection,
        ancestors: Option<Ancestors>,
    ) -> Self {
        Self {
            entities,
            previous,
            ancestors,
            selected: CellMap::default(),
            refined: CellSet::default(),
            detail_levels: vec![BTreeMap::new(); entities.len()],
            held: CellMap::default(),
            held_levels: vec![BTreeMap::new(); entities.len()],
            reach: vec![u32::MAX; entities.len()],
            heap: BinaryHeap::new(),
            used: Cost::default(),
            held_used: Cost::default(),
            counts: CullCounts::default(),
            found: Vec::new(),
        }
    }

    /// The device pixels one sample of `cell` spans where it is nearest the eye.
    fn measure(&self, cell: Cell) -> f64 {
        let entities = self.entities;
        let entity = &entities[cell.entity as usize];
        let query = &entity.queries[cell.level as usize];
        let (lo, hi) = query.cell_box([cell.x, cell.y, cell.z]);
        let ratio = entity
            .ratios
            .get(cell.level as usize)
            .copied()
            .unwrap_or(1.0);
        entity.view.pixels_per_sample_at(query.position(), lo, hi) * ratio
    }

    /// The measure the last selection's choice leans by: a cell it refined
    /// keeps refining, and one it kept stays, until the measure moves past
    /// the boundary by the band.
    fn priority(&self, cell: Cell, measure: f64) -> f64 {
        if self.previous.refined.contains(&cell) {
            measure * band()
        } else if self.previous.kept.contains(&cell) {
            measure / band()
        } else {
            measure
        }
    }

    /// Queue `cell` for refinement if it has a finer level to go to and the
    /// screen, or its pin, calls for one.
    fn offer(&mut self, cell: Cell, measure: f64) {
        let entities = self.entities;
        let entity = &entities[cell.entity as usize];
        if entity.finer(cell.level).is_none() {
            return;
        }
        let priority = self.priority(cell, measure);
        let wanted = match entity.pin {
            Some(pin) => cell.level > pin,
            None => priority > 1.0,
        };
        if wanted {
            self.heap.push(Candidate { priority, cell });
        }
    }

    fn select(&mut self, cell: Cell, distance: f64) {
        let measure = self.measure(cell);
        let ancestors = self.ancestors_of(cell, measure);
        self.select_with(cell, distance, measure, ancestors);
    }

    /// Select `cell`, whose measure is `measure` and whose ancestors are
    /// `ancestors`.
    fn select_with(
        &mut self,
        cell: Cell,
        distance: f64,
        measure: f64,
        ancestors: Vec<(Cell, f64)>,
    ) {
        let entities = self.entities;
        let entity = &entities[cell.entity as usize];
        if entity.charged(cell.level) {
            // An ancestor selected in its own right is charged once.
            let was_held = self.held.contains_key(&cell);
            if was_held {
                count_down(&mut self.held_levels[cell.entity as usize], cell.level);
            }
            let cost = entity.cost(cell.level);
            if was_held && self.within_reach(cell) {
                self.held_used = self.held_used.sub(cost);
            } else {
                self.used = self.used.add(cost);
            }
            *self.detail_levels[cell.entity as usize]
                .entry(cell.level)
                .or_default() += 1;
        }
        self.selected.insert(
            cell,
            SelectedCell {
                cell,
                measure,
                distance,
            },
        );
        for (ancestor, distance) in ancestors {
            self.hold(ancestor, distance);
        }
        self.offer(cell, measure);
    }

    fn unselect(&mut self, cell: Cell) {
        let Some(selected) = self.selected.remove(&cell) else {
            return;
        };
        let entities = self.entities;
        let entity = &entities[cell.entity as usize];
        if entity.charged(cell.level) {
            count_down(&mut self.detail_levels[cell.entity as usize], cell.level);
            // A cell still an ancestor of others stays, as theirs.
            let held = self.held.contains_key(&cell);
            if held {
                *self.held_levels[cell.entity as usize]
                    .entry(cell.level)
                    .or_default() += 1;
            }
            let cost = entity.cost(cell.level);
            if held && self.within_reach(cell) {
                self.held_used = self.held_used.add(cost);
            } else {
                self.used = self.used.sub(cost);
            }
        }
        // The same cells it held when selected: the choice reads only the
        // cell, its measure and the previous selection.
        for (ancestor, _) in self.ancestors_of(cell, selected.measure) {
            self.release(ancestor);
        }
    }

    /// Whether `cell` lies within its entity's reach.
    fn within_reach(&self, cell: Cell) -> bool {
        cell.level <= self.reach[cell.entity as usize]
    }

    /// The coarser cells over `cell` that the view samples and that a frame
    /// at the ancestors' scale would sample there, each with its distance
    /// from the focus. `measure` is the device pixels one of `cell`'s samples
    /// spans where it is nearest the eye, so a sample of a coarser level
    /// spans that times the levels' ratio, and the frame's pixels are fewer
    /// by its scale. A level whose samples span more than one of the frame's
    /// pixels there is one the frame never falls through to, and ends them.
    /// So does a level the coarse tier holds, resident under every cell
    /// already.
    ///
    /// A cell the last selection kept as an ancestor is kept until its span
    /// passes one pixel by the target level's hysteresis band, so a cell near
    /// the bound does not come and go as the view moves.
    fn ancestors_of(&mut self, cell: Cell, measure: f64) -> Vec<(Cell, f64)> {
        let mut out = Vec::new();
        let Some(ancestors) = self.ancestors else {
            return out;
        };
        let entities = self.entities;
        let entity = &entities[cell.entity as usize];
        let ratio = |level: u32| entity.ratios.get(level as usize).copied().unwrap_or(1.0);
        let own = ratio(cell.level);
        let mut level = cell.level;
        while let Some(coarser) = entity.coarser(level) {
            let span = measure * ancestors.scale * ratio(coarser) / own;
            if span.is_nan() || span > band() {
                break;
            }
            let (lo, hi) = entity.queries[cell.level as usize].cell_box([cell.x, cell.y, cell.z]);
            self.found.clear();
            // Its own counts: the planner's culling counters say what the
            // selection considered drawing, not what it keeps beside it.
            chunk::enumerate_chunks_within(
                entity.view,
                &entity.queries[coarser as usize],
                lo,
                hi,
                &mut CullCounts::default(),
                &mut self.found,
            );
            for found in &self.found {
                let ancestor = Cell {
                    entity: cell.entity,
                    level: coarser,
                    z: found.z,
                    y: found.y,
                    x: found.x,
                };
                if span <= 1.0 || self.previous.ancestors.contains(&ancestor) {
                    out.push((ancestor, found.distance));
                }
            }
            level = coarser;
        }
        out
    }

    /// Whether `ancestor` would cost the budget once held: not held or
    /// selected yet, at a charged level within its entity's reach.
    fn costs_to_hold(&self, ancestor: Cell) -> bool {
        let entity = &self.entities[ancestor.entity as usize];
        !self.held.contains_key(&ancestor)
            && !self.selected.contains_key(&ancestor)
            && entity.charged(ancestor.level)
            && self.within_reach(ancestor)
    }

    fn hold(&mut self, ancestor: Cell, distance: f64) {
        let held = self.held.entry(ancestor).or_insert(Held {
            holders: 0,
            distance,
        });
        held.holders += 1;
        if held.holders > 1 || self.selected.contains_key(&ancestor) {
            return;
        }
        let entities = self.entities;
        let entity = &entities[ancestor.entity as usize];
        if entity.charged(ancestor.level) {
            *self.held_levels[ancestor.entity as usize]
                .entry(ancestor.level)
                .or_default() += 1;
            if self.within_reach(ancestor) {
                let cost = entity.cost(ancestor.level);
                self.used = self.used.add(cost);
                self.held_used = self.held_used.add(cost);
            }
        }
    }

    fn release(&mut self, ancestor: Cell) {
        let Some(held) = self.held.get_mut(&ancestor) else {
            return;
        };
        held.holders -= 1;
        if held.holders > 0 {
            return;
        }
        self.held.remove(&ancestor);
        if self.selected.contains_key(&ancestor) {
            return;
        }
        let entities = self.entities;
        let entity = &entities[ancestor.entity as usize];
        if entity.charged(ancestor.level) {
            count_down(
                &mut self.held_levels[ancestor.entity as usize],
                ancestor.level,
            );
            if self.within_reach(ancestor) {
                let cost = entity.cost(ancestor.level);
                self.used = self.used.sub(cost);
                self.held_used = self.held_used.sub(cost);
            }
        }
    }

    /// What the ancestors of one entity between `reach` and its reach now
    /// cost, which bringing its reach down to `reach` gives up.
    fn held_beyond(&self, entity_index: usize, reach: u32) -> Cost {
        let entity = &self.entities[entity_index];
        let now = self.reach[entity_index];
        if reach >= now {
            return Cost::default();
        }
        self.held_levels[entity_index]
            .range(reach + 1..=now)
            .fold(Cost::default(), |sum, (&level, &count)| {
                sum.add(entity.cost(level).scaled(count as f64))
            })
    }

    /// The ancestors the selected cells hold that are not selected, which
    /// the renderer can bind, in fetch order.
    fn held_cells(&self) -> Vec<SelectedCell> {
        let mut cells: Vec<SelectedCell> = self
            .held
            .iter()
            .filter(|(cell, _)| {
                !self.selected.contains_key(cell)
                    && self.entities[cell.entity as usize].charged(cell.level)
                    && self.within_reach(**cell)
            })
            .map(|(&cell, held)| SelectedCell {
                cell,
                measure: self.measure(cell),
                distance: held.distance,
            })
            .collect();
        cells.sort_by(fetch_order);
        cells
    }

    /// Every cell of the entity's start level the view samples.
    fn seed(&mut self, entity_index: usize) {
        let entities = self.entities;
        let entity = &entities[entity_index];
        let Some(query) = entity.queries.get(entity.start as usize) else {
            return;
        };
        self.found.clear();
        chunk::enumerate_chunks(entity.view, query, &mut self.counts, &mut self.found);
        let start = entity.start;
        for found in std::mem::take(&mut self.found) {
            let cell = Cell {
                entity: entity_index as u32,
                level: start,
                z: found.z,
                y: found.y,
                x: found.x,
            };
            self.select(cell, found.distance);
        }
    }

    /// The cells of level `finer` that cover `cell` and that the view
    /// samples, each with its distance from the focus.
    fn children(&mut self, cell: Cell, finer: u32) -> Vec<(Cell, f64)> {
        let entities = self.entities;
        let entity = &entities[cell.entity as usize];
        let (lo, hi) = entity.queries[cell.level as usize].cell_box([cell.x, cell.y, cell.z]);
        self.found.clear();
        chunk::enumerate_chunks_within(
            entity.view,
            &entity.queries[finer as usize],
            lo,
            hi,
            &mut self.counts,
            &mut self.found,
        );
        self.found
            .iter()
            .map(|found| {
                let child = Cell {
                    entity: cell.entity,
                    level: finer,
                    z: found.z,
                    y: found.y,
                    x: found.x,
                };
                (child, found.distance)
            })
            .collect()
    }

    /// Refine in priority order until nothing calls for it or the next
    /// refinement would not fit: the selected cells within `budget`, and
    /// with their ancestors within `with_ancestors`. Returns the priority of
    /// the refinement the budget refused, if it refused one, and leaves it
    /// queued.
    ///
    /// With `ahead`, the cells refinements add are fetched beside the
    /// selection rather than in place of what they refine, so they are
    /// charged to its room without the refunds and collected in it.
    fn refine(
        &mut self,
        budget: Cost,
        with_ancestors: Cost,
        mut ahead: Option<&mut Ahead>,
    ) -> Option<f64> {
        while let Some(&top) = self.heap.peek() {
            let cell = top.cell;
            if !self.selected.contains_key(&cell) || self.refined.contains(&cell) {
                self.heap.pop();
                continue;
            }
            let entities = self.entities;
            let entity = &entities[cell.entity as usize];
            let Some(finer) = entity.finer(cell.level) else {
                self.heap.pop();
                continue;
            };

            // The renderer draws an entity from its finest detail level and
            // the next few. A refinement past that window gives up the
            // coarsest detail cells to the coarse tier under them, and one
            // that would land outside it, or leave holes with no coarse tier
            // beneath, is not made.
            let levels = &self.detail_levels[cell.entity as usize];
            let finest = levels.keys().next().map_or(finer, |&f| f.min(finer));
            let reach = finest + (MAX_LEVEL_SOURCES - 1);
            let beyond = levels.range(reach + 1..).next().is_some();
            if finer > reach || (beyond && !entity.start_free) {
                self.heap.pop();
                continue;
            }
            let given_up = levels
                .range(reach + 1..)
                .fold(Cost::default(), |sum, (&level, &count)| {
                    sum.add(entity.cost(level).scaled(count as f64))
                });

            let children: Vec<(Cell, f64)> = self
                .children(cell, finer)
                .into_iter()
                .filter(|(child, _)| {
                    !self.selected.contains_key(child) && !self.refined.contains(child)
                })
                .collect();
            let lineage: Vec<(f64, Vec<(Cell, f64)>)> = children
                .iter()
                .map(|&(child, _)| {
                    let measure = self.measure(child);
                    (measure, self.ancestors_of(child, measure))
                })
                .collect();
            // What the children's ancestors add: in a grid that nests, the
            // cell refined is the first, and its own first is often held
            // already. What the refinement lets go of is left out, so the
            // check errs toward the budget.
            let mut adding = CellSet::default();
            let mut added = Cost::default();
            for &(ancestor, _) in lineage.iter().flat_map(|(_, ancestors)| ancestors) {
                if ancestor.level <= reach
                    && self.costs_to_hold(ancestor)
                    && adding.insert(ancestor)
                {
                    added = added.add(entity.cost(ancestor.level));
                }
            }
            let held_beyond = self.held_beyond(cell.entity as usize, reach);
            let mut after = self
                .used
                .add(entity.cost(finer).scaled(children.len() as f64))
                .add(added)
                .sub(given_up)
                .sub(held_beyond);
            let mut held_after = self.held_used.add(added).sub(held_beyond);
            // The cell refined stays, as an ancestor, while a child or
            // another selected cell keeps it.
            let stays = self.held.contains_key(&cell)
                || lineage
                    .iter()
                    .any(|(_, ancestors)| ancestors.iter().any(|&(a, _)| a == cell));
            if entity.charged(cell.level) {
                if stays {
                    held_after = held_after.add(entity.cost(cell.level));
                } else {
                    after = after.sub(entity.cost(cell.level));
                }
            }
            let fits = match ahead.as_deref() {
                Some(ahead) => ahead
                    .spent
                    .add(entity.cost(finer).scaled(children.len() as f64))
                    .within(ahead.room),
                None => after.within(with_ancestors) && after.sub(held_after).within(budget),
            };
            if !fits {
                return Some(top.priority);
            }

            self.heap.pop();
            self.lower_reach(cell.entity as usize, reach);
            if beyond {
                let dropped: Vec<Cell> = self
                    .selected
                    .keys()
                    .copied()
                    .filter(|c| {
                        c.entity == cell.entity && c.level > reach && entity.charged(c.level)
                    })
                    .collect();
                for cell in dropped {
                    self.unselect(cell);
                }
            }
            // The children go in before the cell comes out, so the cell
            // passes from selected to held without leaving the budget.
            for ((child, distance), (measure, ancestors)) in children.into_iter().zip(lineage) {
                self.select_with(child, distance, measure, ancestors);
                if let Some(ahead) = ahead.as_deref_mut() {
                    ahead.spent = ahead.spent.add(entity.cost(finer));
                    ahead.cells.push(child);
                }
            }
            self.unselect(cell);
            self.refined.insert(cell);
        }
        None
    }

    /// Bring an entity's reach down to `reach`, and stop charging the
    /// ancestors past it.
    fn lower_reach(&mut self, entity_index: usize, reach: u32) {
        let beyond = self.held_beyond(entity_index, reach);
        if reach < self.reach[entity_index] {
            self.used = self.used.sub(beyond);
            self.held_used = self.held_used.sub(beyond);
            self.reach[entity_index] = reach;
        }
    }

    /// The selected cells in fetch order.
    fn cells(&self) -> Vec<SelectedCell> {
        let mut cells: Vec<SelectedCell> = self.selected.values().copied().collect();
        cells.sort_by(fetch_order);
        cells
    }

    /// The parents, one detail level coarser, of the finest selected cells
    /// of each entity, largest measure first, as far as `room` holds them.
    fn coarser_cells(&mut self, room: Cost) -> Vec<SelectedCell> {
        let finest: Vec<Option<u32>> = self
            .detail_levels
            .iter()
            .map(|levels| levels.keys().next().copied())
            .collect();
        let mut sources: Vec<Cell> = self
            .selected
            .keys()
            .copied()
            .filter(|cell| finest[cell.entity as usize] == Some(cell.level))
            .collect();
        sources.sort_unstable();
        let mut parents = CellMap::default();
        let entities = self.entities;
        for cell in sources {
            let entity = &entities[cell.entity as usize];
            let Some(coarser) = entity.coarser(cell.level) else {
                continue;
            };
            for (parent, distance) in self.children(cell, coarser) {
                if !self.selected.contains_key(&parent) && !self.held.contains_key(&parent) {
                    parents.insert(parent, distance);
                }
            }
        }
        let mut ahead: Vec<SelectedCell> = parents
            .into_iter()
            .map(|(cell, distance)| SelectedCell {
                cell,
                measure: self.measure(cell),
                distance,
            })
            .collect();
        ahead.sort_by(|a, b| {
            b.measure
                .total_cmp(&a.measure)
                .then_with(|| a.cell.cmp(&b.cell))
        });
        let mut spent = Cost::default();
        ahead
            .into_iter()
            .take_while(|cell| {
                spent = spent.add(entities[cell.cell.entity as usize].cost(cell.cell.level));
                spent.within(room)
            })
            .collect()
    }
}

/// Select the levels one view draws its `entities` at.
///
/// Every visible cell starts at its entity's start level. The selection then
/// repeatedly refines the selected cell with the largest measure, replacing
/// it with the cells of the next finer level that overlap it, until each
/// cell's samples span at most one device pixel, or its entity's pin is
/// reached, or the next refinement would take what the selected cells cost
/// past `share` of `budget`. Grids that don't nest refine by overlap: a cell
/// two parents share is selected and charged once, and one already refined
/// is never added back, since its own cells cover it.
///
/// `previous` tilts close calls toward the last selection by the target
/// level's hysteresis band, both in which cell refines first and in the
/// one-pixel stop, so a small camera move keeps the set it had. `lookahead`
/// asks for the cells worth fetching ahead in the room the share leaves.
///
/// With `ancestors`, each selected cell keeps the ancestors a frame at their
/// scale would sample, and the selected cells with their ancestors stay
/// within the ancestors' share of `budget`. A refinement keeps the cell it
/// refines while one of its children keeps it as an ancestor.
pub fn select_levels(
    entities: &[SelectionEntity],
    budget: Cost,
    share: f64,
    previous: &PreviousSelection,
    lookahead: Lookahead,
    ancestors: Option<Ancestors>,
) -> LevelSelection {
    let mut refiner = Refiner::new(entities, previous, ancestors);
    for index in 0..entities.len() {
        refiner.seed(index);
    }
    let share = share.clamp(0.0, 1.0);
    let with_ancestors = ancestors.map_or(share, |a| a.share.clamp(share, 1.0));
    let limit = refiner.refine(budget.scaled(share), budget.scaled(with_ancestors), None);
    let cells = refiner.cells();
    let held = refiner.held_cells();
    let mut refined: Vec<Cell> = refiner.refined.iter().copied().collect();
    refined.sort_unstable();
    let used = refiner.used;
    let ancestors_used = refiner.held_used;
    let lookahead = match lookahead {
        Lookahead::None => Vec::new(),
        Lookahead::Finer => {
            let mut ahead = Ahead {
                cells: Vec::new(),
                spent: Cost::default(),
                room: budget.sub(used),
            };
            refiner.refine(budget, budget, Some(&mut ahead));
            ahead
                .cells
                .into_iter()
                .filter_map(|cell| refiner.selected.get(&cell).copied())
                .collect()
        }
        Lookahead::Coarser => refiner.coarser_cells(budget.sub(used)),
    };
    LevelSelection {
        cells,
        ancestors: held,
        lookahead,
        refined,
        used: used.sub(ancestors_used),
        ancestors_used,
        limit,
        counts: refiner.counts,
    }
}

/// Numbers at the head of each entity in [`select_batch`]'s input: the index
/// of its view among the regions, its place on the two axes the view draws,
/// its coarse level or -1, its level pin or -1, its render radius, and how
/// many levels follow.
pub const ENTITY_HEADER: usize = 7;

/// Numbers per level after an entity's header: X, Y, Z of the level's shape,
/// of its chunk shape and of its chunk grid; what one cell costs the CPU and
/// the GPU; and 1 when the detail tier may hold it.
pub const LEVEL_STRIDE: usize = 12;

/// Numbers per cell in [`select_batch`]'s previous selection: entity, level,
/// X, Y, Z, and 0 for a cell it kept, 1 for one it refined, or 2 for one it
/// kept as an ancestor. A cell refined and kept as an ancestor may come twice.
pub const PREVIOUS_STRIDE: usize = 6;

/// Numbers per cell in [`select_batch`]'s output: entity, level, X, Y, Z,
/// measure, distance, and 1 for an ancestor the selection keeps or 0
/// otherwise. A refined cell has no measure or distance, and writes zeros.
pub const CELL_STRIDE: usize = 8;

/// Numbers at the head of [`select_batch`]'s output: how many fetched cells,
/// the selected ones and their ancestors in one fetch order, then lookahead
/// and refined cells follow, in that order; the CPU and GPU bytes the
/// selected cells use; the refused refinement's measure or -1; the four
/// [`CullCounts`] in field order; and the CPU and GPU bytes the ancestors
/// use.
pub const SELECTION_HEADER: usize = 12;

/// [`select_levels`] over the flat numeric layout the strides above describe,
/// so a client crosses into the core once per view. `views` are the regions
/// the entities name by index. A malformed entity, one whose numbers run
/// short, ends the input there.
pub fn select_batch(
    views: &[ChunkView],
    entities: &[f64],
    previous: &[f64],
    budget: Cost,
    share: f64,
    lookahead: Lookahead,
    ancestors: Option<Ancestors>,
) -> Vec<f64> {
    let index = |v: f64| -> Option<u32> {
        (v.is_finite() && v >= 0.0 && v <= u32::MAX as f64).then_some(v as u32)
    };
    let mut parsed = Vec::new();
    let mut at = 0;
    while at + ENTITY_HEADER <= entities.len() {
        let head = &entities[at..at + ENTITY_HEADER];
        let count = index(head[6]).unwrap_or(0) as usize;
        let end = at + ENTITY_HEADER + count * LEVEL_STRIDE;
        let Some(view) = index(head[0]).and_then(|v| views.get(v as usize)) else {
            break;
        };
        if end > entities.len() {
            break;
        }
        let mut levels = Vec::with_capacity(count);
        let mut costs = Vec::with_capacity(count);
        let mut sources = Vec::new();
        let (per_level, _) = entities[at + ENTITY_HEADER..end].as_chunks::<LEVEL_STRIDE>();
        for (level, numbers) in per_level.iter().enumerate() {
            let dims = |i: usize| -> [u64; 5] {
                let n = |v: f64| index(v).unwrap_or(0) as u64;
                [1, 1, n(numbers[i + 2]), n(numbers[i + 1]), n(numbers[i])]
            };
            levels.push(LevelGeometry {
                level_index: level as u32,
                shape: dims(0),
                chunk_shape: dims(3),
                grid_shape: dims(6),
                scale: [1.0; 5],
            });
            costs.push(Cost {
                cpu: numbers[9],
                gpu: numbers[10],
            });
            if numbers[11] > 0.0 {
                sources.push(level as u32);
            }
        }
        parsed.push(SelectionEntity::new(
            view,
            [head[1], head[2]],
            &levels,
            costs,
            sources,
            index(head[3]),
            index(head[4]),
            head[5],
        ));
        at = end;
    }

    let mut last = PreviousSelection::default();
    let (previous, _) = previous.as_chunks::<PREVIOUS_STRIDE>();
    for numbers in previous {
        let (Some(entity), Some(level), Some(x), Some(y), Some(z)) = (
            index(numbers[0]),
            index(numbers[1]),
            index(numbers[2]),
            index(numbers[3]),
            index(numbers[4]),
        ) else {
            continue;
        };
        let cell = Cell {
            entity,
            level,
            z,
            y,
            x,
        };
        if numbers[5] > 1.5 {
            last.ancestors.insert(cell);
        } else if numbers[5] > 0.0 {
            last.refined.insert(cell);
        } else {
            last.kept.insert(cell);
        }
    }

    let selection = select_levels(&parsed, budget, share, &last, lookahead, ancestors);
    let mut fetched: Vec<(&SelectedCell, bool)> = selection
        .cells
        .iter()
        .map(|cell| (cell, false))
        .chain(selection.ancestors.iter().map(|cell| (cell, true)))
        .collect();
    fetched.sort_by(|a, b| fetch_order(a.0, b.0));
    let mut out = Vec::with_capacity(
        SELECTION_HEADER
            + (fetched.len() + selection.lookahead.len() + selection.refined.len()) * CELL_STRIDE,
    );
    out.extend_from_slice(&[
        fetched.len() as f64,
        selection.lookahead.len() as f64,
        selection.refined.len() as f64,
        selection.used.cpu,
        selection.used.gpu,
        selection.limit.unwrap_or(-1.0),
        selection.counts.considered as f64,
        selection.counts.after_xy_bounds as f64,
        selection.counts.after_z_range as f64,
        selection.counts.after_frustum as f64,
        selection.ancestors_used.cpu,
        selection.ancestors_used.gpu,
    ]);
    let mut push = |cell: Cell, measure: f64, distance: f64, ancestor: bool| {
        out.extend_from_slice(&[
            f64::from(cell.entity),
            f64::from(cell.level),
            f64::from(cell.x),
            f64::from(cell.y),
            f64::from(cell.z),
            measure,
            distance,
            if ancestor { 1.0 } else { 0.0 },
        ]);
    };
    for (cell, ancestor) in fetched {
        push(cell.cell, cell.measure, cell.distance, ancestor);
    }
    for cell in &selection.lookahead {
        push(cell.cell, cell.measure, cell.distance, false);
    }
    for &cell in &selection.refined {
        push(cell, 0.0, 0.0, false);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::{Arcball, Camera, VisibleRegion};
    use crate::chunk::RENDER_RADIUS_DISABLED;
    use crate::target_level::{IN_PLANE_AXES, VOLUME_AXES, target_level};
    use crate::transform::compute_volume_transform;
    use std::collections::BTreeSet;

    /// A level from `[Z, Y, X]` shapes, one timepoint and one channel.
    fn geo(level: u32, shape_zyx: [u64; 3], chunk_zyx: [u64; 3]) -> LevelGeometry {
        let shape = [1, 1, shape_zyx[0], shape_zyx[1], shape_zyx[2]];
        let chunk_shape = [1, 1, chunk_zyx[0], chunk_zyx[1], chunk_zyx[2]];
        let grid_shape = std::array::from_fn(|d| shape[d].div_ceil(chunk_shape[d]));
        LevelGeometry {
            level_index: level,
            shape,
            chunk_shape,
            grid_shape,
            scale: [1.0; 5],
        }
    }

    /// A pyramid of `count` levels, each half the last along every axis,
    /// with `chunk`-sided cubic chunks.
    fn cube_pyramid(side: u64, chunk: u64, count: u32) -> Vec<LevelGeometry> {
        (0..count)
            .map(|level| {
                let n = (side >> level).max(1);
                geo(level, [n, n, n], [chunk.min(n); 3])
            })
            .collect()
    }

    /// A 2D image `side` samples square, 256-sample chunks, five levels.
    fn image(side: u64) -> Vec<LevelGeometry> {
        (0..5)
            .map(|level| {
                let n = side >> level;
                geo(level, [1, n, n], [1, 256.min(n), 256.min(n)])
            })
            .collect()
    }

    /// One byte per cell on both sides, so costs count cells.
    fn unit_costs(levels: &[LevelGeometry]) -> Vec<Cost> {
        vec![Cost { cpu: 1.0, gpu: 1.0 }; levels.len()]
    }

    fn cells_budget(cells: f64) -> Cost {
        Cost {
            cpu: cells,
            gpu: cells,
        }
    }

    /// An entity at `position` whose coarse tier holds its coarsest level and
    /// whose detail tier may hold the rest.
    fn placed<'a>(
        view: &'a ChunkView,
        levels: &[LevelGeometry],
        position: [f64; 2],
    ) -> SelectionEntity<'a> {
        let coarsest = levels.len() as u32 - 1;
        SelectionEntity::new(
            view,
            position,
            levels,
            unit_costs(levels),
            (0..coarsest).collect(),
            Some(coarsest),
            None,
            RENDER_RADIUS_DISABLED,
        )
    }

    fn entity<'a>(view: &'a ChunkView, levels: &[LevelGeometry]) -> SelectionEntity<'a> {
        placed(view, levels, [0.0, 0.0])
    }

    fn select(entities: &[SelectionEntity], budget: Cost) -> LevelSelection {
        select_levels(
            entities,
            budget,
            1.0,
            &PreviousSelection::default(),
            Lookahead::None,
            None,
        )
    }

    fn previous(selection: &LevelSelection) -> PreviousSelection {
        PreviousSelection {
            kept: selection.cells.iter().map(|c| c.cell).collect(),
            refined: selection.refined.iter().copied().collect(),
            ancestors: selection.ancestors.iter().map(|c| c.cell).collect(),
        }
    }

    fn set(selection: &LevelSelection) -> BTreeSet<Cell> {
        selection.cells.iter().map(|c| c.cell).collect()
    }

    fn levels_of(selection: &LevelSelection) -> BTreeSet<u32> {
        selection.cells.iter().map(|c| c.cell.level).collect()
    }

    fn cell_box(levels: &[LevelGeometry], cell: Cell) -> ([f64; 3], [f64; 3]) {
        ChunkQuery::new(
            &levels[cell.level as usize],
            &levels[0],
            [0.0, 0.0],
            RENDER_RADIUS_DISABLED,
        )
        .cell_box([cell.x, cell.y, cell.z])
    }

    /// A 512² slice view centered at `center` at `pixels_per_sample`.
    fn slice_at(pixels_per_sample: f64, center: [f64; 2]) -> ChunkView {
        let mut camera = Camera::new_2d([512, 512]);
        if let Camera::Slice(slice) = &mut camera {
            slice.zoom = pixels_per_sample;
            slice.center = center;
        }
        ChunkView::new(&camera.visible_region(&(0..1), None, None), 0.0)
    }

    fn slice_view(pixels_per_sample: f64) -> ChunkView {
        slice_at(pixels_per_sample, [1024.0, 1024.0])
    }

    /// A cube `side` samples deep, as the scene places it, seen by `arcball`.
    fn volume_region(arcball: Arcball, side: u32) -> VisibleRegion {
        let transform = compute_volume_transform([side; 3], [1.0; 3]);
        Camera::Arcball(arcball).visible_region(&(0..side), Some(&transform), Some(&[side; 3]))
    }

    fn volume_view(arcball: Arcball, side: u32) -> ChunkView {
        ChunkView::new(&volume_region(arcball, side), 0.0)
    }

    /// An arcball looking straight down Z at the volume's center from `distance`.
    fn head_on(distance: f64, viewport: [u32; 2]) -> Arcball {
        let mut arcball = Arcball::new(viewport);
        arcball.theta = 0.0;
        arcball.phi = std::f64::consts::FRAC_PI_2;
        arcball.distance = distance;
        arcball
    }

    #[test]
    fn a_slice_view_selects_the_target_level_when_it_fits() {
        let levels = image(2048);
        let ratios = level_shape_ratios(&levels, &IN_PLANE_AXES);
        for pixels_per_sample in [0.06, 0.2, 0.3, 0.6, 2.0] {
            let view = slice_view(pixels_per_sample);
            let selection = select(&[entity(&view, &levels)], cells_budget(1e9));
            // Level 4 is the coarse tier's, which the selection keeps when the
            // screen calls for it.
            let target = target_level(pixels_per_sample, &ratios, None);
            assert_eq!(
                levels_of(&selection),
                [target].into(),
                "at {pixels_per_sample}"
            );
            // Every cell of that level on screen, as the target level's plan wants.
            let mut found = Vec::new();
            let query = ChunkQuery::new(&levels[target as usize], &levels[0], [0.0, 0.0], 2.0);
            chunk::enumerate_chunks(&view, &query, &mut CullCounts::default(), &mut found);
            assert_eq!(selection.cells.len(), found.len());
            assert_eq!(selection.limit, None);
        }
    }

    #[test]
    fn a_volume_view_draws_the_target_level_at_the_hit_and_nothing_finer() {
        // The hit 3 world units from the eye, 724 device pixels per world unit
        // at unit distance and 512 samples per world unit: 0.47 pixels per
        // sample, which calls for level 1.
        let region = volume_region(head_on(3.5, [800, 600]), 512);
        let levels = cube_pyramid(512, 64, 4);
        let target = target_level(
            region.effective_zoom,
            &level_shape_ratios(&levels, &VOLUME_AXES),
            None,
        );
        assert_eq!(target, 1);
        let view = ChunkView::new(&region, 0.0);
        let selection = select(&[entity(&view, &levels)], cells_budget(1e9));
        assert!(selection.cells.iter().all(|c| c.cell.level >= target));
        let hit = region.sort_center.unwrap();
        let at_hit = selection
            .cells
            .iter()
            .find(|c| {
                let (lo, hi) = cell_box(&levels, c.cell);
                (0..3).all(|a| lo[a] <= hit[a] && hit[a] <= hi[a])
            })
            .unwrap();
        assert_eq!(at_hit.cell.level, target);
    }

    #[test]
    fn the_measure_at_the_hit_is_the_target_levels_measure() {
        let region = volume_region(Arcball::new([800, 600]), 512);
        let hit = region.sort_center.unwrap();
        let measured = region.measure.at_box(hit, hit);
        assert!((measured / region.effective_zoom - 1.0).abs() < 1e-4);
    }

    #[test]
    fn it_stays_within_the_budget() {
        let view = volume_view(Arcball::new([800, 600]), 512);
        let levels = cube_pyramid(512, 32, 5);
        for cells in [0.0, 1.0, 10.0, 100.0, 333.0, 1000.0, 4000.0] {
            for share in [0.5, 0.8, 1.0] {
                let selection = select_levels(
                    &[entity(&view, &levels)],
                    cells_budget(cells),
                    share,
                    &PreviousSelection::default(),
                    Lookahead::Finer,
                    None,
                );
                let charged = selection.cells.iter().filter(|c| c.cell.level != 4).count() as f64;
                assert_eq!(selection.used.cpu, charged);
                assert!(selection.used.cpu <= cells * share, "{cells} at {share}");
                let ahead = selection.lookahead.len() as f64;
                assert!(selection.used.cpu + ahead <= cells, "{cells} at {share}");
                let chosen = set(&selection);
                assert!(
                    selection
                        .lookahead
                        .iter()
                        .all(|c| !chosen.contains(&c.cell))
                );
            }
        }
    }

    #[test]
    fn the_gpu_budget_binds_as_the_cpu_budget_does() {
        let view = volume_view(Arcball::new([800, 600]), 512);
        let levels = cube_pyramid(512, 32, 5);
        let selection = select(
            &[entity(&view, &levels)],
            Cost {
                cpu: 1e9,
                gpu: 50.0,
            },
        );
        assert!(selection.used.gpu <= 50.0);
        assert!(selection.limit.is_some());
    }

    #[test]
    fn a_budget_of_nothing_keeps_the_coarse_tier_and_says_it_stopped() {
        let view = volume_view(Arcball::new([800, 600]), 512);
        let levels = cube_pyramid(512, 64, 4);
        let selection = select(&[entity(&view, &levels)], cells_budget(0.0));
        assert_eq!(levels_of(&selection), [3].into());
        assert_eq!(selection.used, Cost::default());
        assert!(selection.limit.unwrap() > 1.0);
    }

    #[test]
    fn without_a_coarse_tier_it_starts_at_the_coarsest_source_level_and_pays_for_it() {
        let view = slice_view(0.03);
        let levels = image(2048);
        let entity = SelectionEntity::new(
            &view,
            [0.0, 0.0],
            &levels,
            unit_costs(&levels),
            (0..5).collect(),
            None,
            None,
            RENDER_RADIUS_DISABLED,
        );
        let selection = select(&[entity], cells_budget(1e9));
        assert_eq!(levels_of(&selection), [4].into());
        assert_eq!(selection.used.cpu, selection.cells.len() as f64);
    }

    #[test]
    fn it_is_deterministic() {
        let view = volume_view(Arcball::new([800, 600]), 512);
        let levels = cube_pyramid(512, 32, 5);
        let run = || {
            select_levels(
                &[entity(&view, &levels), placed(&view, &levels, [512.0, 0.0])],
                cells_budget(700.0),
                0.8,
                &PreviousSelection::default(),
                Lookahead::Finer,
                None,
            )
        };
        let first = run();
        for _ in 0..5 {
            assert_eq!(run(), first);
        }
    }

    #[test]
    fn near_chunks_refine_before_far_ones() {
        let view = volume_view(Arcball::new([800, 600]), 512);
        let levels = cube_pyramid(512, 32, 5);
        let selection = select(&[entity(&view, &levels)], cells_budget(300.0));
        let finest = selection.cells.iter().map(|c| c.cell.level).min().unwrap();
        let coarsest = selection.cells.iter().map(|c| c.cell.level).max().unwrap();
        assert!(finest < coarsest);
        // Pixels per level-0 sample: the finer cells sit nearer the eye.
        let mean = |level: u32| {
            let at: Vec<f64> = selection
                .cells
                .iter()
                .filter(|c| c.cell.level == level)
                .map(|c| c.measure / f64::from(1u32 << level))
                .collect();
            at.iter().sum::<f64>() / at.len() as f64
        };
        assert!(mean(finest) > mean(coarsest));
    }

    #[test]
    fn a_small_camera_move_keeps_the_selection() {
        let levels = cube_pyramid(512, 32, 5);
        let mut arcball = Arcball::new([800, 600]);
        let view = volume_view(arcball.clone(), 512);
        let first = select(&[entity(&view, &levels)], cells_budget(400.0));
        assert!(first.limit.is_some(), "the budget should stop it");
        for step in [0.002, 0.005, -0.004] {
            arcball.theta += step;
            let moved = volume_view(arcball.clone(), 512);
            let next = select_levels(
                &[entity(&moved, &levels)],
                cells_budget(400.0),
                1.0,
                &previous(&first),
                Lookahead::None,
                None,
            );
            assert_eq!(set(&next), set(&first), "after turning by {step}");
        }
    }

    #[test]
    fn a_zoom_inside_the_band_keeps_the_level() {
        let levels = image(2048);
        // Level 1 is the target below half a pixel per sample.
        let before = select(&[entity(&slice_view(0.48), &levels)], cells_budget(1e9));
        assert_eq!(levels_of(&before), [1].into());
        let view = slice_view(0.52);
        assert_eq!(
            levels_of(&select(&[entity(&view, &levels)], cells_budget(1e9))),
            [0].into()
        );
        let held = select_levels(
            &[entity(&view, &levels)],
            cells_budget(1e9),
            1.0,
            &previous(&before),
            Lookahead::None,
            None,
        );
        assert_eq!(levels_of(&held), [1].into());
        let past = select_levels(
            &[entity(&slice_view(0.62), &levels)],
            cells_budget(1e9),
            1.0,
            &previous(&before),
            Lookahead::None,
            None,
        );
        assert_eq!(levels_of(&past), [0].into());
    }

    #[test]
    fn grids_that_do_not_nest_refine_by_overlap() {
        // Level 1's 32-sample chunks span 64 level-0 samples, across level
        // 0's 48-sample chunks: its cell over [64, 128) covers level 0's
        // cells over [48, 96) and [96, 144), and shares the first with its
        // neighbor.
        let levels = vec![
            geo(0, [1, 192, 192], [1, 48, 48]),
            geo(1, [1, 96, 96], [1, 32, 32]),
            geo(2, [1, 48, 48], [1, 48, 48]),
        ];
        let view = slice_at(2.0, [96.0, 96.0]);
        let selection = select(&[entity(&view, &levels)], cells_budget(1e9));
        assert_eq!(levels_of(&selection), [0].into());
        assert_eq!(set(&selection).len(), 16);
        assert_eq!(selection.used.cpu, 16.0);

        // Stopped partway, the cells still cover every sample, and each is
        // charged once.
        for cells in [1.0, 5.0, 9.0, 12.0] {
            let selection = select(&[entity(&view, &levels)], cells_budget(cells));
            let charged = selection.cells.iter().filter(|c| c.cell.level != 2).count();
            assert_eq!(selection.used.cpu, charged as f64);
            assert!(selection.used.cpu <= cells);
            for y in (0..192).step_by(7) {
                for x in (0..192).step_by(7) {
                    let point = [x as f64 + 0.5, y as f64 + 0.5];
                    let covered = selection.cells.iter().any(|c| {
                        let (lo, hi) = cell_box(&levels, c.cell);
                        (0..2).all(|a| lo[a] <= point[a] && point[a] < hi[a])
                    });
                    assert!(covered, "{point:?} with {cells} cells");
                }
            }
        }
    }

    #[test]
    fn a_pinned_entity_refines_to_its_pin() {
        let levels = image(2048);
        let view = slice_view(0.03);
        let pinned = SelectionEntity::new(
            &view,
            [0.0, 0.0],
            &levels,
            unit_costs(&levels),
            (0..4).collect(),
            Some(4),
            Some(1),
            RENDER_RADIUS_DISABLED,
        );
        let selection = select(&[pinned], cells_budget(1e9));
        assert_eq!(levels_of(&selection), [1].into());
    }

    #[test]
    fn a_level_that_only_thins_the_cut_axis_is_passed_over_in_a_slice_view() {
        let levels = vec![
            geo(0, [64, 2048, 2048], [16, 256, 256]),
            geo(1, [32, 2048, 2048], [16, 256, 256]),
            geo(2, [32, 1024, 1024], [16, 256, 256]),
        ];
        let view = slice_view(0.9);
        let selection = select(&[entity(&view, &levels)], cells_budget(1e9));
        assert_eq!(levels_of(&selection), [0].into());
    }

    #[test]
    fn the_selection_spans_no_more_detail_levels_than_the_renderer_binds() {
        // The eye a hundredth of the volume from its face and the far face a
        // whole volume away: the near cells call for level 0 and the far ones
        // for level 5, more than four levels apart.
        let levels = cube_pyramid(4096, 64, 7);
        let view = volume_view(head_on(0.51, [100, 75]), 4096);
        let selection = select(&[entity(&view, &levels)], cells_budget(1e9));
        let detail: Vec<u32> = levels_of(&selection)
            .into_iter()
            .filter(|&l| l != 6)
            .collect();
        assert_eq!(detail.first(), Some(&0));
        assert!(detail.last().unwrap() - detail.first().unwrap() < MAX_LEVEL_SOURCES);
        let charged = selection.cells.iter().filter(|c| c.cell.level != 6).count();
        assert_eq!(selection.used.cpu, charged as f64);
    }

    #[test]
    fn entities_share_one_refinement_order() {
        // Two images side by side, one with a level fewer: its coarsest level
        // is half as coarse, its samples span fewer pixels, and under a budget
        // for one refinement the other image takes it.
        let deep = image(2048);
        let shallow = &deep[..4];
        let view = slice_at(0.2, [2048.0, 1024.0]);
        let refined_by = |budget: f64| -> BTreeSet<u32> {
            let entities = [entity(&view, &deep), placed(&view, shallow, [2048.0, 0.0])];
            select(&entities, cells_budget(budget))
                .refined
                .iter()
                .map(|c| c.entity)
                .collect()
        };
        assert_eq!(refined_by(1.0), [0].into());
        assert_eq!(refined_by(1e9), [0, 1].into());
    }

    #[test]
    fn the_coarser_lookahead_is_the_level_above_the_finest() {
        let levels = image(2048);
        let view = slice_view(0.6);
        let selection = select_levels(
            &[entity(&view, &levels)],
            cells_budget(1e9),
            1.0,
            &PreviousSelection::default(),
            Lookahead::Coarser,
            None,
        );
        assert_eq!(levels_of(&selection), [0].into());
        assert!(!selection.lookahead.is_empty());
        assert!(selection.lookahead.iter().all(|c| c.cell.level == 1));
    }

    #[test]
    fn the_finer_lookahead_continues_the_refinement() {
        let view = volume_view(Arcball::new([800, 600]), 512);
        let levels = cube_pyramid(512, 32, 5);
        let selection = select_levels(
            &[entity(&view, &levels)],
            cells_budget(1000.0),
            0.5,
            &PreviousSelection::default(),
            Lookahead::Finer,
            None,
        );
        assert!(!selection.lookahead.is_empty());
        let finest = selection.cells.iter().map(|c| c.cell.level).min().unwrap();
        assert!(
            selection
                .lookahead
                .iter()
                .all(|c| c.cell.level + 1 >= finest)
        );
    }

    #[test]
    fn a_batch_reads_and_writes_the_flat_layout() {
        let levels = cube_pyramid(512, 64, 4);
        let view = volume_view(Arcball::new([800, 600]), 512);
        let mut entities = vec![0.0, 0.0, 0.0, 3.0, -1.0, RENDER_RADIUS_DISABLED, 4.0];
        for (index, level) in levels.iter().enumerate() {
            let xyz = |d: [u64; 5]| [d[4] as f64, d[3] as f64, d[2] as f64];
            entities.extend(xyz(level.shape));
            entities.extend(xyz(level.chunk_shape));
            entities.extend(xyz(level.grid_shape));
            entities.extend([1.0, 1.0, if index < 3 { 1.0 } else { 0.0 }]);
        }
        let budget = cells_budget(120.0);
        let out = select_batch(
            std::slice::from_ref(&view),
            &entities,
            &[],
            budget,
            0.8,
            Lookahead::None,
            Some(KEEP),
        );
        let direct = select_levels(
            &[entity(&view, &levels)],
            budget,
            0.8,
            &PreviousSelection::default(),
            Lookahead::None,
            Some(KEEP),
        );
        assert!(!direct.ancestors.is_empty());
        let fetched = direct.cells.len() + direct.ancestors.len();
        assert_eq!(out[0] as usize, fetched);
        assert_eq!(out[2] as usize, direct.refined.len());
        assert_eq!(out[3], direct.used.cpu);
        assert_eq!(out[10], direct.ancestors_used.cpu);
        assert_eq!(out[11], direct.ancestors_used.gpu);

        // The selected cells and their ancestors in one fetch order, each
        // marked for which it is.
        let cell_of = |numbers: &[f64; CELL_STRIDE]| Cell {
            entity: numbers[0] as u32,
            level: numbers[1] as u32,
            x: numbers[2] as u32,
            y: numbers[3] as u32,
            z: numbers[4] as u32,
        };
        let rows = out[SELECTION_HEADER..SELECTION_HEADER + fetched * CELL_STRIDE]
            .as_chunks::<CELL_STRIDE>()
            .0;
        let marked = |flag: f64| -> BTreeSet<Cell> {
            rows.iter().filter(|n| n[7] == flag).map(cell_of).collect()
        };
        assert_eq!(marked(0.0), set(&direct));
        assert_eq!(
            marked(1.0),
            direct.ancestors.iter().map(|c| c.cell).collect()
        );
        assert!(rows.windows(2).all(|w| w[0][1] >= w[1][1]));

        // Fed back as the previous selection, it selects the same again.
        let mut previous = Vec::new();
        for numbers in rows {
            previous.extend_from_slice(&numbers[..5]);
            previous.push(if numbers[7] > 0.0 { 2.0 } else { 0.0 });
        }
        let refined = &out[SELECTION_HEADER + (fetched + out[1] as usize) * CELL_STRIDE..];
        for numbers in refined.as_chunks::<CELL_STRIDE>().0 {
            previous.extend_from_slice(&numbers[..5]);
            previous.push(1.0);
        }
        let again = select_batch(
            &[view],
            &entities,
            &previous,
            budget,
            0.8,
            Lookahead::None,
            Some(KEEP),
        );
        let end = SELECTION_HEADER + fetched * CELL_STRIDE;
        assert_eq!(again[..5], out[..5]);
        assert_eq!(again[SELECTION_HEADER..end], out[SELECTION_HEADER..end]);
    }

    /// Ancestors for frames at a quarter of the resolution, with all of the
    /// budget for the selected cells and their ancestors together.
    const KEEP: Ancestors = Ancestors {
        scale: 0.25,
        share: 1.0,
    };

    fn select_keeping(entities: &[SelectionEntity], budget: Cost, share: f64) -> LevelSelection {
        select_levels(
            entities,
            budget,
            share,
            &PreviousSelection::default(),
            Lookahead::None,
            Some(KEEP),
        )
    }

    /// The cells of `level` over `cell`, by their boxes.
    fn covering(levels: &[LevelGeometry], cell: Cell, level: u32) -> Vec<Cell> {
        let (lo, hi) = cell_box(levels, cell);
        let grid = levels[level as usize].grid_shape;
        let mut out = Vec::new();
        for z in 0..grid[2] as u32 {
            for y in 0..grid[3] as u32 {
                for x in 0..grid[4] as u32 {
                    let over = Cell {
                        entity: cell.entity,
                        level,
                        z,
                        y,
                        x,
                    };
                    let (olo, ohi) = cell_box(levels, over);
                    if (0..3).all(|a| olo[a] < hi[a] && lo[a] < ohi[a]) {
                        out.push(over);
                    }
                }
            }
        }
        out
    }

    /// Every cell over a selected cell at a level below `coarse` whose
    /// samples a quarter-resolution frame would put under one of its pixels
    /// there: the ancestors the rule keeps, with no previous selection.
    fn sampled_ancestors(
        levels: &[LevelGeometry],
        selection: &LevelSelection,
        coarse: u32,
        axes: &[usize],
    ) -> BTreeSet<Cell> {
        let ratios = level_shape_ratios(levels, axes);
        let mut out = BTreeSet::new();
        for selected in &selection.cells {
            let cell = selected.cell;
            for level in cell.level + 1..coarse {
                let span =
                    selected.measure * 0.25 * ratios[level as usize] / ratios[cell.level as usize];
                if span > 1.0 {
                    break;
                }
                out.extend(covering(levels, cell, level));
            }
        }
        out
    }

    fn count(cells: &[SelectedCell], coarse: u32) -> f64 {
        cells.iter().filter(|c| c.cell.level != coarse).count() as f64
    }

    #[test]
    fn each_selected_cell_keeps_the_ancestors_a_quarter_resolution_frame_would_sample() {
        let view = volume_view(Arcball::new([800, 600]), 512);
        let levels = cube_pyramid(512, 32, 5);
        for budget in [300.0, 1500.0, 4000.0] {
            let selection = select_keeping(&[entity(&view, &levels)], cells_budget(budget), 0.8);
            let held: BTreeSet<Cell> = selection.ancestors.iter().map(|c| c.cell).collect();
            // Level 4 is the coarse tier's, under every cell already.
            assert_eq!(
                held,
                sampled_ancestors(&levels, &selection, 4, &VOLUME_AXES),
                "at {budget}"
            );
            assert!(held.is_disjoint(&set(&selection)));
            let refined: BTreeSet<Cell> = selection.refined.iter().copied().collect();
            assert!(held.is_subset(&refined));
        }
    }

    #[test]
    fn a_view_zoomed_past_a_pixel_keeps_only_the_levels_its_frames_sample() {
        // Level 0 at 1.8 pixels a sample: a quarter-resolution frame puts a
        // level 1 sample under 0.9 of its pixels, and a level 2 sample under
        // 1.8. At 5 pixels it samples no coarser level at all.
        let levels = image(2048);
        let near = select_keeping(&[entity(&slice_view(1.8), &levels)], cells_budget(1e9), 1.0);
        assert_eq!(levels_of(&near), [0].into());
        assert!(!near.ancestors.is_empty());
        assert!(near.ancestors.iter().all(|c| c.cell.level == 1));

        let view = slice_view(5.0);
        let nearer = select_keeping(&[entity(&view, &levels)], cells_budget(1e9), 1.0);
        assert!(nearer.ancestors.is_empty());
        assert_eq!(nearer, select(&[entity(&view, &levels)], cells_budget(1e9)));
    }

    #[test]
    fn the_selected_cells_stay_within_their_share_and_with_their_ancestors_within_theirs() {
        let view = volume_view(Arcball::new([800, 600]), 512);
        let levels = cube_pyramid(512, 32, 5);
        let ancestors = Ancestors {
            scale: 0.25,
            share: 0.9,
        };
        for cells in [0.0, 1.0, 10.0, 100.0, 333.0, 1000.0, 4000.0] {
            let selection = select_levels(
                &[entity(&view, &levels)],
                cells_budget(cells),
                0.8,
                &PreviousSelection::default(),
                Lookahead::None,
                Some(ancestors),
            );
            assert_eq!(selection.used.cpu, count(&selection.cells, 4), "{cells}");
            assert_eq!(
                selection.ancestors_used.cpu,
                count(&selection.ancestors, 4),
                "{cells}"
            );
            assert!(selection.used.cpu <= cells * 0.8, "{cells}");
            assert!(
                selection.used.cpu + selection.ancestors_used.cpu <= cells * 0.9,
                "{cells}"
            );
        }
    }

    #[test]
    fn the_ancestors_take_room_from_what_the_share_leaves() {
        let view = volume_view(Arcball::new([800, 600]), 512);
        let levels = cube_pyramid(512, 32, 5);
        let run = |ancestors: Option<Ancestors>| {
            select_levels(
                &[entity(&view, &levels)],
                cells_budget(1500.0),
                0.8,
                &PreviousSelection::default(),
                Lookahead::None,
                ancestors,
            )
        };
        let without = run(None);
        assert!(without.limit.is_some());
        // Room past the share for them: the selection is what it was.
        let beside = run(Some(KEEP));
        assert!(!beside.ancestors.is_empty());
        assert_eq!(set(&beside), set(&without));
        assert_eq!(beside.used, without.used);
        // None past it: they come out of what the selection draws.
        let inside = run(Some(Ancestors {
            scale: 0.25,
            share: 0.8,
        }));
        assert!(count(&inside.cells, 4) < count(&without.cells, 4));
        assert!(inside.used.cpu + inside.ancestors_used.cpu <= 1200.0);
    }

    #[test]
    fn ancestors_stay_within_the_levels_the_renderer_binds() {
        // The selection's levels run from 0 to 3, and a level 2 or 3 cell's
        // ancestors at levels 4 and 5 could not be bound.
        let levels = cube_pyramid(4096, 64, 7);
        let view = volume_view(head_on(0.51, [100, 75]), 4096);
        let selection = select_keeping(&[entity(&view, &levels)], cells_budget(1e9), 1.0);
        let finest = selection.cells.iter().map(|c| c.cell.level).min().unwrap();
        assert_eq!(finest, 0);
        assert!(levels_of(&selection).contains(&3));
        assert!(!selection.ancestors.is_empty());
        assert!(
            selection
                .ancestors
                .iter()
                .all(|c| c.cell.level < finest + MAX_LEVEL_SOURCES)
        );
        assert_eq!(selection.ancestors_used.cpu, count(&selection.ancestors, 6));
    }

    #[test]
    fn a_refinement_keeps_the_cell_it_refines_while_a_child_samples_it() {
        // Level 2 at 0.8 pixels a sample: a quarter-resolution frame samples
        // level 3 over each, and level 4 is the coarse tier's.
        let levels = image(2048);
        let view = slice_at(0.2, [128.0, 128.0]);
        let without = select(&[entity(&view, &levels)], cells_budget(1e9));
        let with = select_keeping(&[entity(&view, &levels)], cells_budget(1e9), 1.0);
        assert_eq!(set(&with), set(&without));
        assert_eq!(with.used, without.used);
        assert!(with.ancestors.iter().all(|c| c.cell.level == 3));
        assert!(!with.ancestors.is_empty());
        assert_eq!(with.ancestors_used.cpu, with.ancestors.len() as f64);
    }

    #[test]
    fn grids_that_do_not_nest_keep_every_cell_over_a_selected_one_a_frame_samples() {
        let levels = vec![
            geo(0, [1, 192, 192], [1, 48, 48]),
            geo(1, [1, 96, 96], [1, 32, 32]),
            geo(2, [1, 48, 48], [1, 16, 16]),
            geo(3, [1, 24, 24], [1, 24, 24]),
        ];
        let view = slice_at(1.5, [96.0, 96.0]);
        for cells in [3.0, 9.0, 20.0, 40.0, 1e9] {
            let selection = select_keeping(&[entity(&view, &levels)], cells_budget(cells), 1.0);
            assert_eq!(selection.used.cpu, count(&selection.cells, 3), "{cells}");
            assert_eq!(
                selection.ancestors_used.cpu,
                count(&selection.ancestors, 3),
                "{cells}"
            );
            assert!(selection.used.cpu + selection.ancestors_used.cpu <= cells);
            let kept: BTreeSet<Cell> = selection
                .cells
                .iter()
                .chain(&selection.ancestors)
                .map(|c| c.cell)
                .collect();
            for over in sampled_ancestors(&levels, &selection, 3, &IN_PLANE_AXES) {
                assert!(kept.contains(&over), "{over:?} with {cells}");
            }
        }
    }

    #[test]
    fn an_ancestor_kept_last_time_stays_until_its_span_passes_the_band() {
        // Level 0 at 1.9 pixels a sample keeps level 1 above it, a level 1
        // sample spanning 0.95 of a quarter-resolution frame's pixels. At
        // 2.1 that is 1.05: a fresh selection drops it and one that kept it
        // keeps it. At 2.5 it is 1.25, past the band, and both drop it.
        let levels = image(2048);
        let at = |pixels: f64, previous: &PreviousSelection| {
            select_levels(
                &[entity(&slice_view(pixels), &levels)],
                cells_budget(1e9),
                1.0,
                previous,
                Lookahead::None,
                Some(KEEP),
            )
        };
        let before = at(1.9, &PreviousSelection::default());
        assert!(!before.ancestors.is_empty());
        let fresh = PreviousSelection::default();
        assert!(at(2.1, &fresh).ancestors.is_empty());
        assert!(!at(2.1, &previous(&before)).ancestors.is_empty());
        assert!(at(2.5, &previous(&before)).ancestors.is_empty());
    }

    #[test]
    fn the_coarser_lookahead_leaves_out_the_ancestors() {
        let levels = image(2048);
        let view = slice_view(0.6);
        let selection = select_levels(
            &[entity(&view, &levels)],
            cells_budget(1e9),
            1.0,
            &PreviousSelection::default(),
            Lookahead::Coarser,
            Some(KEEP),
        );
        assert!(!selection.ancestors.is_empty());
        assert!(selection.lookahead.is_empty());
    }
}
