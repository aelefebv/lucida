//! What a collection's metadata gets wrong about its own layout.
//!
//! The format names every row and column, gives every group a row and column
//! index, and lists every group's tiles. A writer can leave any of those out,
//! or list one thing twice. Import still lays the collection out, and each
//! guess it makes is described here so it reaches the user.

use std::collections::HashMap;

use crate::import::GroupParsed;
use crate::import_types::{ImportWarning, ImportWarningKind};

/// Problems named in one aggregated warning before the rest are counted.
const PROBLEM_EXAMPLES: usize = 5;

/// One label per row or column entry. An entry without a name is labelled
/// by its index rather than dropped, which would shift every later label.
pub(crate) fn axis_labels(
    entries: Option<&serde_json::Value>,
    axis: &str,
    problems: &mut Vec<String>,
) -> Vec<String> {
    let Some(entries) = entries.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            match entry
                .get("name")
                .and_then(|n| n.as_str())
                .filter(|n| !n.is_empty())
            {
                Some(name) => name.to_string(),
                None => {
                    problems.push(format!(
                        "{axis} entry {index} has no name and is labelled \"{index}\""
                    ));
                    index.to_string()
                }
            }
        })
        .collect()
}

/// One of a group's two grid axes.
#[derive(Clone, Copy)]
pub(crate) enum GroupAxis {
    Row,
    Column,
}

impl GroupAxis {
    fn key(self) -> &'static str {
        match self {
            Self::Row => "rowIndex",
            Self::Column => "columnIndex",
        }
    }

    fn noun(self) -> &'static str {
        match self {
            Self::Row => "row",
            Self::Column => "column",
        }
    }

    /// Which segment of a group's path names its place on this axis.
    fn path_segment(self) -> usize {
        match self {
            Self::Row => 0,
            Self::Column => 1,
        }
    }
}

/// A group entry's index on one axis. A missing index is recovered from the
/// path segment that names the row or column, else taken as 0, and either
/// way the guess is described. A group without a path is skipped with its
/// own warning, so its guess goes undescribed.
pub(crate) fn group_index(
    entry: &serde_json::Value,
    axis: GroupAxis,
    group_path: Option<&str>,
    labels: &[String],
    problems: &mut Vec<String>,
) -> u32 {
    if let Some(index) = entry
        .get(axis.key())
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
    {
        return index;
    }
    let Some(group_path) = group_path else {
        return 0;
    };
    let axis_noun = axis.noun();
    let segment = group_path.split('/').nth(axis.path_segment());
    match segment.and_then(|segment| labels.iter().position(|label| label == segment)) {
        Some(index) => {
            problems.push(format!(
                "group {group_path:?} doesn't say which {axis_noun} it is in, so its path \
                 places it in {axis_noun} {:?}",
                labels[index]
            ));
            index as u32
        }
        None => {
            problems.push(format!(
                "group {group_path:?} doesn't say which {axis_noun} it is in and is placed in \
                 the first {axis_noun}"
            ));
            0
        }
    }
}

/// Groups that land in a cell an earlier group already holds. They are drawn
/// over each other, so each is named with the group it overlaps.
pub(crate) fn shared_cells(
    groups: &[GroupParsed],
    rows: &[String],
    columns: &[String],
    problems: &mut Vec<String>,
) {
    let label = |labels: &[String], index: u32| {
        labels
            .get(index as usize)
            .cloned()
            .unwrap_or_else(|| index.to_string())
    };
    let mut holders: HashMap<(u32, u32), &str> = HashMap::new();
    for group in groups {
        let cell = (group.row_index, group.column_index);
        match holders.get(&cell) {
            Some(holder) => problems.push(format!(
                "groups {holder:?} and {:?} are both at row {:?}, column {:?} and overlap",
                group.path,
                label(rows, cell.0),
                label(columns, cell.1),
            )),
            None => {
                holders.insert(cell, &group.path);
            }
        }
    }
}

/// Tiles of one group that duplicate each other: a path listed again (shown
/// once), a tile at the explicit position of an earlier one, and a group
/// listing more tiles than the collection's `field_count` allows, which is
/// how copies of one position show when no positions are given.
pub(crate) fn duplicate_tiles(groups: &[GroupParsed], field_count: Option<u64>) -> Vec<String> {
    let mut problems = Vec::new();
    for group in groups {
        for prefix in &group.repeated_tiles {
            problems.push(format!("{prefix:?} is listed twice and is shown once"));
        }
        let mut positions: HashMap<Vec<u64>, &str> = HashMap::new();
        for tile in &group.tiles {
            let Some(translation) = &tile.translation else {
                continue;
            };
            let position = translation.iter().map(|v| v.to_bits()).collect();
            match positions.get(&position) {
                Some(first) => problems.push(format!(
                    "{:?} is at the same position as {first:?}",
                    tile.store_prefix
                )),
                None => {
                    positions.insert(position, &tile.store_prefix);
                }
            }
        }
        if let Some(field_count) = field_count
            && group.tiles.len() as u64 > field_count
        {
            problems.push(format!(
                "group {:?} lists {} tiles, but the collection allows {field_count} per group",
                group.path,
                group.tiles.len(),
            ));
        }
    }
    problems
}

