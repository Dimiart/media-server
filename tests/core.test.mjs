import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { test } from "node:test";

import { downloadPlaylist } from "../lib/downloader.js";
import { isMaster, outputExtension, parseMaster, parseMedia } from "../lib/hls-playlist.js";
import { classify, hostMatches, safeFileName, sizeFromHeaders } from "../lib/media.js";

test("classify: HLS, файли та сегменти", () => {
  assert.equal(classify("https://a.test/v/index.m3u8?t=1")?.kind, "hls");
  assert.equal(classify("https://a.test/x", "application/vnd.apple.mpegurl")?.kind, "hls");
  assert.deepEqual(classify("https://a.test/film.MP4"), { kind: "file", ext: "mp4", mime: "" });
  assert.equal(classify("https://a.test/stream", "audio/mpeg; charset=x")?.ext, "mp3");
  assert.equal(classify("https://a.test/seg1.ts", "video/mp2t"), null);
  assert.equal(classify("https://a.test/chunk.m4s"), null);
  assert.equal(classify("https://a.test/page.html", "text/html"), null);
  assert.equal(classify("blob:https://a.test/123", "video/mp4"), null);
});

test("sizeFromHeaders: повний розмір з Content-Range", () => {
  assert.equal(sizeFromHeaders([{ name: "Content-Range", value: "bytes 0-1/52428800" }]), 52428800);
  assert.equal(sizeFromHeaders([{ name: "content-length", value: "1024" }]), 1024);
  assert.equal(sizeFromHeaders([]), null);
});

test("hostMatches і safeFileName", () => {
  assert.ok(hostMatches("https://cdn.ads.test/a.mp4", ["ads.test"]));
  assert.ok(!hostMatches("https://badads.test/a.mp4", ["ads.test"]));
  assert.equal(safeFileName('Відео: "Село" / 1950?'), "Відео Село 1950");
  assert.equal(safeFileName("..."), "video");
});

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Українська",LANGUAGE="uk",DEFAULT=YES,URI="audio/uk.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
hd/index.m3u8
`;

test("parseMaster: варіанти від найкращого, звукові доріжки", () => {
  assert.ok(isMaster(MASTER));
  const { variants, audio } = parseMaster(MASTER, "https://a.test/v/master.m3u8");
  assert.equal(variants[0].url, "https://a.test/v/hd/index.m3u8");
  assert.equal(variants[0].height, 720);
  assert.equal(variants[1].audioGroup, "aud");
  assert.equal(audio[0].url, "https://a.test/v/audio/uk.m3u8");
  assert.ok(audio[0].isDefault);
});

test("parseMedia: ключі, IV з номера сегмента, діапазони, DRM", () => {
  const text = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4.0,
s7.ts
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:4.5,
s8.ts
#EXT-X-KEY:METHOD=NONE
#EXT-X-BYTERANGE:100@0
#EXTINF:2,
all.ts
#EXT-X-BYTERANGE:50
#EXTINF:2,
all.ts
#EXT-X-ENDLIST`;
  const p = parseMedia(text, "https://a.test/v/index.m3u8");
  assert.equal(p.segments.length, 4);
  assert.equal(p.duration, 12.5);
  assert.ok(p.endList);
  assert.equal(p.unsupported, null);
  assert.equal(p.segments[0].key.uri, "https://a.test/v/key.bin");
  assert.equal(p.segments[0].key.iv[15], 7);
  assert.equal(p.segments[1].key.iv[1], 1);
  assert.equal(p.segments[2].key, null);
  assert.deepEqual(p.segments[3].range, { offset: 100, length: 50 });
  assert.equal(outputExtension(p), "ts");

  const drm = parseMedia(`#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\na.ts`, "https://a.test/");
  assert.equal(drm.unsupported, "SAMPLE-AES");

  const fmp4 = parseMedia(`#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\na.m4s`, "https://a.test/");
  assert.equal(fmp4.map.url, "https://a.test/init.mp4");
  assert.equal(outputExtension(fmp4), "mp4");
});

test("downloadPlaylist: розшифровує, зберігає порядок, повторює невдалі запити", async () => {
  const key = randomBytes(16);
  const plain = Array.from({ length: 9 }, (_, i) => Buffer.alloc(1000 + i * 37, i + 1));
  const files = new Map([["https://a.test/key", key]]);
  const lines = ["#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:3", '#EXT-X-KEY:METHOD=AES-128,URI="key"'];
  plain.forEach((buf, i) => {
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(3 + i, 12);
    const c = createCipheriv("aes-128-cbc", key, iv);
    files.set(`https://a.test/s${i}.ts`, Buffer.concat([c.update(buf), c.final()]));
    lines.push("#EXTINF:1,", `s${i}.ts`);
  });
  const playlist = parseMedia(lines.join("\n"), "https://a.test/index.m3u8");

  const failedOnce = new Set();
  const fetchImpl = async (url) => {
    await new Promise((r) => setTimeout(r, Math.random() * 15));
    if (url.endsWith("s4.ts") && !failedOnce.has(url)) {
      failedOnce.add(url);
      return new Response("busy", { status: 503 });
    }
    const body = files.get(url);
    return body ? new Response(body) : new Response("no", { status: 404 });
  };

  const chunks = [];
  const progress = [];
  const result = await downloadPlaylist({
    playlist,
    fetchImpl,
    concurrency: 4,
    write: async (c) => chunks.push(Buffer.from(c)),
    onProgress: (p) => progress.push(p.done),
  });
  assert.equal(result.segments, 9);
  assert.ok(Buffer.concat(chunks).equals(Buffer.concat(plain)));
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("downloadPlaylist: 404 зупиняє завантаження без нескінченних повторів", async () => {
  const playlist = parseMedia("#EXTM3U\n#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts", "https://a.test/");
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return url.endsWith("b.ts") ? new Response("no", { status: 404 }) : new Response(new Uint8Array(4));
  };
  await assert.rejects(downloadPlaylist({ playlist, fetchImpl, write: async () => {} }), (e) => e.code === "http");
  assert.equal(calls, 2);
});

test("downloadPlaylist: зупинка користувачем", async () => {
  const playlist = parseMedia("#EXTM3U\n#EXTINF:1,\na.ts", "https://a.test/");
  const controller = new AbortController();
  const fetchImpl = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const run = downloadPlaylist({ playlist, fetchImpl, signal: controller.signal, write: async () => {} });
  controller.abort(new Error("stopped"));
  await assert.rejects(run, /stopped/);
});

test("asciiFileName: запасна назва латиницею", async () => {
  const { asciiFileName } = await import("../lib/media.js");
  assert.equal(asciiFileName("ТЕСТ Щука Їжак.ts"), "TEST Shchuka Izhak.ts");
  assert.equal(asciiFileName("Відео/сюжет 1950.mp4"), "Video/siuzhet 1950.mp4");
});

test("labelOf: типові назви з батьківською папкою", async () => {
  const { labelOf } = await import("../lib/media.js");
  assert.equal(labelOf("https://a.test/v/720p/index.m3u8?x=1"), "720p/index");
  assert.equal(labelOf("https://a.test/films/Kozak.mp4"), "Kozak");
});
