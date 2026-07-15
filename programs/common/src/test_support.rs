//! Test-only helpers shared across `common`'s unit tests. Compiled only under
//! `#[cfg(test)]`, so nothing here ships in a normal build.

/// Parses `source` (a module's own text, passed via `include_str!` so it can't
/// drift from reality) and asserts every `pub const <NAME>: u16 = N;` line has
/// `N` equal to its 0-based declaration position. Catches gaps, duplicates, and
/// out-of-order values — the only valid way to add a constant is to append it at
/// the end with the next number.
///
/// `kind` names the constant family (e.g. `"functionality"`, `"role"`) and is
/// only used to make the assertion messages readable.
pub fn assert_u16_constants_sequential_from_zero(source: &str, kind: &str) {
    let mut values: Vec<u16> = Vec::new();

    for line in source.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("pub const ") else {
            continue;
        };
        let Some((name_and_type, value_part)) = rest.split_once('=') else {
            continue;
        };
        if !name_and_type.contains(": u16") {
            continue;
        }
        let value_str = value_part.trim().trim_end_matches(';');
        let value: u16 = value_str
            .parse()
            .unwrap_or_else(|_| panic!("expected an integer literal, found `{value_str}`"));
        values.push(value);
    }

    assert!(!values.is_empty(), "expected at least one {kind} constant");
    for (i, &value) in values.iter().enumerate() {
        assert_eq!(
            value, i as u16,
            "{kind} constants must be sequential starting at 0, in declaration order"
        );
    }
}
