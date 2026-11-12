/**
 * Decrypt a Tooniboy Worker API response in a browser or modern JavaScript runtime.
 * The AES_KEY text must exactly match the Cloudflare Worker secret.
 * Never ship a secret embedded in a public website; use this only when the client
 * is trusted to possess the key, or proxy the API through a trusted backend.
 */
export async function decryptTooniboyResponse(envelope, aesKeyText) {
  if (!envelope || envelope.encrypted !== true || envelope.algorithm !== 'AES-128-GCM') {
    throw new TypeError('Unexpected encrypted response envelope.');
  }
  if (typeof aesKeyText !== 'string' || aesKeyText.length < 16) {
    throw new TypeError('AES_KEY must be the same secret configured in the Worker.');
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(aesKeyText));
  // SHA-256 is 32 bytes; take its first 16 bytes for AES-128.
  const keyBytes = new Uint8Array(digest).slice(0, 16);
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']
  );

  const fromBase64 = value => {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  };

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(envelope.iv), tagLength: 128 },
    key,
    fromBase64(envelope.ciphertext)
  );
  return JSON.parse(decoder.decode(plaintext));
}

// Example:
// const response = await fetch('https://YOUR-WORKER.workers.dev/api/genres');
// const payload = await decryptTooniboyResponse(await response.json(), aesKeyText);
// console.log(payload.data.genres);
