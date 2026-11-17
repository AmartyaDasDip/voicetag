# TACTIQ ANALYST – changelog

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
