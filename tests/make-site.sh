#!/usr/bin/env bash
# Генерує тестовий сайт для tests/e2e.mjs (потрібен ffmpeg). Використання: make-site.sh <нова_папка>
set -euo pipefail
out="$1"
mkdir -p "$out/plain" "$out/enc" "$out/fmp4"
cd "$out"

ffmpeg -loglevel error -f lavfi -i testsrc=size=320x240:rate=25 -f lavfi -i sine=frequency=440 -t 12 \
  -c:v libx264 -preset ultrafast -g 50 -keyint_min 50 -c:a aac -shortest -y film.mp4
hls() { ffmpeg -loglevel error -i film.mp4 -c copy -hls_time 2 -hls_list_size 0 "$@"; }

hls -hls_segment_filename 'plain/seg%03d.ts' -y plain/index.m3u8
head -c 16 /dev/urandom > enc/key.bin
printf 'key.bin\nenc/key.bin\n' > keyinfo
hls -hls_key_info_file keyinfo -hls_segment_filename 'enc/seg%03d.ts' -y enc/index.m3u8
hls -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename 'fmp4/seg%03d.m4s' -y fmp4/index.m3u8

cat plain/seg*.ts > expected-plain.ts
cat fmp4/init.mp4 fmp4/seg*.m4s > expected-fmp4.mp4

printf '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x240\nplain/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x480\nenc/index.m3u8\n' > master.m3u8

cat > index.html <<'HTML'
<!doctype html><meta charset="utf-8"><title>ТЕСТ сторінка з відео</title>
<script>
  fetch("master.m3u8"); fetch("enc/index.m3u8"); fetch("fmp4/index.m3u8"); fetch("plain/seg000.ts");
</script>
<video src="film.mp4" muted autoplay></video>
HTML
