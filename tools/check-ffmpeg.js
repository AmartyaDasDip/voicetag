// Build check: the bundled ffmpeg must read and convert an MPEG-TS (camcorder .mts) file and an AVI.
const ff = require('ffmpeg-static'), ex = require('../exporter'), { execFileSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-ff-'));
  const make = (name, args) => { const f = path.join(dir, name); execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=duration=2', ...args, f]); return f; };
  const tests = [['test.mts', ['-c:v', 'mpeg2video', '-c:a', 'mp2', '-f', 'mpegts']], ['test.avi', ['-c:v', 'mpeg4', '-c:a', 'mp3']]];
  for (const [name, args] of tests) {
    const f = make(name, args);
    const info = await ex.probe(ff, f);
    if (!info.vcodec || !(info.duration > 1.5)) throw new Error(name + ': ffmpeg could not read it: ' + info.text.slice(-400));
    const out = path.join(dir, name + '.mp4');
    await ex.convertToMp4({ ffmpeg: ff, input: f, output: out, job: {}, onProgress: () => {} });
    const o = await ex.probe(ff, out);
    if (!(o.duration > 1.5) || !o.vcodec) throw new Error(name + ': conversion failed');
    console.log('ffmpeg OK:', name, info.vcodec, info.duration.toFixed(2), 's ->', o.vcodec);
  }
})().catch(e => { console.error('FFMPEG CHECK FAILED:', e.message); process.exit(1); });
