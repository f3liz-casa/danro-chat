const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function signToken(secret: string, visitorId: string, ttlMs = TTL_MS): Promise<string> {
  const payload = { v: visitorId, e: Date.now() + ttlMs };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await importKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes));
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(sig)}`;
}

export async function verifyToken(secret: string, token: string): Promise<string | null> {
  const [payloadPart, sigPart] = token.split(".");
  if (!payloadPart || !sigPart) return null;
  let payloadBytes: Uint8Array;
  let sig: Uint8Array;
  try {
    payloadBytes = b64urlDecode(payloadPart);
    sig = b64urlDecode(sigPart);
  } catch {
    return null;
  }
  const key = await importKey(secret);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes as BufferSource));
  if (!timingSafeEqual(sig, expected)) return null;
  let payload: { v?: unknown; e?: unknown };
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof payload.v !== "string" || typeof payload.e !== "number") return null;
  if (Date.now() > payload.e) return null;
  return payload.v;
}
