# LocalTV

Stream videos from your Mac to your TV over your home network, using your phone as the remote.

Pick a video on your phone and it plays on a Chromecast / Google TV / Android TV, on the phone itself, or in a TV's web browser. Files the TV can't play directly (MKV, HEVC, TrueHD, Blu-ray subtitles…) are converted on the fly. No accounts, no cloud, nothing leaves your LAN.

> The macOS menu bar app and its bundle are named **TVUtils**; the repository is **LocalTV**.

## Features

- **Phone remote** (a web page, nothing to install): browse folders, search across all subfolders, thumbnails and cleaned-up titles, mini-player and full player, light and dark themes.
- **Three places to play:** cast to a TV found automatically on your network, play on the phone itself, or open a fallback page (`/tv`) in a TV's browser.
- **Converts what the TV can't play:** audio to AAC, video copied or re-encoded to H.264 with the Mac's hardware encoder. Files that already play natively are sent untouched.
- **Audio and subtitle choice:** defaults to Japanese audio with English subtitles when present. Text subtitles are sent as a separate WebVTT track, image subtitles (Blu-ray PGS) are drawn onto the picture.
- **Menu bar app:** starts the server, picks the media folder, shows a QR code for your phone, keeps the Mac awake while it runs, optional launch at login.
- **Change the media folder from the phone** (home folder and external drives only).

## Requirements

| | |
|---|---|
| macOS | 13 or newer (for the menu bar app; the server itself also runs elsewhere, but TV discovery and the hardware encoder are macOS-specific) |
| [Node.js](https://nodejs.org) | 18 or newer |
| [ffmpeg](https://ffmpeg.org) (includes `ffprobe`) | Needed for conversion, thumbnails, subtitles and audio/subtitle choice. `brew install ffmpeg`. Without it, only MP4 files with H.264 + AAC play. |
| Xcode command line tools | Only to build the menu bar app (`xcode-select --install`) |

## Quick start

**Option A: menu bar app**

```bash
npm install
./build-app.sh              # builds TVUtils.app (ad-hoc signed)
cp -R TVUtils.app /Applications/
open /Applications/TVUtils.app
```

Look for the TV icon in the menu bar. Choose your media folder, then **Show QR code for phone…** and scan it. The first launch may need right-click → Open, and macOS will ask for **Local Network** access: allow it, or the Mac can't find your TV.

**Option B: plain server**

```bash
npm install
node server.js "/path/to/your/videos"     # or: PORT=9000 MEDIA_DIR=... npm start
```

It prints the phone address, e.g. `http://192.168.1.20:8080/`. Open it on a phone on the same Wi-Fi.

## Using it

1. Open the phone page. The **Play on** button at the top picks the target: *This phone*, your TV, or *TV browser page*. The last choice is remembered.
2. Tap a video. A mini-player appears; tap it for the full player (seek, ±10/30 s, next/previous, audio and subtitle pickers, volume, stop).
3. Swipe down to close sheets or minimise the player.
4. **Settings** (top right): media folder, TV compatibility switches, logs.

Next/previous follow the folder (or the search results when playing from search).

## How casting works

- The Mac finds cast devices with `dns-sd` (macOS's own mDNS), then talks the Cast protocol with [`chromecast-api`](https://github.com/alxhotel/chromecast-api) using the Default Media Receiver. The TV pulls the video from the Mac over HTTP.
- Direct play: MP4 (H.264 + AAC/MP3) is served as is, with range requests.
- Converted play: ffmpeg streams a fragmented MP4 (or HLS for phones). The server patches the real duration into the stream header; without it the TV treats the stream as live and floods its own notification service (see Troubleshooting).
- Seeking in a converted stream restarts it from the new position.

### Settings

Saved in `~/Library/Application Support/TVUtils/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `root` | `~/Movies` | Media folder (set from the menu bar app or the phone) |
| `endOnStop` | `false` | Close the TV's cast screen on Stop. Some TVs switch HDMI input when it closes. |
| `castArtwork` | `true` | Send a poster image with the cast |
| `castSubs` | `true` | Send text subtitles to the TV |
| `castPoll` | `true` | Poll the TV for its position every 4 s |

Environment: `PORT` (default `8080`), `MEDIA_DIR`. A folder passed on the command line wins over the config file.

Logs: `~/Library/Logs/TVUtils/server.log`, also in the phone page under Settings → View logs.

## Troubleshooting

- **TV not listed:** same Wi-Fi network as the Mac, TV awake, and macOS Settings → Privacy & Security → **Local Network** allows TVUtils.
- **"Can't reach <TV>"** when casting: the TV is asleep or Local Network access is denied.
- **TV shows "Android TV Core Services has stopped" while casting:** seen on a low-memory (2 GB) TCL TV when a converted stream declared no duration. This is handled; if it returns, check what changed in the metadata, volume or duration sent to the TV. `adb logcat` shows the receiver flooding notifications ("Shedding") when it happens.
- **An HDMI device wakes up when casting:** setting the TV's volume wakes some HDMI-CEC audio devices. The server only *reads* the volume at start for this reason.
- **Video won't play on the TV:** try the logs (Settings → View logs) for the ffmpeg error; HDR sources are not tone-mapped when converted to SDR.

## Security

There is **no login**. Anyone on your network can browse and stream the media folder and change the folder to anything under your home folder or `/Volumes`. Keep it on a trusted LAN. Don't forward its port to the internet; for remote access use a VPN such as [WireGuard](https://www.wireguard.com) or [Tailscale](https://tailscale.com).

## Project layout

```
server.js        HTTP server: library, search, streaming, conversion, casting, settings
public/
  remote.html    the phone interface (single page, no build step)
  tv.html        fallback player for a TV's browser (/tv)
  hls.min.js     hls.js, for playing converted video in phone browsers
app/main.swift   macOS menu bar app (launches server.js, QR code, folder, login item)
build-app.sh     builds TVUtils.app (copies server.js, public/, node_modules/)
```

## Limitations

- Conversion uses `h264_videotoolbox`, so it needs a Mac.
- HDR is not passed through or tone-mapped.
- No authentication (see Security).
- Casting from search results uses the video's own folder as the playlist.
