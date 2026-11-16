// Розшифрування сегментів HLS з методом AES-128 (CBC, PKCS#7).
// Це стандартне шифрування потоку, ключ до якого віддає сам сайт.
// DRM-захист (SAMPLE-AES, Widevine, FairPlay) не підтримується.

export async function importKey(rawKey) {
  if (rawKey.byteLength !== 16) throw new Error("bad-key-length");
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["decrypt"]);
}

export async function decryptSegment(cryptoKey, iv, data) {
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, data);
  return new Uint8Array(plain);
}
