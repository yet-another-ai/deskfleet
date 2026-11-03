# Video fixtures

`red-64x64.h264`, `red-64x64.h265`, and `red-64x64.av1` are synthetic 64 by 64
red keyframes. They contain no captured desktop content. HEVC uses Annex B;
AV1 uses a low-overhead OBU stream with a sequence header. The smoke source
repeats complete keyframes; no file playback clock is involved.

The HEVC and AV1 fixtures were generated with FFmpeg n8.1 from the checksum-verified
BtbN/FFmpeg-Builds `ffmpeg-n8.1-latest-win64-gpl-8.1.zip` release asset:

```sh
ffmpeg -f lavfi -i color=c=red:s=64x64:r=10 -frames:v 1 -pix_fmt yuv420p \
  -c:v libx265 -x265-params 'log-level=error:keyint=30:bframes=0:repeat-headers=1:rc-lookahead=0' \
  -tune zerolatency -f hevc red-64x64.h265
ffmpeg -f lavfi -i color=c=red:s=64x64:r=10 -frames:v 1 -pix_fmt yuv420p \
  -c:v libaom-av1 -usage realtime -cpu-used 8 -g 1 -f obu red-64x64.av1
```
