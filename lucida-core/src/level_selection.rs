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
//! It reads the camera, the level geometry, the budget and the previous
//! selection, and nothing else, so every client gets the same selection for
//! the same inputs.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};

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

/// A selected cell and its measure: the device pixels one of its samples
/// spans where it is nearest the eye.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SelectedCell {
    pub cell: Cell,
    pub measure: f64,
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
    pub kept: HashSet<Cell>,
    /// Cells it replaced with finer ones.
    pub refined: HashSet<Cell>,
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
    /// The selected cells, in fetch order: coarser levels first, so a slow
    /// link fills the whole view before it sharpens, then larger measure.
    pub cells: Vec<SelectedCell>,
    /// Cells beyond the selection worth fetching ahead, in order, which fit
    /// the room the selection leaves.
    pub lookahead: Vec<SelectedCell>,
    /// Cells the selection replaced with finer ones, for the next selection
    /// to lean toward.
    pub refined: Vec<Cell>,
    /// What the selected cells cost the detail budget.
    pub used: Cost,
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
    /// Selected cells and their measures.
    selected: HashMap<Cell, f64>,
    refined: HashSet<Cell>,
    /// Per entity, how many charged cells each detail level holds, which
    /// keeps the levels within the renderer's sources.
    detail_levels: Vec<BTreeMap<u32, usize>>,
    heap: BinaryHeap<Candidate>,
    used: Cost,
    counts: CullCounts,
    found: Vec<ScoredChunk>,
}

impl<'s, 'a> Refiner<'s, 'a> {
    fn new(entities: &'s [SelectionEntity<'a>], previous: &'s PreviousSelection) -> Self {
        Self {
            entities,
            previous,
            selected: HashMap::new(),
            refined: HashSet::new(),
            detail_levels: vec![BTreeMap::new(); entities.len()],
            heap: BinaryHeap::new(),
            used: Cost::default(),
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

    fn select(&mut self, cell: Cell) {
        let measure = self.measure(cell);
        let entities = self.entities;
        let entity = &entities[cell.entity as usize];
        if entity.charged(cell.level) {
            self.used = self.used.add(entity.cost(cell.level));
            *self.detail_levels[cell.entity as usize]
                .entry(cell.level)
                .or_default() += 1;
        }
        self.selected.insert(cell, measure);
        self.offer(cell, measure);
    }

    fn unselect(&mut self, cell: Cell) {
        if self.selected.remove(&cell).is_none() {
            return;
        }
        let entities = self.entities;
        let entity = &entities[cell.entity as usize];
        if entity.charged(cell.level) {
            self.used = self.used.sub(entity.cost(cell.level));
            let levels = &mut self.detail_levels[cell.entity as usize];
            if let Some(count) = levels.get_mut(&cell.level) {
                *count -= 1;
                if *count == 0 {
                    levels.remove(&cell.level);
                }
            }
        }
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
            self.select(Cell {
                entity: entity_index as u32,
                level: start,
                z: found.z,
                y: found.y,
                x: found.x,
            });
        }
    }

    /// The cells of level `finer` that cover `cell` and that the view samples.
    fn children(&mut self, cell: Cell, finer: u32) -> Vec<Cell> {
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
            .map(|found| Cell {
                entity: cell.entity,
                level: finer,
                z: found.z,
                y: found.y,
                x: found.x,
            })
            .collect()
    }

