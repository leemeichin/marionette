/**
 * SHA-256 via WebCrypto (globalThis.crypto.subtle) — the same code path on
 * Node ≥ 20 and in browsers, which is what lets the compiler run unmodified
 * in both. Async because subtle is; there is no sync platform hash in the
 * browser, and we choose one implementation over two.
 */

export async function sha256Hex(data: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