/// One warning naming every problem of one kind, or none when there are
/// none. A store-wide fault repeats one problem across many groups, so the
/// message names a few and counts the rest.
pub(crate) fn aggregate(
    kind: ImportWarningKind,
    dataset_id: &str,
    lead: &str,
    problems: &[String],
) -> Option<ImportWarning> {
    if problems.is_empty() {
        return None;
    }
    let places = if problems.len() == 1 {
        "1 place".to_string()
    } else {
        format!("{} places", problems.len())
    };
    let mut named = problems
        .iter()
        .take(PROBLEM_EXAMPLES)
        .cloned()
        .collect::<Vec<_>>()
        .join("; ");
    if problems.len() > PROBLEM_EXAMPLES {
        named.push_str(&format!("; and {} more", problems.len() - PROBLEM_EXAMPLES));
    }
    Some(ImportWarning {
        kind,
        target: dataset_id.to_string(),
        message: format!("{lead} in {places}: {named}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::TileParsed;

    fn group(path: &str, row: u32, column: u32, tiles: &[(&str, Option<[f64; 2]>)]) -> GroupParsed {
        GroupParsed {
            path: path.to_string(),
            row_index: row,
            column_index: column,
            tiles: tiles
                .iter()
                .map(|(prefix, translation)| TileParsed {
                    store_prefix: prefix.to_string(),
                    translation: translation.map(|t| t.to_vec()),
                })
                .collect(),
            repeated_tiles: Vec::new(),
        }
    }

    #[test]
    fn a_nameless_entry_keeps_its_place_and_is_named() {
        let entries = serde_json::json!([{"name": "A"}, {}, {"name": "C"}]);
        let mut problems = Vec::new();

        let labels = axis_labels(Some(&entries), "row", &mut problems);

        assert_eq!(labels, ["A", "1", "C"]);
        assert_eq!(problems, ["row entry 1 has no name and is labelled \"1\""]);
    }

    #[test]
    fn a_missing_index_is_recovered_from_the_path_or_taken_as_zero() {
        let labels: Vec<String> = ["A", "B"].iter().map(|s| s.to_string()).collect();
        let entry = serde_json::json!({"path": "B/1"});
        let mut problems = Vec::new();

        let from_path = group_index(&entry, GroupAxis::Row, Some("B/1"), &labels, &mut problems);
        let unknown = group_index(&entry, GroupAxis::Row, Some("Z/1"), &labels, &mut problems);
        let unnamed = group_index(&entry, GroupAxis::Row, None, &labels, &mut problems);

        assert_eq!((from_path, unknown, unnamed), (1, 0, 0));
        assert_eq!(
            problems,
            [
                "group \"B/1\" doesn't say which row it is in, so its path places it in row \
                 \"B\"",
                "group \"Z/1\" doesn't say which row it is in and is placed in the first row",
            ]
        );
    }

    #[test]
    fn groups_in_one_cell_are_named_together() {
        let groups = [
            group("A/1", 0, 0, &[]),
            group("A/1b", 0, 0, &[]),
            group("A/2", 0, 1, &[]),
        ];
        let labels = |names: &[&str]| names.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mut problems = Vec::new();

        shared_cells(
            &groups,
            &labels(&["A"]),
            &labels(&["1", "2"]),
            &mut problems,
        );

        assert_eq!(
            problems,
            ["groups \"A/1\" and \"A/1b\" are both at row \"A\", column \"1\" and overlap"]
        );
    }

    #[test]
    fn copies_of_one_position_are_named() {
        let mut listed_twice = group("B/1", 1, 0, &[("B/1/0", None)]);
        listed_twice.repeated_tiles.push("B/1/0".to_string());
        let groups = [
            group(
                "A/1",
                0,
                0,
                &[("A/1/0", Some([0.0, 0.0])), ("A/1/1", Some([0.0, 0.0]))],
            ),
            listed_twice,
            group("C/1", 2, 0, &[("C/1/0", None), ("C/1/1", None)]),
        ];

        let problems = duplicate_tiles(&groups, Some(1));

        assert_eq!(
            problems,
            [
                "\"A/1/1\" is at the same position as \"A/1/0\"",
                "group \"A/1\" lists 2 tiles, but the collection allows 1 per group",
                "\"B/1/0\" is listed twice and is shown once",
                "group \"C/1\" lists 2 tiles, but the collection allows 1 per group",
            ]
        );
        assert!(duplicate_tiles(&groups[2..], None).is_empty());
    }

    #[test]
    fn many_problems_are_counted_past_the_examples() {
        let problems: Vec<String> = (0..7).map(|i| format!("problem {i}")).collect();

        let warning = aggregate(
            ImportWarningKind::DuplicateTile,
            "ds",
            "tiles repeat",
            &problems,
        )
        .unwrap();

        assert_eq!(warning.target, "ds");
        assert_eq!(
            warning.message,
            "tiles repeat in 7 places: problem 0; problem 1; problem 2; problem 3; problem 4; and 2 more"
        );
        assert!(aggregate(ImportWarningKind::DuplicateTile, "ds", "tiles repeat", &[]).is_none());
    }
}
