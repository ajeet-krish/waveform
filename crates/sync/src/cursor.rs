//! Opaque pull cursors: the `(applied_at, id)` pair of the last row a
//! client received, encoded as `{unix_micros}-{uuid}`.
//!
//! Cursors are opaque to clients: they only echo them back from
//! `GET /sync/pull`. The encoding uses microsecond precision because that
//! is Postgres `timestamptz` resolution, so a decoded cursor compares
//! equal to the stored `applied_at` and the next page stays exclusive.
//! The UUID tail carries the id tie-break, so rows that share one server
//! `applied_at` are never dropped across a page boundary.

use chrono::{DateTime, Utc};
use uuid::Uuid;

/// The `(applied_at, id)` position of a pull cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    /// Server-stamped `applied_at` of the last row the client received.
    pub applied_at: DateTime<Utc>,
    /// Primary key of that row; breaks ties within one `applied_at`.
    pub id: Uuid,
}

/// Why a cursor string could not be decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CursorError {
    /// Too short to hold `{micros}-{uuid}` or a missing separator.
    Malformed,
    /// The microsecond prefix is not an integer.
    BadTimestamp,
    /// The microsecond prefix is outside the representable range.
    TimestampOutOfRange,
    /// The UUID tail failed to parse.
    BadId,
}

impl std::fmt::Display for CursorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CursorError::Malformed => write!(f, "cursor must be '{{unix_micros}}-{{uuid}}'"),
            CursorError::BadTimestamp => write!(f, "cursor timestamp is not an integer of micros"),
            CursorError::TimestampOutOfRange => {
                write!(f, "cursor timestamp is out of range")
            }
            CursorError::BadId => write!(f, "cursor id is not a uuid"),
        }
    }
}

impl std::error::Error for CursorError {}

/// Encode a cursor as `{unix_micros}-{uuid}`.
///
/// `unix_micros` is UTC microseconds since the Unix epoch, which matches
/// the resolution Postgres stores in `timestamptz`.
pub fn encode_cursor(cursor: &Cursor) -> String {
    format!("{}-{}", cursor.applied_at.timestamp_micros(), cursor.id)
}

/// Decode the `{unix_micros}-{uuid}` encoding produced by
/// [`encode_cursor`]. Any other shape is a [`CursorError`]; garbage input
/// never panics.
pub fn decode_cursor(raw: &str) -> Result<Cursor, CursorError> {
    // The UUID tail is always 36 chars, so split from the right and this
    // also accepts (and rejects) a negative microsecond prefix.
    if raw.len() < 37 {
        return Err(CursorError::Malformed);
    }
    let split = raw.len() - 36;
    let (head, tail) = raw.split_at(split);
    let micros = head.strip_suffix('-').ok_or(CursorError::Malformed)?;
    let micros: i64 = micros.parse().map_err(|_| CursorError::BadTimestamp)?;
    let id = Uuid::parse_str(tail).map_err(|_| CursorError::BadId)?;
    let applied_at =
        DateTime::from_timestamp_micros(micros).ok_or(CursorError::TimestampOutOfRange)?;
    Ok(Cursor { applied_at, id })
}

#[cfg(test)]
mod tests {
    use super::{decode_cursor, encode_cursor, Cursor, CursorError};
    use chrono::{DateTime, Duration, TimeZone, Utc};
    use uuid::Uuid;

    fn micros(value: i64) -> Cursor {
        Cursor {
            applied_at: DateTime::from_timestamp_micros(value).expect("in range"),
            id: Uuid::nil(),
        }
    }

    #[test]
    fn roundtrips_arbitrary_micros() {
        for value in [
            0_i64,
            1,
            999_999,
            1_760_000_000_000_000,
            i64::from(i32::MAX) * 1_000_000,
        ] {
            let cursor = micros(value);
            let encoded = encode_cursor(&cursor);
            assert_eq!(
                encoded,
                format!("{value}-00000000-0000-0000-0000-000000000000")
            );
            assert_eq!(decode_cursor(&encoded).expect("roundtrip"), cursor);
        }
    }

    #[test]
    fn microsecond_edges_stay_distinct() {
        // Postgres timestamptz resolves microseconds; a cursor one
        // microsecond earlier must decode to a different position so the
        // next page stays exclusive at the boundary.
        let base = Utc.with_ymd_and_hms(2026, 10, 15, 12, 0, 0).unwrap();
        let at = Cursor {
            applied_at: base,
            id: Uuid::from_u128(7),
        };
        let one_micro_later = Cursor {
            applied_at: base + Duration::microseconds(1),
            id: Uuid::from_u128(7),
        };
        let decoded = decode_cursor(&encode_cursor(&at)).expect("decode");
        assert_eq!(decoded, at);
        assert_ne!(decoded.applied_at, one_micro_later.applied_at);
        assert_eq!(
            decoded.applied_at.timestamp_micros() + 1,
            one_micro_later.applied_at.timestamp_micros()
        );
        // The highest microsecond of a second and the next second's zero.
        let boundary = decode_cursor(&encode_cursor(&micros(1_791_999_999_999_999))).expect("b");
        assert_eq!(
            boundary.applied_at.timestamp_micros(),
            1_791_999_999_999_999
        );
    }

    #[test]
    fn keeps_the_uuid_intact_through_the_encoding() {
        let id = Uuid::from_u128(0xdead_beef_cafe);
        let cursor = Cursor {
            applied_at: micros(42).applied_at,
            id,
        };
        let decoded = decode_cursor(&encode_cursor(&cursor)).expect("decode");
        assert_eq!(decoded.id, id);
        assert_eq!(decoded.applied_at.timestamp_micros(), 42);
    }

    #[test]
    fn garbage_input_is_an_error_never_a_panic() {
        for bad in [
            "",
            "-",
            "not-a-cursor",
            "12345",
            "abc-00000000-0000-0000-0000-000000000000",
            "12345-not-a-uuid-at-all-just-padding-text!!",
            "12345-00000000-0000-0000-0000-00000000000g",
            "-00000000-0000-0000-0000-000000000000",
            "9999999999999999999999-00000000-0000-0000-0000-000000000000",
            "12345-extra-tail-00000000-0000-0000-0000-000000000000",
            "12345.5-00000000-0000-0000-0000-000000000000",
        ] {
            assert!(decode_cursor(bad).is_err(), "expected error for {bad:?}");
        }
    }

    #[test]
    fn cursor_error_messages_are_stable() {
        assert_eq!(
            decode_cursor("nope").expect_err("must fail"),
            CursorError::Malformed
        );
        assert_eq!(
            decode_cursor("abc-00000000-0000-0000-0000-000000000000").expect_err("must fail"),
            CursorError::BadTimestamp
        );
        assert_eq!(
            decode_cursor("1-00000000-0000-0000-0000-00000000000z").expect_err("must fail"),
            CursorError::BadId
        );
    }
}
