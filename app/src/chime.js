// Slab's reminder sound: a short rising two-note chime synthesized with Web Audio (no audio files).
let ctx = null;

/** Plays the chime. Resolves to the AudioContext state ('running' if it could play). */
export async function chime() {
  try {
    ctx = ctx || new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const t0 = ctx.currentTime + 0.03;
    const master = ctx.createGain();
    master.gain.value = 0.25;
    master.connect(ctx.destination);
    // A5 then E6, each a quick strike with a soft ring-out.
    for (const [freq, at] of [[880, 0], [1318.5, 0.13]]) {
      const osc = ctx.createOscillator(), env = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0.0001, t0 + at);
      env.gain.exponentialRampToValueAtTime(1, t0 + at + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.55);
      osc.connect(env).connect(master);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.6);
    }
    return ctx.state;
  } catch (e) {
    return 'error';
  }
}
