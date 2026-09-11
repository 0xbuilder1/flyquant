/**
 * The fly, running.
 *
 * A leaky integrate-and-fire simulation of MaleCNS v1.0, over the graph that build-graph.py wrote.
 * 165,836 neurons, 6.2M edges, no dependencies, no Python, no floats hidden in an object graph —
 * six typed arrays and a loop.
 *
 * TWO PROPERTIES THIS FILE EXISTS TO PROTECT
 *
 * 1. DETERMINISM. Same stimulus, same seed, same spikes, to the bit. Every trade the keeper makes
 *    records the stimulus and the seed, and anybody who downloads MaleCNS can replay it and get
 *    the same neurons. That is the difference between a checkable claim and a story, and it is why
 *    the PRNG here is a seeded xorshift and not Math.random().
 *
 * 2. THE DYNAMICS ARE NOT OURS. Equations, constants and the delay all come from params.js, which
 *    cites its source. This file may optimise how they are computed and may never change what is
 *    computed. The propagator is exact rather than Euler for exactly that reason.
 *
 * Cost is ~10k steps per simulated second, and each step touches only the ACTIVE set — neurons
 * that have been pushed off rest and not yet decayed back. A quiet fly is nearly free; a fly with
 * its whole optic lobe lit up is a few seconds of CPU per simulated second. The keeper trades on a
 * loop measured in minutes, so this is comfortably the cheap half of a pass.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./params.js');

const EPS = 1e-4;       // mV below which a neuron is back at rest and leaves the active set

/** xorshift128+, seeded. Deterministic across platforms because it is integer-only. */
function rng(seed) {
  let s0 = (seed ^ 0x9e3779b9) >>> 0 || 1;
  let s1 = (seed * 0x85ebca6b + 0x165667b1) >>> 0 || 2;
  return function next() {
    let x = s0, y = s1;
    s0 = y;
    x ^= x << 23; x >>>= 0;
    x ^= x >>> 17;
    x ^= y ^ (y >>> 26); x >>>= 0;
    s1 = x;
    return ((s0 + s1) >>> 0) / 4294967296;
  };
}

class Brain {
  /** Load the graph built by build-graph.py. Nothing here allocates per-pass. */
  static load(dir) {
    dir = dir || path.join(__dirname, 'graph');
    const rd = (f) => {
      const b = fs.readFileSync(path.join(dir, f));
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    };
    const view = (f, Type) => {
      const u = rd(f);
      // .slice() rather than a view over Buffer's pooled memory: Node's small-Buffer pool does not
      // guarantee the byte offset is aligned for Int32Array and an unaligned view throws.
      return new Type(u.slice().buffer);
    };
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
    return new Brain({
      manifest,
      offsets: view('offsets.bin', Int32Array),
      targets: view('targets.bin', Int32Array),
      weights: view('weights.bin', Uint16Array),
      sign: new Int8Array(rd('sign.bin').slice().buffer),
      bodies: view('bodies.bin', BigInt64Array),
      types: JSON.parse(fs.readFileSync(path.join(dir, 'types.json'), 'utf8')),
      classes: JSON.parse(fs.readFileSync(path.join(dir, 'classes.json'), 'utf8')),
    });
  }

  constructor(g) {
    Object.assign(this, g);
    this.n = this.sign.length;
    if (this.offsets.length !== this.n + 1) throw new Error('graph: offsets do not match neuron count');
    if (this.targets.length !== this.weights.length) throw new Error('graph: targets/weights disagree');

    // state
    this.u = new Float32Array(this.n);        // membrane potential, mV ABOVE rest
    this.g = new Float32Array(this.n);        // synaptic conductance, mV
    this.rfc = new Int32Array(this.n);        // steps of refractory remaining
    this.spikes = new Uint32Array(this.n);    // spike count this run

    // active set
    this.active = new Int32Array(this.n);
    this.isActive = new Uint8Array(this.n);
    this.nActive = 0;

    // delay ring: spikes emitted DELAY_STEPS ago are delivered now
    this.ring = [];
    for (let i = 0; i < P.DELAY_STEPS; i++) this.ring.push({ buf: new Int32Array(1024), n: 0 });
  }

  /** neuron indices carrying a MaleCNS cell type, e.g. 'DNp01'. Throws rather than returning [] —
      a channel naming a type that does not exist is a config bug and must not fail silently. */
  ofType(t) {
    const v = this.types[t];
    if (!v || !v.length) throw new Error(`no neuron of type ${t} in this graph`);
    return v;
  }

  ofClass(c) {
    const v = this.classes[c];
    if (!v || !v.length) throw new Error(`no neuron of class ${c} in this graph`);
    return v;
  }

  _reset() {
    this.u.fill(0); this.g.fill(0); this.rfc.fill(0); this.spikes.fill(0);
    this.isActive.fill(0); this.nActive = 0;
    for (const b of this.ring) b.n = 0;
  }

  _activate(i) {
    if (this.isActive[i]) return;
    this.isActive[i] = 1;
    this.active[this.nActive++] = i;
  }

  _emit(bucket, i) {
    if (bucket.n === bucket.buf.length) {
      const grown = new Int32Array(bucket.buf.length * 2);
      grown.set(bucket.buf);
      bucket.buf = grown;
    }
    bucket.buf[bucket.n++] = i;
  }

