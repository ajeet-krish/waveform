//! In-memory login throttling.
//!
//! One window per normalized email (`trim` then lowercase): at most 10
//! failed attempts per 15 minutes. A successful login clears the window,
//! and signup consults the same limiter to blunt account-spam runs. The
//! map is process-local by design (ADR 2026-10-15, bucket 2): restarts
//! reset the counters, which is an accepted trade-off for a friend-group
//! deployment without a shared cache.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Failed attempts allowed inside one window before the key locks.
const MAX_FAILURES: usize = 10;
/// Fixed window length.
const WINDOW: Duration = Duration::from_secs(15 * 60);
/// Prune threshold: once the map grows past this many keys, expired
/// windows are dropped on the next write so the map cannot grow without
/// bound under an email-spraying attacker.
const PRUNE_THRESHOLD: usize = 10_000;

/// Failure counts per normalized email, guarded by a std mutex (the
/// critical sections are tiny and never span an `.await`).
#[derive(Clone, Default)]
pub struct LoginLimiter {
    windows: Arc<Mutex<HashMap<String, Window>>>,
}

/// One key's failure state inside the fixed window.
#[derive(Debug, Clone, Copy)]
struct Window {
    failures: usize,
    /// When the current run of failures started; the window rolls over
    /// once it is older than [`WINDOW`].
    opened_at: Instant,
}

impl LoginLimiter {
    /// An empty limiter.
    pub fn new() -> Self {
        Self::default()
    }

    /// True when the key has burned its failed attempts for this window.
    /// Callers check before doing any password work.
    pub fn is_limited(&self, key: &str) -> bool {
        let normalized = normalize(key);
        let Ok(windows) = self.windows.lock() else {
            // A poisoned lock means a panic while holding it; failing
            // open keeps logins available and the state is in-memory
            // anyway.
            return false;
        };
        windows.get(&normalized).is_some_and(|window| {
            window.failures >= MAX_FAILURES && window.opened_at.elapsed() < WINDOW
        })
    }

    /// Count one failed attempt for the key.
    pub fn record_failure(&self, key: &str) {
        let normalized = normalize(key);
        let Ok(mut windows) = self.windows.lock() else {
            return;
        };
        if windows.len() > PRUNE_THRESHOLD {
            let now = Instant::now();
            windows.retain(|_, window| now.duration_since(window.opened_at) < WINDOW);
        }
        let now = Instant::now();
        let window = windows.entry(normalized).or_insert(Window {
            failures: 0,
            opened_at: now,
        });
        if now.duration_since(window.opened_at) >= WINDOW {
            window.failures = 0;
            window.opened_at = now;
        }
        window.failures += 1;
    }

    /// Drop the key after a successful login or signup.
    pub fn clear(&self, key: &str) {
        let normalized = normalize(key);
        if let Ok(mut windows) = self.windows.lock() {
            windows.remove(&normalized);
        }
    }
}

/// The limiter key: case- and whitespace-insensitive email form.
fn normalize(key: &str) -> String {
    key.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::LoginLimiter;

    const EMAIL: &str = "Throttle@Example.test";

    #[test]
    fn eleven_failures_lock_the_key() {
        let limiter = LoginLimiter::new();
        for _ in 0..10 {
            assert!(!limiter.is_limited(EMAIL), "10 failures must still pass");
            limiter.record_failure(EMAIL);
        }
        assert!(
            limiter.is_limited(EMAIL),
            "the 11th attempt must be limited"
        );
    }

    #[test]
    fn success_clears_the_window() {
        let limiter = LoginLimiter::new();
        for _ in 0..10 {
            limiter.record_failure(EMAIL);
        }
        assert!(limiter.is_limited(EMAIL));
        limiter.clear(EMAIL);
        assert!(!limiter.is_limited(EMAIL));
    }

    #[test]
    fn keys_normalize_case_and_whitespace() {
        let limiter = LoginLimiter::new();
        for _ in 0..10 {
            limiter.record_failure("  THROTTLE@example.TEST ");
        }
        assert!(limiter.is_limited(EMAIL));
        assert!(limiter.is_limited("throttle@example.test"));
        limiter.clear("Throttle@Example.test");
        assert!(!limiter.is_limited(EMAIL));
    }

    #[test]
    fn windows_are_independent_per_email() {
        let limiter = LoginLimiter::new();
        for _ in 0..10 {
            limiter.record_failure("one@example.test");
        }
        assert!(limiter.is_limited("one@example.test"));
        assert!(!limiter.is_limited("two@example.test"));
    }
}
