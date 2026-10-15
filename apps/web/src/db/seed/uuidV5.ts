/**
 * RFC 4122 UUIDv5 for catalog seed rows, built on Web Crypto only.
 *
 * The catalog migration generates ids server-side with gen_random_uuid();
 * locally we derive a stable id per exercise name so re-seeding a wiped
 * device lands on the same ids deterministically.
 */

/**
 * Fixed namespace UUID: the RFC 4122 well-known DNS namespace
 * (6ba7b810-9dad-11d1-80b4-00c04fd430c8).
 */
const NAMESPACE_UUID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const encoder = new TextEncoder();

function namespaceBytes(): Uint8Array {
  const hex = NAMESPACE_UUID.split("-").join("");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function formatUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (const byte of bytes) {
    hex.push(byte.toString(16).padStart(2, "0"));
  }
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

/**
 * Deterministic catalog id for an exercise name.
 *
 * The name is lowercased first, mirroring the SQL `lower(name)` unique key
 * on catalog rows, so "Bench Press" and "bench press" yield one id.
 */
export async function catalogSeedId(name: string): Promise<string> {
  const normalized = name.toLowerCase();
  const namespace = namespaceBytes();
  const label = encoder.encode(normalized);
  const input = new Uint8Array(namespace.length + label.length);
  input.set(namespace, 0);
  input.set(label, namespace.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const uuid = digest.slice(0, 16);
  const version = uuid[6] ?? 0;
  const variant = uuid[8] ?? 0;
  uuid[6] = (version & 0x0f) | 0x50; // version 5 (name-based, SHA-1)
  uuid[8] = (variant & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(uuid);
}
