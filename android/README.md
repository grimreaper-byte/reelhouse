# Reelhouse for Android

The Reelhouse app for Android phones, tablets and TV boxes such as a Fire TV, from Android 7.1. It reaches Reelhouse
at home directly and, away from home, through the **app tunnel**: WireGuard built into the app, so there's no
WireGuard app, no VPN slot, and nothing else on the device goes through it. The app talks only to your Reelhouse
server: see its [privacy policy](../PRIVACY.md).

Status: milestones 1–5 are done. You can:
- pair the app (QR code, link, typed code or password);
- browse Home, libraries (sort, filter, genre), movie, show, season and episode pages, and search;
- get around with a sidebar, as in the web app (since 0.1.11): a strip of icons on a tablet or a phone held sideways
  (☰ or a mouse slides it out, the pin keeps it open), a drawer from Home's ☰ on a phone held upright; each library
  shows the icon picked for it in the web app's Settings → Libraries (since 0.4.0); Search is the button in Home's top
  bar (since 0.5.2 not in the sidebar too); Downloads is in the sidebar when Reelhouse allows downloads or something's
  already downloaded (since 0.11.0; a button in Home's top bar before);
- on a phone held sideways, each page's top bar (Home, libraries, film pages, Search, the Live TV guide, Settings…)
  sits up in the status bar's row, between the clock and the status icons, so the page below gets the room (since
  0.5.4; the guide no longer shows its own clock, as the status bar has it);
- see a film's or show's artwork fill its page and stay still while the page scrolls over it (since 0.1.11), with
  the poster and title right under the top bar (since 0.1.12);
- open Settings from your picture at the top of Home (since 0.1.12), next to Search;
- skip between a film's chapters with the player's ⏮ and ⏭ (since 0.5.0; shown for films whose file has chapters);
- play any copy of a film that has more than one (SD and HD, say) from **⋮ → Play version…** on its page, which
  shows a quality badge per copy (since 0.1.13; Play plays the best copy);
- tap anyone in a cast for their page: who they are, their titles on the server and their other movies;
- choose a picture for your account in Settings (since 0.1.7): checked on the phone, shown as it
  will look, then sent; HEIC photos are converted on the phone;
- mark things watched;
- play, with resume, audio, subtitle and quality choices, and the next episode;
- download movies, episodes and whole seasons to watch offline, when Reelhouse allows downloads;
- install it from your Reelhouse, and update it from there too;
- watch Live TV and listen to Radio from Tvheadend, when Reelhouse has it and your account may (since 0.2.0): the
  guide as a now/next list upright and a grid on its side or on a tablet, programme details with Record / Cancel /
  Stop recording for accounts allowed to, and Record series / Cancel series recording for those allowed that (since
  0.11.0, with Reelhouse 0.20.0; every episode of the show on that channel, an episode then offering Skip rather than
  Cancel), and a player with channel up/down, pause and Live;
- see the channels you've watched in Continue Watching, when Settings → Live TV on the server shows them (since
  0.12.0, with Reelhouse 0.21.0);
- see the recordings you set in **Manage Recordings** (since 0.6.0, called Recordings before 0.9.0, with Reelhouse
  0.14.0 or later): since 0.8.0 (Reelhouse 0.17.0) like a TV library, shows with their cover art, a show's series as
  covers, a series' episodes as pictures; since 0.9.0 (Reelhouse 0.18.0) the shows under the headings Recording now,
  Recorded (newest first) and Scheduled (soonest first, with when the next episode records), since 0.10.0 each a grid
  like a library's; the button in a cover's corner deletes the show (under Recorded), the series or the recording
  (Delete deletes the file on Tvheadend, after asking), cancels (×) a scheduled episode or stops (■) one recording
  now; an episode opens its details, with who set it and their picture; admins can switch to everyone's, with who set
  each under its cover, their picture and name as in Requests (since 0.10.0); since 0.11.0 (Reelhouse 0.20.0) your
  series recordings in a section of their own, × cancelling one, and how full Tvheadend's recordings drive is on the
  line under the title;
- ask for movies that aren't on the server in **Requests** (since 0.3.0), see everyone's requests with who asked and
  when, and remove your own (an admin can remove any, or all);