  /**
   * Run the fly for `ms` of its own time.
   *
   * stim: [{ neurons: number[], rateHz }] — Poisson injection, exactly the mechanism Shiu et al.
   * stimulate with: each hit adds W_SYN * F_POI to g, which is large enough that a targeted neuron
   * fires. The RATE is the signal; the weight is not a dial.
   *
   * Returns { spikes, steps, ms, seed, raster? } where spikes[i] is neuron i's count.
   */
  run({ stim = [], ms = 1000, seed = 1, raster = null, chunkMs = 10 } = {}) {
    this._reset();
    const rand = rng(seed);
    const steps = Math.round(ms / P.DT);
    const { offsets, targets, weights, sign, u, g, rfc } = this;
    const wSyn = P.W_SYN, eM = P.E_M, eS = P.E_S, K = P.K, uTh = P.U_THRESH, rfcSteps = P.RFC_STEPS;
    const inject = wSyn * P.F_POI;

    // Stimulus may be a fixed list or a FUNCTION of time. The function form is what makes a looming
    // stimulus possible: looming is not a signal you inject into a looming detector, it is a patch
    // of the visual field that gets bigger, and the connectome is what turns one into the other.
    // It also allows closed loop — the arena reacting to what the fly has just done.
    const chunkSteps = Math.max(1, Math.round(chunkMs / P.DT));
    const dynamic = typeof stim === 'function';
    let chNeurons = [], chP = [];

    const bind = (list) => {
      chNeurons = []; chP = [];
      for (const s of list || []) {
        if (!s || !s.neurons || !s.neurons.length) continue;
        const p = (s.rateHz || 0) * P.DT / 1000;
        if (p <= 0) continue;
        if (p >= 1) throw new Error(`stimulus rate ${s.rateHz}Hz exceeds one spike per ${P.DT}ms step`);
        chNeurons.push(s.neurons instanceof Int32Array ? s.neurons : Int32Array.from(s.neurons));
        chP.push(p);
      }
    };
    bind(dynamic ? stim({ ms: 0, step: 0, brain: this }) : stim);

    const cap = raster ? (raster.capacity || 200000) : 0;
    const rT = cap ? new Int32Array(cap) : null;
    const rI = cap ? new Int32Array(cap) : null;
    let rN = 0;

    for (let step = 0; step < steps; step++) {
      // 0. re-read the world. The arena only changes on a chunk boundary, so the hot loop rebinds
      //    at most once every chunkMs and the cost stays in the edges where it belongs.
      if (dynamic && step > 0 && step % chunkSteps === 0) {
        bind(stim({ ms: step * P.DT, step, brain: this, spikes: this.spikes }));
      }

      // 1. deliver what was emitted DELAY_STEPS ago. on_pre is `g += w`, and it applies during
      //    refractory too — Brian2 does not gate synapses on refractoriness, only integration.
      const bucket = this.ring[step % P.DELAY_STEPS];
      for (let k = 0; k < bucket.n; k++) {
        const src = bucket.buf[k];
        const s = sign[src];
        if (s === 0) continue;                 // transmitter unpredicted: presynaptically silent
        const w = s * wSyn;
        const end = offsets[src + 1];
        for (let e = offsets[src]; e < end; e++) {
          const t = targets[e];
          g[t] += w * weights[e];
          this._activate(t);
        }
      }
      bucket.n = 0;

      // 2. inject
      for (let c = 0; c < chNeurons.length; c++) {
        const list = chNeurons[c], p = chP[c];
        for (let k = 0; k < list.length; k++) {
          if (rand() < p) { const i = list[k]; g[i] += inject; this._activate(i); }
        }
      }

      // 3. integrate the active set, spike, and drop whoever has decayed back to rest
      let write = 0;
      for (let k = 0; k < this.nActive; k++) {
        const i = this.active[k];
        if (rfc[i] > 0) {
          // held at reset. g still accumulates from step 1 but does not decay, per the model.
          rfc[i]--;
          this.active[write++] = i;
          continue;
        }
        const gi = g[i];
        const ui = u[i] * eM + gi * K;
        g[i] = gi * eS;
        if (ui > uTh) {
          u[i] = 0;                 // v = v_rst
          g[i] = 0;                 // reset clears g
          rfc[i] = rfcSteps;
          this.spikes[i]++;
          this._emit(bucket, i);    // bucket is now the slot for step + DELAY_STEPS
          if (rN < cap) { rT[rN] = step; rI[rN] = i; rN++; }
          this.active[write++] = i;
          continue;
        }
        u[i] = ui;
        if (ui < EPS && ui > -EPS && g[i] < EPS && g[i] > -EPS) {
          this.isActive[i] = 0;     // back at rest; costs nothing until something wakes it
          continue;
        }
        this.active[write++] = i;
      }
      this.nActive = write;
    }

    const out = { spikes: this.spikes, steps, ms, seed };
    if (cap) out.raster = { t: rT.subarray(0, rN), i: rI.subarray(0, rN), truncated: rN >= cap };
    return out;
  }

  /** mean firing rate in Hz over a finished run, for a set of neurons */
  rateOf(neurons, ms) {
    let total = 0;
    for (const i of neurons) total += this.spikes[i];
    return (total / neurons.length) / (ms / 1000);
  }
}

module.exports = { Brain, rng };
