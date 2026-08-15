#!/bin/sh
# Assemble frames into a palette optimized GIF.
# Env. WIDTH (1120), GIF_FPS (20), COLORS (96), FRAMES dir, OUT file.
set -e
HERE=$(dirname "$0")
FRAMES=${FRAMES:-$HERE/_frames}
WIDTH=${WIDTH:-1120}
GIF_FPS=${GIF_FPS:-20}
COLORS=${COLORS:-96}
OUT=${OUT:-$HERE/../assets/demo.gif}

ffmpeg -y -framerate 30 -i "$FRAMES/frame_%05d.png" \
  -vf "fps=$GIF_FPS,scale=$WIDTH:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=$COLORS:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 "$OUT"
ls -la "$OUT"
