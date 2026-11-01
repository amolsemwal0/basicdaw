// Encoding in the page with ffmpeg.wasm, for when the server has no ffmpeg. Only the Android app ships it (in
// web/vendor/ffmpeg, see android/build.sh); the desktop apps use the server's ffmpeg.
const VENDOR = new URL('../../vendor/ffmpeg/', import.meta.url);
let present = null;
let ffmpeg = null;

export function wasmEncoderAvailable() {
  present ??= fetch(new URL('core/ffmpeg-core.wasm', VENDOR), { method: 'HEAD' }).then((r) => r.ok, () => false);
  return present;
}

/** Runs `ffmpeg -i in.wav <args> out.<ext>` in a worker; resolves with the output file's bytes. */
export async function wasmEncode(wav, args, ext, { onStatus, onProgress } = {}) {
  if (!ffmpeg) {
    onStatus?.('Loading the encoder…');
    const { FFmpeg } = await import(new URL('ffmpeg/index.js', VENDOR).href);
    const ff = new FFmpeg();
    await ff.load({ coreURL: new URL('core/ffmpeg-core.js', VENDOR).href, wasmURL: new URL('core/ffmpeg-core.wasm', VENDOR).href });
    ffmpeg = ff;
  }
  const ff = ffmpeg;
  const out = `out.${ext}`;
  const log = [];
  const onLog = ({ message }) => { log.push(message); if (log.length > 6) log.shift(); };
  const onProg = ({ progress }) => { if (progress >= 0 && progress <= 1) onProgress?.(progress); };
  ff.on('log', onLog);
  ff.on('progress', onProg);
  try {
    await ff.writeFile('in.wav', new Uint8Array(await wav.arrayBuffer()));
    const code = await ff.exec(['-hide_banner', '-loglevel', 'error', '-i', 'in.wav', ...args, out]);
    if (code !== 0) throw new Error(`exit code ${code}`);
    const data = await ff.readFile(out);
    await Promise.all(['in.wav', out].map((f) => ff.deleteFile(f)));
    return data;
  } catch (err) {
    // A crashed worker never answers again (and its files may linger): start a fresh one next time.
    ff.terminate();
    ffmpeg = null;
    throw new Error(`Encoding failed: ${log.join(' / ') || err.message}`);
  } finally {
    ff.off('log', onLog);
    ff.off('progress', onProg);
  }
}
