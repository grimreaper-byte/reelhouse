# Reelhouse for Kodi

A Kodi add-on that brings Reelhouse to Kodi in two ways:

- **Reelhouse's own screens** (since 0.2.0): **Open Reelhouse** shows Reelhouse as the web app looks — the sidebar,
  Home's rows, the libraries, film and show pages, search and the live TV guide — driven with the remote. See
  [Reelhouse screens](#reelhouse-screens) below.
- **Kodi's own library**: your movies and TV shows show up in Kodi's normal Movies and TV Shows sections, in
  home-screen widgets, search and any skin, with artwork and cast, and playback streams straight from Reelhouse.

- **Everything Kodi knows about a title:** poster, background, episode thumbnails and cast photos; plot, tagline,
  genres, studio, country, directors, writers, rating and age rating; TMDB/IMDb IDs; and the file's details
  (resolution, codec, HDR, audio channels and languages, subtitle languages) for skins' media flags.
- **Watch status both ways:** resume points and watched marks from Kodi go to Reelhouse straight away, and ones made
  in the web app or another Kodi reach this Kodi within seconds. "Continue Watching" in the web app includes what you
  played in Kodi.
- **Live updates:** when Reelhouse adds, changes or removes something, Kodi follows within seconds (Reelhouse scans a
  folder about 30 seconds after files change in it). A full check also runs at start-up and every hour, as a safety
  net.
- **Direct Play:** Kodi plays nearly every format itself, so it always gets the original file; nothing is converted.
  Subtitle files next to the video (`.srt`, `.ass`, `.vtt`) are added and named by language; subtitles inside the
  file work as usual.
- **Per-user:** Kodi signs in as one Reelhouse user, sees only the libraries that user may see, and keeps that
  user's watch history.

It needs **Kodi 21 "Omega"** (the version it's tested with). It's written to also handle the databases of Kodi 19 and
20, but that's untested. It writes Kodi's local video database, so it doesn't work with a shared MySQL/MariaDB
library (it says so instead of syncing).

## Installing

**Start with an empty Kodi video library**, on a fresh Kodi install or a new Kodi profile. The add-on writes your
Reelhouse titles straight into Kodi's video database, so any of the same movies or shows Kodi already has from its
own sources would show up twice. On a Kodi you already use, remove those video sources (and the titles they added)
first, and back up its `userdata` folder if the library holds anything you want to keep. Don't add your media
folders to Kodi yourself afterwards either: add, fix and remove titles in Reelhouse, and Kodi follows.

Reelhouse's admins see these steps, with the server's address filled in, under **Settings → Kodi add-on**.

Reelhouse hands out the add-on itself, at `http://<your server>:8484/kodi/`. In Kodi:

1. **Settings → System → Add-ons:** turn on **Unknown sources** (Kodi asks you to confirm).
2. **Settings → File manager → Add source:** enter the address above (the one you open Reelhouse at, plus `/kodi/`)
   and name it `Reelhouse`.
3. **Add-ons → Install from zip file → Reelhouse →** `plugin.video.reelhouse-<version>.zip`.
4. Open **Add-ons → Video add-ons → Reelhouse → Sign in to Reelhouse…** and enter the Reelhouse address, your
   username and your password.

The first sync starts right away; your movies and shows then appear under Movies and TV Shows. To update the
add-on later, repeat step 3 with the newer zip: Kodi keeps the add-on's settings and sign-in.

## Signing in and out

Kodi gets its own sign-in, separate from your browser's: the password isn't stored, and the sign-in lasts a year
from the last time Kodi used it. Every signed-in Kodi is listed in the web app under **Settings → Your account →
Apps and devices**, where you can sign one out (for example a lost device). Changing your password signs out every
Kodi too. A signed-out Kodi shows a message and stops syncing until you sign in again from the add-on's settings.

When Kodi starts, a notification says which server it connected to and who it's signed in as, e.g. "Connected to
my-server as Dave" (since 0.5.0). If Reelhouse can't be reached yet (the network is still coming up, or the server is
off), it shows once Reelhouse answers. A name changed in Reelhouse since signing in shows, and is kept, as the new
one.

## Reelhouse screens

Open the add-on (**Add-ons → Video add-ons → Reelhouse**) and choose **Open Reelhouse**, or turn on **Open Reelhouse
when Kodi starts** in the add-on's settings for a Kodi that's mostly for Reelhouse.

- **Back and Exit (since 0.4.0):** Back closes the screen you're on and shows the one before, but never leaves
  Reelhouse. On Home it moves to the sidebar, and a second press moves onto **Exit**, the sidebar's last entry.
  Select Exit to return to Kodi. If Kodi ever shows its own screens while Reelhouse is still open, **Open Reelhouse**
  brings you back to where you were.
- **The sidebar:** a strip of icons on the left; moving onto it slides out the names. From the top: **Now playing**
  while something is playing or paused (since 0.11.0, as on Kodi's own home screen; it returns to the player, and Back
  comes back to the screen you were on), Home, each library with its count and the icon picked for it in the web app's
  Settings → Libraries (since 0.3.0), and Search. Kept at the bottom (since 0.4.0): Live TV and Radio (when Reelhouse
  has them for you), Manage Recordings (when your account may record; since 0.6.0), Settings (the add-on's settings)
  and Exit. Down from Search moves into the bottom group; Up on Home and Down on Exit stay where they are rather than
  scrolling round (since 0.13.2). Slid out, the sidebar is wide enough for the longest names (since 0.13.2).
- **Home:** the web app's rows: Continue Watching (Select carries on where you stopped; the menu or info button opens
  the page instead; a channel, when Settings → Live TV shows them there, plays straight away), Recently Added in each
  library, Watched by Others.
- **Libraries:** a grid of posters, with Sort, Show (unwatched, in progress, watched) and Genre along the top.
- **Film, show, season and episode pages:** the artwork still behind the page, the poster and title, quality badges
  (one per copy of a film), **Resume** / **From the start** / **Mark watched** and **⋯** (Play version… for a film with
  more than one copy, Media info, the episodes either side); then a show's seasons or a season's episodes as a grid
  that scrolls, as in the web app, then the cast (each opens their page) and related titles.
- **Search:** Kodi's keyboard, then movies, TV shows, episodes and titles whose cast or crew matched.
- **Live TV and Radio:** the web app's guide — channels against time with a line at now, programmes in their genre's
  colour, the highlighted one's details underneath, the days along the top. The arrow keys move as on a remote: left
  and right along a channel, up and down to the same time on the channels above and below. Select a programme that's
  on to watch (or listen to) it, or a later one to record it (Cancel recording on one that's scheduled) when your
  account may record. While a channel plays, **Reelhouse's own player controls** take the place of Kodi's (since
  0.14.0, with Reelhouse 0.23.0), laid out as Kodi's are for its own TV channels: the channel's logo, the programme
  and when it ends at the top; the programme's start and end at the ends of its progress bar, and how far into it and
  how long it is in the middle; previous and next channel, stop and record (white, red while the programme records;
  pressed then, it offers Stop recording), and on the right the channels, the programme's details (also the Info
  button), Kodi's subtitle settings and its video and audio settings. OK shows them; they go after a few seconds. Up
  and down (and the remote's channel and next/previous buttons) change channel, and a channel that can't play says
  why and leaves the one playing. **Pause** (with left and right going back and on 10 seconds) needs Kodi's own
  InputStream FFmpeg Direct add-on, which keeps what's played on the Kodi device: the screens offer to install it the
  first time they open (Kodi asks), and the add-on's settings have an entry for it while it's missing; without it
  there's no pause button. Radio plays in Kodi's own player. A recording someone else
  set can only be cancelled by them or an admin (since 0.6.0, with Reelhouse 0.14.0 or later). Accounts allowed to
  also have **Record series** (since 0.11.0, with Reelhouse 0.20.0): every episode of the show on that channel, an
  episode then offering **Skip this episode** rather than Cancel recording, and **Cancel series recording**.
- **Manage Recordings** (since 0.6.0, called Recordings before 0.9.0; needs Reelhouse 0.14.0 or later): the recordings
  you set from the guide, as on the web app's Manage Recordings page, like a TV library (since 0.8.0, with Reelhouse
  0.17.0): shows with their cover art (or their channel's logo), since 0.9.0 (with Reelhouse 0.18.0) under the
  headings **Recording now** (a red REC mark), **Recorded** (newest first, the number of recorded episodes in the
  corner) and **Scheduled** (soonest first, with when the next episode records), since 0.10.0 each a grid like a
  library's, and since 0.11.0 (with Reelhouse 0.20.0) **Series recordings**, where Select offers the show's episodes
  and **Cancel series recording**. How full Tvheadend's recordings drive is sits across from the title. A section
  shows two rows at a time and more scroll inside it; the arrows move through it and on to the next. A show opens its
  series' covers, with **Delete show** across the top; a series opens its episodes' pictures (TMDB's stills, else the
  guide's), with REC, Scheduled or what went wrong, and **Delete series** across the top; a show without series
  numbers opens straight to its episodes. The menu button on a show or a series offers Open and Delete show / Delete
  series (their recorded episodes, after asking; what's still to come keeps recording). Select an episode (or press
  the menu or info button) for its details, with who set it and their picture, and what it offers: **Stop recording**
  (what's recorded so far is kept), **Cancel recording** (**Skip this episode** if a series recording set it), or
  **Delete recording**, which asks again, then deletes its file from Tvheadend's recordings drive. Admins have a
  **Showing:** chip to switch to everyone's, with who set each under its cover, their picture and name (since 0.10.0).
  The screens are read again every minute.

Films and episodes play in Kodi's own player, as items from Kodi's library do, so its controls, subtitle and audio
menus work as usual; an episode carries on into the rest of its season, and the controls show it as "S1 · E3 — title"
under its show, with its season's cover in the info panel (since 0.14.1). Live TV is converted by Reelhouse as in the
web app (broadcast video is interlaced), and stopping it frees Tvheadend's tuner straight away.

The screens use your Kodi skin's fonts (an add-on can't bring its own); they're laid out for Estuary, Kodi's standard
skin. Reelhouse's own player controls for films, the library's A–Z jump and choosing a live TV quality aren't there
yet.

## Settings

| Setting | |
| --- | --- |
| Reelhouse address, Sign in…, Sign out | The server and account. Signing out offers to remove the Reelhouse items from Kodi. |
| Open Reelhouse | Opens Reelhouse's own screens (see above). |
| Open Reelhouse when Kodi starts | Off by default. Kodi opens straight into Reelhouse's screens. |
| Sync when Kodi starts | On by default. |
| Live updates | On by default. Keeps a connection open to Reelhouse while Kodi runs. |
| Full check every | Never, 15 or 30 minutes, an hour (default), 3 or 12 hours. |
| Sync now | Brings Kodi up to date right away, with a progress bar. |
| Remove Reelhouse items from Kodi | Takes out everything the add-on added. Your other Kodi media isn't touched. Do this before uninstalling the add-on. |

## Good to know

- Synced items play through the add-on, so Reelhouse has to be reachable when you press play. Away from home, use
  Reelhouse's WireGuard VPN or its HTTPS address (with a certificate Kodi trusts, e.g. Let's Encrypt; self-signed
  ones don't work).
- If Reelhouse can't be reached, watched marks and resume points from Kodi wait and are sent when it's back (as long
  as Kodi stays open), and Kodi catches up on anything that changed meanwhile.
- Kodi's **Clean library** and **Update library** leave the synced items alone; removals come from Reelhouse.
- Signing in again replaces this Kodi's earlier sign-in. Kodi gets a new entry under Apps and devices, and the old
  one is signed out.
- Don't also add your media folders to Kodi as a normal video source: you'd get every title twice.
- Kodi fetches artwork and video by plain URL, so the add-on's sign-in token is part of those URLs inside Kodi's
  database and image cache. If you give the device away, sign it out under Apps and devices.
- The add-on keeps its settings and a small record of what it synced in Kodi's
  `userdata/addon_data/plugin.video.reelhouse/`.

## How it works

The add-on's background service is the only thing that writes Kodi's video database (`MyVideos*.db`). It asks
Reelhouse for a compact list of each library (IDs and a checksum per item), fetches full details only for what's
new or changed, and writes them with the same tables, links and paths Kodi's own scanner uses, all in one
transaction per batch. Synced items point at `plugin://plugin.video.reelhouse/…?mode=play&id=<n>`, and those URLs
(and each show's folder) are how the add-on recognises its own rows, so a lost record never duplicates or deletes
the wrong item. Playing one asks Reelhouse for the original file (`direct: true`, so the server never converts) and
reports progress every 10 seconds; progress and watched marks go out one at a time, in order. Live changes come
from Reelhouse's event stream (`/api/events`), and every reconnect runs a quick sync.

| Path | |
| --- | --- |
| `plugin.video.reelhouse/addon.xml` | Add-on manifest (plugin + service) |
| `ui.py`, `resources/lib/ui/` | Reelhouse's screens: `app.py` (opening screens, playing), `model.py` (what cards and pages say, worded as the web app), `guide.py` (the live TV guide's layout and arrow keys), `windows/` (one module per screen) |
| `resources/skins/Default/` | The screens' layouts (`1080i/reelhouse-*.xml`) and pictures (`media/reelhouse/`): made by `kodi/tools/build_skin.py` from `kodi/skin-src/` and by `kodi/tools/build_icons.py` from the web app's icons. Edit the sources and run the tools; the tests check the layouts are up to date |
| `resources/lib/api.py` | Reelhouse API client: device sign-in, sync API, playback, progress, event stream |
| `resources/lib/kodidb.py` | Writes movies, shows, seasons and episodes into Kodi's video database |
| `resources/lib/sync.py` | Works out what changed and applies it |
| `resources/lib/syncdb.py` | The add-on's own record of synced items (Reelhouse ID → Kodi ID, checksum) |
| `resources/lib/service.py` | Background service: syncing, live updates, progress and watched reporting |
| `resources/lib/plugin.py` | The add-on menu, sign-in/out and playback (films, episodes and live TV channels) |
| `resources/lib/live_osd.py` | Reelhouse's own player controls while a live channel plays (`reelhouse-live-osd.xml`): the programme's times and progress, channel changes, record, pausing through InputStream FFmpeg Direct |
| `tests/` | Tests against a real Kodi 21 database schema, a fake server and stand-ins for Kodi's Python modules (`kodistubs.py`) |

The server side lives in `server/routes/sync.js` (sync API), `server/routes/auth.js` (`POST /api/auth/device`, the
devices list) and `server/kodi.js` (the `/kodi/` download page and zip).

When changing the add-on, raise its `version` in `addon.xml`: the zip on `/kodi/` is named after it, so people can
see there's something new to install, and Kodi shows the new version.

Run the add-on's tests with Python 3.8 or newer:

```bash
python3 -m unittest discover -s kodi/tests
```