- read Reelhouse's licence and those of the open-source projects it's built with in **Settings → About →
  Open-source licences**;
- use all of it with a remote on a TV box, since 0.13.0 ([below](#on-a-fire-tv-or-android-tv-box)).

The app picks a route (at home, tunnel or web), and pages update live when something changes on the server.

## Installing it on a phone

1. Download the APK from the [latest release](https://github.com/grimreaper-byte/reelhouse/releases/latest), or build
   the release APK (below: it's then `app/build/outputs/apk/release/app-release.apk`). In Reelhouse open **Settings →
   Android app** and upload it. Reelhouse checks it's a signed release build of this app.
2. On the phone, open `http://<your Reelhouse>/android/` (at home), or scan the QR code under **Don't have the app
   yet?** in the pairing dialog (**Your account → Apps and devices → Pair the Reelhouse app**, or an admin's
   **Settings → Users** → the link button next to that person). Download it and
   allow your browser to install apps when the phone asks. Google Play Protect may offer to scan an app from outside
   the Play Store; either choice works.
3. Open Reelhouse on the phone and pair it (see **Trying it** below).

**Updating:** upload a newer version, from the latest release or your own build (raise `versionCode` and `versionName`
in `app/build.gradle.kts`). Phones notice the next time they connect: your picture at the top of Home gets a dot, and
**Settings → About → Download and install** updates the app in place, still paired and with its downloads. The first
time, Android asks to allow Reelhouse to install apps.

**Playing:**
- **Direct or converted:** the phone plays the file itself when its decoders can, and the server converts it when
  they can't. The player's top line says which, and why. XviD and DivX videos are always converted: phones' MPEG-4
  decoders only handle the simpler Simple Profile. AVI files are always converted too: the phone's player times
  their sound wrongly (about half a second ahead of the picture). A downloaded AVI plays converted while Reelhouse
  can be reached; offline it plays as it is, and may be out of step. If a file plays without a picture for 3 seconds, the app
  switches to converting it (a download played offline says so instead).
- **Quality:** at home the default is the original; away, the server's remote quality. A quality picked in the
  player is remembered for home and away separately. The menu lists only the original and the qualities below
  it, and a remembered quality higher than the file plays it as the original.
- **Picture and sound:** some phones show the picture a little after its sound. The app measures that from
  Android's reports of when each frame reaches the screen and makes up for it by itself, from the next video
  on as soon as it's known. **Settings → Playback → Picture and sound** shows what it measured, with a
  fine-tune if it still looks off (also in the player's Audio menu, so you can watch while you change it).
- **Resume:**
  - starting something that was left part-way asks whether to resume or start over;
  - the episode or movie page has both buttons;
  - episodes that play on automatically after one ends always start from the beginning.

**Downloads:**
- **Only if Reelhouse allows them:** **Allow downloads** in Reelhouse's Settings → General (off on a new server since
  Reelhouse 0.19.0). While it's on, movie and episode pages have **Download** and seasons have **Download season**.
  Turned off, those disappear at once, downloads in progress stop, and nothing new can download; what's already
  downloaded still plays.
- **Downloading:** the original file, in the background with a progress notification. Wi-Fi only unless you change
  it in Settings. An interrupted download carries on where it stopped.
- **Watching:** the **Downloads** screen (in the sidebar, or **Watch downloads** when Reelhouse can't be reached).
  Something downloaded always plays from the phone, with its subtitles and the next downloaded episode. What you watch
  offline reaches Reelhouse when the app can reach it again.
- **Removing:** from each download's menu, **Delete all downloads** in Settings, or by signing out.
- A download is the original file. If the phone can't play it as it is (some phones can't play 10-bit HEVC, for
  example), Reelhouse converts it while you're connected; offline, the player says so.

## On a Fire TV or Android TV box

The app runs on a box with Android 7.1 or newer (a Fire TV Stick 4K on Fire OS 6 is the one it's been tried on). It knows
it's on one by the device being a TV or having no touch screen, and then:

- **Getting around:** the arrows move an accent ring, OK presses, Back goes back. Left from a page opens the sidebar,
  Right or Back returns to the page. Each screen starts on its main thing (a film's Play, a guide's programme on now),
  and coming back to a screen returns to what you left.
- **Text boxes** don't bring up the keyboard as you pass over them: press OK on one to type, and Back to finish. In a
  search box, Right goes to its ✕, which empties it (since 0.13.1).
- **The player:** Left and Right skip 10 seconds, OK pauses, Up or Down brings up the controls, Back hides them first.
- **Live TV:** Up and Down change channel, with a banner saying what's on; OK, Left or Right bring up the buttons; the
  Play/Pause key pauses.
- **Not there, as there's no use for them:** Scan the QR code without a camera, pull to refresh.

**On the home screen:** Android TV and Google TV show the app's wide banner. Fire OS doesn't, for an app that isn't from
Amazon's Appstore: it puts the app's square icon between grey bars, so on a TV that icon has the logo and the name. Fire
OS also keeps its own copy of the picture, even through uninstalling: restart the Fire TV if an old one stays. An app
isn't always in the row at the top: find it under **Your Apps & Channels**, and press the menu key on it to move it.

**To install it:** on a Fire TV, turn on **Settings → My Fire TV → Developer options → Apps from Unknown Sources**
(wording varies by Fire OS version), then open the APK with an app such as Downloader, from the [latest
release](https://github.com/grimreaper-byte/reelhouse/releases/latest) or `http://<your Reelhouse>/android/`. With
ADB debugging on, `adb connect <its address>` and `adb install` work too. **To pair it**, choose **Type the code (at
home)** and enter Reelhouse's address and the code, with the box on the same network as Reelhouse.

## Building

You need:
- **Android Studio** (or just the Android SDK) with SDK platform 37, and the **NDK** (`ndk/30.0.16248370`).
- **Go** 1.26 or newer, and **gomobile**:

  ```
  go install golang.org/x/mobile/cmd/gomobile@latest
  go install golang.org/x/mobile/cmd/gobind@latest
  gomobile init
  ```

The build compiles the Go tunnel library (`../tunnel/mobile`) into `app/libs/rhtunnel.aar` with gomobile first (the
`buildTunnelAar` task; it finds Go and gomobile in the usual places). Then:

```
cd android
gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
gradlew assembleRelease        # app/build/outputs/apk/release/app-release.apk (shrunk and signed)
gradlew testDebugUnitTest      # unit tests (JVM)
```

**Release signing:** the release APK is signed with a key kept outside the repo. The build reads
`~/.reelhouse/android-signing.properties`:

```
storeFile=C:/Users/<you>/.reelhouse/reelhouse-release.jks
storePassword=...
keyAlias=reelhouse
keyPassword=...
```

Make the keystore once with the JDK's `keytool`, for example
`keytool -genkeypair -keystore reelhouse-release.jks -storetype PKCS12 -alias reelhouse -keyalg RSA -keysize 4096 -validity 36500`.
**Keep a backup of both files:** phones only install an update signed with the same key, so a lost key means
uninstalling and pairing every phone again. Without the properties file, `assembleRelease` makes an unsigned APK,
which Reelhouse won't accept for upload.

On Windows, set `JAVA_HOME` to Android Studio's JDK first, e.g. `C:\Program Files\Android\Android Studio\jbr`.
`local.properties` (not checked in) holds the SDK location; Android Studio writes it, or add
`sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk` yourself.

Install on a phone with USB or wireless debugging turned on: `adb install -r app/build/outputs/apk/debug/app-debug.apk`.

## Trying it

1. In Reelhouse: **Settings → Remote access → Reelhouse app tunnel**, turn it on (for use away from home).
2. In Reelhouse: **Your account → Apps and devices → Pair the Reelhouse app** (or, as an admin, for someone else:
   **Settings → Users** → the link button next to them).
3. In the app: **Scan the QR code**. At home, you can also type the code with Reelhouse's address.

The app shows how it's connected (At home, Tunnel, Web) at the top. Settings shows the details. Debug builds
have **Always use the tunnel**, for testing the tunnel at home.

**On the emulator:** Reelhouse on the same PC is at `http://10.0.2.2:<port>`. For the tunnel, set Reelhouse's app
tunnel address to `10.0.2.2` before making the pairing code, since `127.0.0.1` inside the emulator is the emulator
itself. A pairing link can be opened without a camera (the app asks before it pairs, as for any link opened from
outside it):

```
adb shell "am start -a android.intent.action.VIEW -d 'reelhouse://pair?d=…'"
```

## How it's put together

| Part | Where |
|---|---|
| A remote | `ui/common/Remote.kt`: where the focus starts and returns to on each screen (`RemoteScreen`, `remoteFocus`, `startFocus`), rows and grids that keep it at their ends (`focusRow`, `endOfRow`), text boxes that don't trap it (`RemoteTextBox`), how pages scroll for it (`RemoteScroll`). `ui/theme/FocusRing.kt` and `ui/components/Buttons.kt` draw the ring. Nothing here does anything on a phone |
| Tunnel (Go, gomobile) | `../tunnel/mobile`: wireguard-go and gVisor netstack in the app's process, plus a local HTTP proxy at `http://127.0.0.1:<port>/<secret>` that forwards to Reelhouse inside the tunnel |
| Connection | `data/connection`: picks the route (home addresses, then the tunnel, then the web address) at start, on network changes and when a request fails; stops the tunnel a minute after the app leaves the screen |
| Pairing | `data/pairing`: reads `reelhouse://pair` links. At home it pairs with a key made on the phone, only where the code's server id answers; away, through the tunnel with the QR code's key |
| Storage | `data/store`: the sign-in and tunnel key, encrypted with an Android Keystore key (never backed up) |
| API | `data/api`: one OkHttp client for the API, images (Coil) and video (Media3). The token only goes to Reelhouse's current address |
| Live updates | `data/events`: `GET /api/events` while the app is on screen. Screens refresh on `library` and `state` events, and everything refreshes after a reconnect |
| Playback | `data/playback` (the phone's decoders in the server's terms, the playback API) and `ui/player` (Media3 ExoPlayer in a `PlayerView`, track and quality menus, progress reports, recovery from decoder errors and the 3-second picture check, and picture timing: `TimedVideoRenderer` + `SyncedAudioSink` + `PictureTiming`) |
| Downloads | `data/downloads`: the list and offline reports (JSON files next to the videos), a WorkManager worker that fetches with resumable range requests (`If-Range`, so a replaced file comes whole), and the rule that signing out or pairing with another Reelhouse removes them |
| Updates | `data/update`: downloads a newer APK from Reelhouse's `/android/` and hands it to Android's installer |
| UI | `ui/`: Jetpack Compose, Material 3, Navigation 3, in the web app's colours. `ui/Sidebar.kt` is the sidebar (strip, pop-out, pin, drawer) around the screens; `ui/BootScreen.kt` the boot screen over the app as it starts |
| Live TV | `ui/livetv`: the guide (`GuideScreen`: list, or a grid placed by `Timeline` with one shared horizontal scroll; `GuideLogic` holds the web app's rules), the live player (`LivePlayerViewModel`: `POST /api/livetv/play` with the channel left as `previousSession`, waits for the playlist's first seconds, 10-second heartbeats, `stopped` on leaving; `LiveLogic`). Shown when `GET /api/me` says `liveTv.available`, asked again on the `livetv` live event |
| Requests | `ui/requests`: the search (`GET /api/requests/search`), the list and asking/removing (`RequestsViewModel`), `RequestsLogic` for what a found film offers and when removing asks first. The sidebar's row and count come from `GET /api/me` (`requests`), kept up by the `requests` live event |
| Licences | `ui/settings/OpenSourceLibraries.kt`: every project built into the APK (AndroidX and the other Maven libraries, direct and indirect, and the tunnel's Go modules), with the licence texts in `assets/licences`. `OpenSourceLibrariesTest` fails when a library in `build.gradle.kts` or a module in `tunnel/mobile/go.mod` has no entry, and when `assets/licences/reelhouse.txt` differs from the repository's `LICENSE`. After changing dependencies, check the indirect ones with `./gradlew :app:dependencies --configuration releaseRuntimeClasspath` |

The app checks that it found the right Reelhouse by the server id in `GET /api/server` before sending its token
to a home address. Another server can answer at the same address on someone else's network. Watch progress made
offline goes to Reelhouse later with its age, and Reelhouse ignores it if the item changed since.
