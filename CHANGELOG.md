# TACTIQ ANALYST – changelog

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
