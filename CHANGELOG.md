# TACTIQ ANALYST – changelog

## 3.1.0 – who is who on the pitch, animated annotations

After the feedback on the 3D tracking video (a linesman counted as a player, the referee drawn like a player,
players missing): the pitch comes first, and only the people inside it become players.

### Pitch first, then tracking
- The Track tab shows **Step 1 – the pitch** until the camera view is calibrated. The 🤖 start window and the result
  window say so too, with **📐 Calibrate the pitch now**; after calibrating, **↺ Re-import last run** sorts the same
  analysis again without running the AI again.

### Who is who (new `renderer/roles.js`)
Every AI track is placed on the calibrated pitch (with a margin that grows with the distance from the camera) and sorted:
- **Players** – a team kit, inside the pitch. Kits are compared by their hue, so shade and floodlights no longer turn a
  white shirt into "other" (players in shade were missing before), and a blue-grey or dark kit no longer becomes a red
  player just because red was the nearer of the two teams.
- **Goalkeepers** – a third kit that stays in or near one penalty area (one per goal) → a player of the team defending
  that goal, label GK.
- **Referee** – neither team kit, moving freely inside the pitch → drawn as a black **REF** marker (video, 2D, 3D),
  never as a player and never counted as one.
- **Assistant referees** – stay on one touchline (one per touchline, preferring the referee's kit) → left out.
- **Outside the pitch** – coaches, substitutes, ball boys, cameramen → left out.
- Option to keep the officials and staff as hidden tracks; Track tab ticks **referee** and **officials & others**.
- **🧭 Who is who** sorts AI tracks already in a project (older versions, or calibrated later); tracks you identified
  or typed by hand are left alone; Ctrl+Z undoes it. The track editor has the types *Referee*, *Assistant referee*
  and *Other person (not drawn)*.
- Checked on both Spain v England test clips: every person sorted correctly (players, goalkeeper, referee, both
  assistant referees, 2–4 people outside the pitch).

### AI engine
- Weak detections (from 12 % confidence) may continue an existing track: half-hidden players and players in odd poses
  are kept – about one more player found per frame with both models. New tracks still need a confident detection.

### ✨ Animated annotations (new `renderer/annotate.js`)
- ✨ under the video: **🔦 Spotlight**, **🏷 Tag**, **➜ Run**, **↔ Distance** (live metres), **〰 Line** through a unit
  (with gaps in metres, optional shaded area) and **▭ Zone** (stored in pitch metres). They follow the tracked players
  and, with a calibration, are drawn in perspective and stay on the grass while the camera pans.
- Fade in, draw themselves and fade out while playing; complete while paused; colour and duration (2–10 s or to clip
  OUT); list with jump / longer / shorter / delete; undo; saved with the project.
- Shown on the video, on the 2D pitch, in the 3D view (spotlight beams, distances, lines, zones – also in 3D replays and
  their MP4) and in screenshots.
- **🎬 MP4 with the annotations burnt in**: frames are drawn exactly from the tracking data on a transparent picture
  and ffmpeg lays them over the original video (with sound) – a 4-second clip takes about 6 s.

### Fixes found on the way
- Heat maps and samples no longer include "other" people (staff, unknown).
- The 2D and 3D "placed" counts are players only (the referee was counted).
- 🔗 Auto-link and the continuation suggestions never join people outside the pitch to players.
- The 3D library bundle now also has the curve, cone and blending parts the annotations need.

### Tests
- New end-to-end test (38 checks): pitch-first prompts, who is who on a real AI run, hidden officials, type changes
  with undo, six annotations made by clicking, video / 2D / 3D drawing, list, undo, saving, MP4 export with frame
  check, 🧭 Who is who on a 3.0 project. Windows smoke test: AI import, an annotation and an annotated MP4.
- Third tutorial video: *Who is who · animated annotations*.

## 3.0.0 – roadmap phase 1.0: production release

The last phase of the blueprint: stable for full matches, safe against crashes, tested on Windows in every build,
with a user guide and tutorial videos.

### Full 90-minute matches stay fast
Measured with a full match (90 min video, 2 060 tags, every player and the ball tracked by AI: 1.6 million positions,
calibrations every 30 s, 270 camera shots) on a slow 2-core PC:

| | 2.6 | 3.0 |
|---|---|---|
| Open the project | 25 s | 2.2 s |
| Make a tag | 8.5 s | 0.09 s |
| Undo | 10 s | 0.1 s |
| Memory per undo step | +80 MB | ~0 |
| Track tab / Stats / Positions tab | 7.8 / 3.1 / 19.9 s | 0.9 / 0.35 / 0.9 s |
| PDF report with positional pages | 18.7 s | 0.5 s |
| Memory after opening | 2.1 GB | 1.3–1.5 GB |

How: unchanged tracks are shared between undo steps, crash copies and saves instead of being copied again; heavy
results (possession, team shape, distances, timelines) are kept until the data changes; calibration look-ups are
cached; the tag list only builds the rows in view; hidden tabs are not redrawn; the track timeline is drawn once per
change; long matches are sampled more coarsely in the Positions tab (same averages).

### Crash recovery and error log
- Every change is copied to a safe place within a second (tracking data at least every 8 s). After a crash, a power
  cut or "End task", the next start says *TACTIQ ANALYST did not close properly* and offers **↻ Restore my work**.
  If the window itself crashes it reloads and offers the same. Opening a project whose automatic copy is newer than
  the file asks whether to use it.
- Big tracking data is no longer kept in the browser storage (it did not fit there) but in a file.
- A log file (14 days) records start, errors in the window, AI, video conversion and export problems, crashes.
  **Help → 🛠 Troubleshooting**: open the log folder, copy a diagnostic report (version, Windows, memory, graphics,
  last log lines), check for a new version.

### Update check
- Once a day the app asks GitHub for the latest release and shows a bar with **Download** when there is a newer one
  (Settings → General to turn it off).

### Tested on Windows in every build
- The Windows build now installs the new version silently and runs an end-to-end smoke test on the *installed* app
  before publishing it: start, new project, playing video, tagging by key / typing / phase, **voice tagging with the
  offline model** (spoken commands fed in as a microphone), saving, screenshot, highlight video, PDF report, AI
  engine, camera-shot scan, 3D view and 3D MP4, memory, update check, clean close, reopening, crash recovery, and
  opening MTS / AVI / WEBM. The installer is only published when every check passes.

### User guide and tutorials
- A 21-page step-by-step user guide (PDF) and two short tutorial videos (tagging a match; from AI tracking to a 3D
  replay).

### Fixes
- The 3D window no longer sticks out of a small video area.
- Opening a project no longer leaves a stray copy of it as a "quick session".

## 2.6.0 – roadmap phase 0.9: 3D tactical view

A 3D pitch with the tracked players and the ball, built from the 2D tracking data. Tested in the real desktop app:
32 new automated checks (synthetic match with exact positions, and real AI tracking on broadcast footage), plus the
full regression suite.

### New
- **🧊 3D view** under the video: follows the video frame by frame; every figure stands exactly on its 2D pitch
  position (checked to the centimetre); estimated positions are faded; nothing is shown where there is no
  calibration or in close-ups, with a clear message. Sizes S / M / L / full video area.
- **Cameras:** TV camera that follows the play, tactical (whole pitch), top-down, behind either goal, player view
  (through the eyes of the selected track, looking at the ball) and free camera (drag to turn, right-drag to move,
  wheel to zoom).
- **Overlays:** names, trails, team shape (outfield outline), team lines (defence / midfield / attack), and tags at
  their pitch location with an arc to the end point (passes, shots); recent tags also appear as captions.
- **🎬 3D replay:** a tag, the last N seconds or any range, from any camera, at ¼× to 2×, with play/pause, slider,
  loop and Esc back to the video. Also from the tag editor (**🧊 3D replay**).
- **MP4 export** of a 3D replay (1280 × 720 or 1920 × 1080, 25 / 30 fps, H.264), rendered frame by frame so the
  video is smooth even on a slow PC; captions with teams, match clock and tags; cancel at any time.
  Test: 4 s → exactly 121 frames / 4.03 s; ½× slow motion of 2 s → 4 s.
- **📷 3D picture** at 1920 × 1080.
- Quality setting (Auto / Light / High): Auto chooses Light on PCs with 8 GB or 2 cores. The 3D library (three.js,
  MIT licence) loads only when the 3D view is first opened. If the PC has no usable graphics driver for 3D, the app
  falls back to software rendering.
- The 2D window now always stays on top of the 3D window.

## 2.5.0 – roadmap phase 0.8: broadcast footage support

TV / broadcast footage cuts between the main camera, close-ups, replays and crowd shots. 2.5.0 handles this.
Tested in the real desktop app with a 21 s broadcast-style clip (wide – close-up – slow replay – wide – crowd):
39 automated checks, plus the full regression suite.

### New
- **📺 Scan camera shots** (Track tab): finds every camera cut and recognises each shot as wide, medium, close-up or
  other (crowd, bench, graphics). Test clip: all 4 cuts found within one frame, all shot types right; about 2.5×
  real time on 2 processor cores. The scan also measures the camera movement of the whole video, so calibrations
  follow the camera everywhere, not only where the AI ran.
- **Shot list** with a coloured strip (and a bar showing where the pitch is calibrated): change a shot's type, mark
  replays (a slow-motion replay from the main camera can't be told apart automatically), **⤒ join** a wrongly found
  cut, 🎯 calibrate a shot, **🎯 Calibrate next shot** jumps to the next wide shot that still needs a calibration.
- **Segment-based calibration:** a calibration never continues across a camera cut, and close-ups, replays and other
  shots never get one (positions there are not placed on the pitch instead of being placed wrongly).
- **AI on wide shots only:** 🤖 Auto-detect can skip close-ups, replays and other shots (runs the wide / medium
  shots one after another). The AI's own cut detection refines the shot boundaries to the exact frame.
- **Identity across cuts:** tracks always end at a cut and are never joined automatically across one. A track that
  starts after a cut is marked "after cut"; the editor lists who it may be from before the cut (nearest by pitch
  position) – one click joins, Ctrl+Z undoes.
- **Partial pitch view:** the 2D view darkens the part of the pitch that is not in the picture and shows the share in
  view. The Positions tab and PDF report state how much of the pitch was visible on average, warn when players were
  at the edge of the picture (team width / length then probably underestimated), and say how much of the video was
  usable camera footage. Close-ups and replays are left out of team shape, distance and heat maps.

## 2.4.0 – full end-to-end test with the Spain v England clips, bug fixes, calibration that follows the camera

Tested by driving the real desktop app (Electron, real ffmpeg, real AI engine, real offline voice model fed with
synthesised speech) through every feature with the uploaded clips: 97 automated checks.

### Fixed
- **Critical:** in the installed app the start-up script stopped with "Identifier 'api' has already been declared"
  (the browser test fallback re-declared the bridge from preload.js). Depending on the version the dashboard,
  code buttons and most features did not work. The bridge is now only created when it is missing.
- Start-up: the last project was silently loaded as a "quick session" without video; the app now always opens on
  the dashboard, projects keep their own crash-safety copy, and an unsaved quick session is offered as
  "Continue last session". The quick-session button says "Back to <project>" when a project is open.
- Undo after ending a phase (e.g. "build up" … "build up", then "undo") removed the whole phase; it now goes back
  to "running".
- Voice: a control word straight after a command ("left back cross … undo") is now carried out; a fragment the
  engine could not make out ("right [unk]") no longer changes the previous tag.
- Voice: a bare shirt number is understood ("nine shot on target", "twenty three pass"), as the documentation said,
  unless the word is needed elsewhere ("one" = "won").
- Ctrl+S now saves while the cursor is in the command bar or a field.
- Backups: the newest backup is preselected, so Restore works straight away.
- Season tab and Open dialogs accept .tactiq project files.
- Short gaps between AI points (the AI looks at every 2nd frame) were counted as "estimated": the ball panel showed
  30% found instead of 50%, markers flickered dashed/solid while playing, and heat maps weighted them down.
  Only gaps over 0.3 s count as estimated now.
- Remaining "VoiceTag" texts on screen renamed.
- Windows build now checks that the bundled ffmpeg reads and converts MTS (camcorder) and AVI files.

### Improved
- **Calibration that follows the camera.** The AI engine measures the camera pan for every analysed frame and
  detects camera cuts. A calibration is carried along with the pan (and backwards before the first one), and between
  two calibrations both are carried and blended. Spain v England test, 3 s and 13% of a frame width away from the
  calibration: error 9.2 m → 2.3 m with one calibration, 0.9 m with two (5 s apart); the share of usable
  (calibrated) time in the Positions tab went from 10–40% to 100%. Error estimate shown in the Track and Positions tabs;
  carrying stops at cuts and beyond 4 m estimated error.
- **Calibration assistant:** a new calibration starts with the landmarks already placed from the camera movement.

## 2.3.0 – roadmap phases 0.6 (hybrid tracking editor) and 0.7 (2D analytics)

### 0.6 – correct AI tracking without losing the AI result
- A corrected AI point keeps the original AI position (`orig`); deleted AI points are kept in `removed`;
  every change goes into a corrections log (📝 Corrections, click a row to jump). The raw AI runs stay in tracking_data/.
- ↺ AI position here, ↺ Restore AI track, "show AI originals" (magenta ring + line on the video).
- Track timeline: one row per track showing AI / unsure AI / by hand / corrected / estimated / missing; click to select and jump.
- Track continuation: when a track ends the likely continuations are listed (predicted position, time gap, kit colour,
  team); click to join. ⏭ Next track end; 🔗 Auto-link broken tracks joins clear, mutual cases (undoable).
- ⇆ Swap with… from here for ID switches; join / split moved into the selected-track box; ⏭ Next gap for any track.
- Quick identity: "Who is …?" box, or say / type "this is nine" (number words, names and positions work).
- Goalkeeper recognition: an "other" track that stays in a penalty area becomes the keeper of the team defending that goal
  (also an option when importing AI results; needs a calibration).

### 0.7 – 2D analytics (new Positions tab)
- Selection: team; all / 1st half / 2nd half / in or out of possession (estimate) / during tags of a phase code;
  whole video or clip IN–OUT; attacking direction auto (team nearer a goal defends it; keeper used if known) or set by hand.
- Team shape per moment (7+ outfield players): width, length, defensive line height, distance between the three lines
  (1-D k-means), convex-hull area, average distance to the centre; averages plus a chart over time.
- Average positions with the team outline and defensive line; confidence-weighted heat map (team or one player).
- Distance and speed per player from keyframes only: split at gaps and calibration changes, smoothed over 1 s,
  measured every 0.4 s, impossible jumps dropped. Distance, m/min, max speed, high-intensity metres (≥19.8 km/h),
  sprints (≥25.2 km/h for 1 s+), quality badge. Synthetic test with noise: distance within 1–2%, max speed within 3%.
- Ball path map and ball location by thirds.
- Data quality box on every view: time selected, share calibrated, players located, estimated and unsure-AI shares, warnings.
- Positional CSV export; positional pages in the PDF match report (report also possible with tracking but no tags).
- 2D view: show all / home / away / ball / selected, trail length 2–20 s.

## 2.2.0 – roadmap phase 0.5: AI ball tracking

- **Zoomed second look for the ball**: after the normal pass the AI zooms in (2.2×, using the full-resolution
  frame) where the ball should be – its predicted path, or where most players are – and looks again.
  On the Spain v England test clips the ball was found in 58% instead of 46%, and 41% instead of 25%, of the frames,
  with almost no false positives in a visual check of 60 samples. About 2× slower; can be switched off.
- **Spare balls and logos ignored**: the engine measures the camera pan, so an object that stays put on the pitch
  for 2 s with no player near it is recognised as a spare ball / logo, not the match ball.
- The ball path is judged against real players only (not stewards or camera operators).
- **Exact frame times**: the engine now reads every frame's real timestamp. Many videos have a slightly variable
  frame rate; before, AI positions could be up to a frame off in these clips and drift by seconds over a full match.
- **Ball timeline** in the Track tab: found / estimated (gaps up to 1 s) / missing, plus a possession strip; click to jump.
- **⏭ Next ball gap** and **🎯 Fix ball by clicking** (0.5× speed, every click while playing adds a point).
  Clicking while the video plays now always adds a point instead of jumping ahead.
- **Possession estimate** (Stats tab and Track tab) from ball + player tracking: owner = nearest player within 2 m
  (calibrated) or ~3% of the picture width; a change needs 0.4 s of control; time with an unknown owner is shown.
- **Ball position as tag location** (option): new tags get the ball's pitch position automatically.
- **Ball heatmap** in the Maps tab; the tracking heatmap no longer mixes in the ball.
- Fixed: re-running the AI on a new range deleted earlier AI ball points outside that range.

## 2.1.0 – roadmap phase 0.4: AI player detection & tracking

- **🤖 Auto-detect players** (Track tab): finds every person on the pitch with a YOLO11 detector, follows
  them frame to frame (ByteTrack-style tracker with camera-pan compensation) and splits them into the two
  teams by shirt colour. Referees, goalkeepers and staff go to “Other”.
- Runs fully offline in a background process (no internet, no Python). Uses the graphics card through
  DirectX 12 (DirectML) when possible, otherwise the processor.
- Two models: **Fast** (yolo11n – default on 8 GB PCs) and **Accurate** (yolo11s – default on 12 GB+).
  Analyse every frame, every 2nd, 3rd or 5th frame.
- Range: from the current moment for N seconds, the clip IN–OUT marks, or the whole video. Progress, time left, cancel.
- Results dialog: kit colour swatches → Home / Away / Other (guessed from the team colours in project details),
  ignore short tracks, drop people off the pitch (with a calibration), import the ball (experimental),
  replace an earlier AI run. The raw result is saved in the project’s `tracking_data/` folder.
- AI tracks are normal tracks: edit, assign squad players, correct points, 2D view, heat maps, exports.
  New correction tools: **⚠ Next unsure point**, **✂ Split selected here**, **⇄ Join selected with…**, remove all AI tracks.
- “tracks on video” option shows the tracks while the video plays (view only) without turning tracking mode on.
- Tracking CSV has a new `ai_confidence` column.
- Test clips (Spain v England) in `testdata/clips/`. On a 2-core cloud machine the Fast model ran at about
  4 frames/s on the processor alone; a normal Windows PC, and especially a graphics card, is faster.

## 2.0.0 – roadmap phases 0.1, 0.2 and 0.3 (VoiceTag becomes TACTIQ ANALYST)

Everything from VoiceTag 1.x is kept: voice tagging with your own commands, code window, phases,
live mode, match clock, squad & substitutions, pitch locations, maps, drawings, playlists and video
export, PDF report, season database, templates, Sportscode XML import, any video format.

### Phase 0.1 – foundation
- Dashboard (🏠): recent projects with search, new project, open project, quick session, system check
  (Windows version, RAM → Light mode on 8 GB, Standard mode on 12 GB+).
- Projects are folders: `project.tactiq` + `videos/ clips/ tracking_data/ calibration/ reports/ screenshots/ backups/`.
  Autosave every minute, backup every 10 minutes (last 20 kept), safe writes, restore a backup (File menu).
  Missing video → you are asked to locate it (relink). Double-click a `.tactiq` file to open it.
- Project details: teams, team colours, date, season, competition, venue, match type, length, periods,
  video source, analyst, notes, pitch size.
- Player: stop, frame-by-frame using the video’s real frame rate (`,` `.`), frame number, 0.25×–4× speed,
  volume / mute, full screen, screenshot (saved into the project), video information (resolution, fps, codecs, warnings).
- Team for new tags: Home / Away / Neutral.
- Undo **and redo** for everything (Ctrl+Z / Ctrl+Y), including tracking and calibration.
- New default codes matching the blueprint shortcuts (B, L, F, C, S, G, H, M, O, I, T, U, A, K …), grouped by category.
  Existing users keep their own buttons – load the new set via Settings → Templates → “Own team – match”.
- Voice on/off moved from **M** to **F9** (M is now Mid Block).

### Phase 0.2 – advanced video analysis
- Full event editor (✎): code, team, player, outcome, times, period, location, labels, notes; duplicate; delete.
- Clip In / Out (`[` `]`) and ✂ Clip: named clips with team, player, linked event and description.
  Playlist → “Saved clips”: watch and export them (one video, separate files, per player).
- Timeline shows period starts/ends, clip In/Out and saved clips.

### Phase 0.3 – manual 2D tracking (no AI needed)
- Track tab: tracks for squad players, unknown home/away players, ball, referees. Re-assign identity, team, colour.
- Click a player’s feet to set a keyframe; the video jumps forward by your step (1 f, 5 f, 10 f, 0.5 s, 1 s, 2 s).
  Drag to move, right-click / Delete to remove, Tab to switch track, Enter / Backspace to step.
- Visibility marks: occluded, out of frame, unknown. Interpolation only between two visible keyframes within the
  max gap (default 3 s), drawn dashed and exported as “interpolated”; can be turned off globally or per track.
- Pitch calibration (homography) from 4+ landmarks with quality check (error in metres), projected pitch lines
  as a check, segment-based: each calibration is valid until the next; optional smooth blend for slow pans;
  ⛔ marks for close-ups / replays / cuts.
- 🗺 2D pitch view with team colours, numbers and trails, synced with the video.
- Maps: tracking heatmap and average positions (estimates from video, not GPS).
- Export tracking CSV (keyframes or 5 / 10 / 25 rows per second) and JSON, with image and pitch coordinates,
  source (manual / interpolated) and visibility.

### Known limitations
- No AI detection yet (phase 0.4+). Tracking is manual.
- Windows 10 / 11 (64-bit) only.
- One video per project for now (multi-angle sync is planned later).
- The installer is not code-signed, so Windows SmartScreen shows a warning on first install.

### Next
- 0.4 AI player detection & tracking (CPU and GPU; Light mode for 8 GB), 0.5 ball detection,
  0.6 hybrid correction editor (split / merge tracks, correction history).