    /// Refine in priority order until nothing calls for it or the next
    /// refinement would not fit `budget`. Returns the priority of the
    /// refinement the budget refused, if it refused one, and leaves it queued.
    ///
    /// With `ahead`, the cells refinements add are fetched beside the
    /// selection rather than in place of what they refine, so they are
    /// charged to its room without the refunds and collected in it.
    fn refine(&mut self, budget: Cost, mut ahead: Option<&mut Ahead>) -> Option<f64> {
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
            let beyond: Vec<u32> = levels.range(reach + 1..).map(|(&l, _)| l).collect();
            if finer > reach || (!beyond.is_empty() && !entity.start_free) {
                self.heap.pop();
                continue;
            }
            let given_up = levels
                .range(reach + 1..)
                .fold(Cost::default(), |sum, (&level, &count)| {
                    sum.add(entity.cost(level).scaled(count as f64))
                });

            let children: Vec<Cell> = self
                .children(cell, finer)
                .into_iter()
                .filter(|child| !self.selected.contains_key(child) && !self.refined.contains(child))
                .collect();
            let mut after = self
                .used
                .add(entity.cost(finer).scaled(children.len() as f64))
                .sub(given_up);
            if entity.charged(cell.level) {
                after = after.sub(entity.cost(cell.level));
            }
            let fits = match ahead.as_deref() {
                Some(ahead) => ahead
                    .spent
                    .add(entity.cost(finer).scaled(children.len() as f64))
                    .within(ahead.room),
                None => after.within(budget),
            };
            if !fits {
                return Some(top.priority);
            }

            self.heap.pop();
            self.unselect(cell);
            self.refined.insert(cell);
            if !beyond.is_empty() {
                let dropped: Vec<Cell> = self
                    .selected
                    .keys()
                    .copied()
                    .filter(|c| c.entity == cell.entity && beyond.contains(&c.level))
                    .collect();
                for cell in dropped {
                    self.unselect(cell);
                }
            }
            for child in children {
                self.select(child);
                if let Some(ahead) = ahead.as_deref_mut() {
                    ahead.spent = ahead.spent.add(entity.cost(finer));
                    ahead.cells.push(child);
                }
            }
        }
        None
    }

    /// The selected cells in fetch order.
    fn cells(&self) -> Vec<SelectedCell> {
        let mut cells: Vec<SelectedCell> = self
            .selected
            .iter()
            .map(|(&cell, &measure)| SelectedCell { cell, measure })
            .collect();
        cells.sort_by(|a, b| {
            b.cell
                .level
                .cmp(&a.cell.level)
                .then_with(|| b.measure.total_cmp(&a.measure))
                .then_with(|| a.cell.cmp(&b.cell))
        });
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
        let mut parents = HashSet::new();
        let entities = self.entities;
        for cell in sources {
            let entity = &entities[cell.entity as usize];
            let Some(coarser) = entity.coarser(cell.level) else {
                continue;
            };
            for parent in self.children(cell, coarser) {
                if !self.selected.contains_key(&parent) {
                    parents.insert(parent);
                }
            }
        }
        let mut ahead: Vec<SelectedCell> = parents
            .into_iter()
            .map(|cell| SelectedCell {
                cell,
                measure: self.measure(cell),
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
pub fn select_levels(
    entities: &[SelectionEntity],
    budget: Cost,
    share: f64,
    previous: &PreviousSelection,
    lookahead: Lookahead,
) -> LevelSelection {
    let mut refiner = Refiner::new(entities, previous);
    for index in 0..entities.len() {
        refiner.seed(index);
    }
    let limit = refiner.refine(budget.scaled(share.clamp(0.0, 1.0)), None);
    let cells = refiner.cells();
    let mut refined: Vec<Cell> = refiner.refined.iter().copied().collect();
    refined.sort_unstable();
    let used = refiner.used;
    let lookahead = match lookahead {
        Lookahead::None => Vec::new(),
        Lookahead::Finer => {
            let mut ahead = Ahead {
                cells: Vec::new(),
                spent: Cost::default(),
                room: budget.sub(used),
            };
            refiner.refine(budget, Some(&mut ahead));
            ahead
                .cells
                .into_iter()
                .filter_map(|cell| {
                    refiner
                        .selected
                        .get(&cell)
                        .map(|&measure| SelectedCell { cell, measure })
                })
                .collect()
        }
        Lookahead::Coarser => refiner.coarser_cells(budget.sub(used)),
    };
    LevelSelection {
        cells,
        lookahead,
        refined,
        used,
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

/// Numbers per cell in [`select_batch`]'s previous selection and output:
/// entity, level, X, Y, Z, and a sixth: in the previous selection 1 for a
/// cell it refined and 0 for one it kept, in the output the cell's measure.
pub const CELL_STRIDE: usize = 6;

/// Numbers at the head of [`select_batch`]'s output: how many selected,
/// lookahead and refined cells follow, in that order; the CPU and GPU bytes
/// used; the refused refinement's measure or -1; and the four
/// [`CullCounts`] in field order.
pub const SELECTION_HEADER: usize = 10;

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
        for (level, numbers) in entities[at + ENTITY_HEADER..end]
            .chunks_exact(LEVEL_STRIDE)
            .enumerate()
        {
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
    for numbers in previous.chunks_exact(CELL_STRIDE) {
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
        if numbers[5] > 0.0 {
            last.refined.insert(cell);
        } else {
            last.kept.insert(cell);
        }
    }

    let selection = select_levels(&parsed, budget, share, &last, lookahead);
    let mut out = Vec::with_capacity(
        SELECTION_HEADER
            + (selection.cells.len() + selection.lookahead.len() + selection.refined.len())
                * CELL_STRIDE,
    );
    out.extend_from_slice(&[
        selection.cells.len() as f64,
        selection.lookahead.len() as f64,
        selection.refined.len() as f64,
        selection.used.cpu,
        selection.used.gpu,
        selection.limit.unwrap_or(-1.0),
        selection.counts.considered as f64,
        selection.counts.after_xy_bounds as f64,
        selection.counts.after_z_range as f64,
        selection.counts.after_frustum as f64,
    ]);
    let mut push = |cell: Cell, last: f64| {
        out.extend_from_slice(&[
            f64::from(cell.entity),
            f64::from(cell.level),
            f64::from(cell.x),
            f64::from(cell.y),
            f64::from(cell.z),
            last,
        ]);
    };
    for cell in selection.cells.iter().chain(&selection.lookahead) {
        push(cell.cell, cell.measure);
    }
    for &cell in &selection.refined {
        push(cell, 1.0);
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
        )
    }

    fn previous(selection: &LevelSelection) -> PreviousSelection {
        PreviousSelection {
            kept: selection.cells.iter().map(|c| c.cell).collect(),
            refined: selection.refined.iter().copied().collect(),
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
        );
        assert_eq!(levels_of(&held), [1].into());
        let past = select_levels(
            &[entity(&slice_view(0.62), &levels)],
            cells_budget(1e9),
            1.0,
            &previous(&before),
            Lookahead::None,
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
        );
        let direct = select_levels(
            &[entity(&view, &levels)],
            budget,
            0.8,
            &PreviousSelection::default(),
            Lookahead::None,
        );
        assert_eq!(out[0] as usize, direct.cells.len());
        assert_eq!(out[2] as usize, direct.refined.len());
        assert_eq!(out[3], direct.used.cpu);
        let cell = direct.cells[0];
        assert_eq!(
            out[SELECTION_HEADER..SELECTION_HEADER + CELL_STRIDE],
            [
                0.0,
                f64::from(cell.cell.level),
                f64::from(cell.cell.x),
                f64::from(cell.cell.y),
                f64::from(cell.cell.z),
                cell.measure,
            ]
        );

        // Fed back as the previous selection, it selects the same again.
        let mut previous = Vec::new();
        let cells = &out[SELECTION_HEADER..];
        for (index, numbers) in cells.chunks_exact(CELL_STRIDE).enumerate() {
            previous.extend_from_slice(&numbers[..5]);
            previous.push(if index < direct.cells.len() { 0.0 } else { 1.0 });
        }
        let again = select_batch(&[view], &entities, &previous, budget, 0.8, Lookahead::None);
        let selected = SELECTION_HEADER + direct.cells.len() * CELL_STRIDE;
        assert_eq!(again[..5], out[..5]);
        assert_eq!(
            again[SELECTION_HEADER..selected],
            out[SELECTION_HEADER..selected]
        );
    }
}
