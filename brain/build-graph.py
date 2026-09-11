#!/usr/bin/env python3
"""
MaleCNS v1.0  ->  the binary the keeper memory-maps.

Run once. It reads the three files in brain/data/ and writes brain/graph/, and it is the ONLY
place in this repo that touches a .feather or needs Python. Everything downstream is Node reading
typed arrays, which is why the keeper has no Python dependency and no Arrow dependency.

    python brain/build-graph.py

WHAT IT DECIDES, AND WHY EACH DECISION IS HERE RATHER THAN IN THE SIMULATION

1. MIN_WEIGHT = 5 synapses. 62% of the 151.9M edges in this dataset are SINGLE synapses, which is
   where reconstruction error concentrates; the standard cut in the literature is 5 and it takes
   the graph to ~7.6M edges. The cut is applied once, here, and the surviving count is written to
   graph.json so the site prints the number that was actually built rather than a rounder one.

2. Sign comes from the PRESYNAPTIC cell's consensus neurotransmitter prediction, never from the
   edge. Acetylcholine excites; GABA and glutamate inhibit; the aminergics (dopamine, octopamine,
   serotonin) are treated as excitatory, following Shiu et al. (2024). A neuron whose transmitter
   was not predicted is counted and reported, never silently assumed.

3. CSR indexed BY SOURCE. The simulation is event-driven: when a neuron spikes it needs its
   outgoing edges and nothing else. Any other layout makes the hot loop chase pointers.

Attribution, required by CC BY and by the honesty guard: MaleCNS v1.0, Janelia FlyEM /
Cambridge Drosophila Connectomics Group / Google Connectomics, released 2026-09-03.
"""
import json
import os
import sys
import time

import numpy as np
import pyarrow as pa
import pyarrow.feather as feather

MIN_WEIGHT = 5

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
OUT = os.path.join(HERE, 'graph')

# consensus_nt -> sign. Anything absent from this table is an unknown and is COUNTED, not guessed.
NT_SIGN = {
    'acetylcholine': 1,
    'gaba': -1,
    'glutamate': -1,
    # histamine is INHIBITORY in Drosophila and is what photoreceptors release. Leaving it out of
    # this table does not throw — it silently blinds the fly, which is the single worst outcome for
    # a product whose sell signal is a looming stimulus.
    'histamine': -1,
    'dopamine': 1,
    'octopamine': 1,
    'serotonin': 1,
    # 'unclear' is a real value in this dataset and stays out on purpose: it means the classifier
    # could not call it, and a coin flip in the sign of 85k neurons is not a prediction.
}


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def read_universe():
    """The neurons. NOT every body in the weights file.

    The flat connectome is keyed by segmentation body, and most bodies are not neurons: they are
    unproofread fragments and glia. Taking every body with a surviving edge gives 1.44M "neurons",
    which is nine times the size of the animal and would have been a number on the website. The
    real population is the annotated bodies carrying a superclass — ol_intrinsic, cb_intrinsic,
    descending_neuron and the rest — which comes to the ~166k the paper reports."""
    ann = feather.read_table(os.path.join(DATA, 'body-annotations.feather'),
                             columns=['bodyId', 'type', 'class', 'superclass', 'somaSide']).to_pydict()
    keep = {}
    for body, ty, cl, sc, side in zip(ann['bodyId'], ann['type'], ann['class'],
                                      ann['superclass'], ann['somaSide']):
        if sc:                       # no superclass == not a reconstructed neuron
            keep[int(body)] = (ty, cl, sc, side)
    return keep, len(ann['bodyId'])


def read_edges(universe):
    """Stream the 1.1GB weights file, keeping only edges at or above the cut whose BOTH endpoints
    are neurons.

    Batched on purpose: the full table is 151.9M rows x 20 bytes and materialising it costs ~3GB
    for data that is 95% about to be thrown away."""
    path = os.path.join(DATA, 'connectome-weights.feather')
    src = pa.ipc.open_file(pa.memory_map(path))
    members = np.fromiter(sorted(universe), dtype=np.int64)
    pre, post, wt = [], [], []
    total = 0
    dropped_nonneuron = 0
    for i in range(src.num_record_batches):
        b = src.get_batch(i)
        w = b.column('weight').to_numpy(zero_copy_only=False)
        total += len(w)
        keep = w >= MIN_WEIGHT
        if not keep.any():
            continue
        a = b.column('body_pre').to_numpy(zero_copy_only=False)[keep]
        z = b.column('body_post').to_numpy(zero_copy_only=False)[keep]
        w = w[keep]
        both = np.isin(a, members) & np.isin(z, members)
        dropped_nonneuron += int((~both).sum())
        pre.append(a[both]); post.append(z[both]); wt.append(w[both])
    return (np.concatenate(pre), np.concatenate(post), np.concatenate(wt), total, dropped_nonneuron)


def main():
    if not os.path.isdir(DATA):
        sys.exit(f'no {DATA} — see brain/README.md for the three files to fetch')
    os.makedirs(OUT, exist_ok=True)

    log('reading annotations')
    universe, ann_rows = read_universe()
    log(f'{len(universe):,} reconstructed neurons, out of {ann_rows:,} annotated bodies')

    log('reading edges')
    pre, post, wt, total_edges, dropped_nonneuron = read_edges(universe)
    log(f'{len(wt):,} neuron-to-neuron edges at >={MIN_WEIGHT} synapses, out of {total_edges:,}; '
        f'{dropped_nonneuron:,} above the cut had an endpoint that is not a reconstructed neuron')

    # A neuron whose every partner was below the cut has no edges left. It is not in the simulation
    # and saying so is more honest than carrying it as an island.
    bodies = np.unique(np.concatenate([pre, post]))
    log(f'{len(universe) - len(bodies):,} neurons have no edge at or above the cut and are excluded')
    n = len(bodies)
    log(f'{n:,} neurons')
    if bodies.max() > np.iinfo(np.int64).max:
        sys.exit('body id overflows int64')

    idx_pre = np.searchsorted(bodies, pre).astype(np.int32)
    idx_post = np.searchsorted(bodies, post).astype(np.int32)
    del pre, post

    log('reading neurotransmitters')
    nt = feather.read_table(os.path.join(DATA, 'body-neurotransmitters.feather'),
                            columns=['body', 'consensus_nt']).to_pydict()
    nt_of = {}
    for body, val in zip(nt['body'], nt['consensus_nt']):
        if val is not None:
            nt_of[int(body)] = val.lower()
    del nt

    sign = np.zeros(n, dtype=np.int8)
    nt_counts = {}
    unknown = 0
    for i, body in enumerate(bodies):
        v = nt_of.get(int(body))
        nt_counts[v or 'unpredicted'] = nt_counts.get(v or 'unpredicted', 0) + 1
        s = NT_SIGN.get(v)
        if s is None:
            unknown += 1
            s = 0            # contributes NOTHING. A guessed sign is a guessed decision.
        sign[i] = s
    log(f'signs: {nt_counts}')
    log(f'{unknown:,} neurons have no usable transmitter prediction and are silent presynaptically')

    ann_of = universe

    # type -> the neuron indices carrying it. This is what senses.js and readout.js resolve their
    # channels through, so a channel naming a type that does not exist fails loudly at load.
    types = {}
    classes = {}
    typed = 0
    body_list = bodies.tolist()
    meta_type = [None] * n
    meta_side = [None] * n
    for i, body in enumerate(body_list):
        rec = ann_of.get(body)
        if rec is None:
            continue
        ty, cl, sc, side = rec
        meta_type[i] = ty
        meta_side[i] = side
        if ty:
            typed += 1
            types.setdefault(ty, []).append(i)
        if sc:
            classes.setdefault(sc, []).append(i)
    log(f'{typed:,} neurons carry a cell type, across {len(types):,} distinct types')

    log('building CSR')
    order = np.argsort(idx_pre, kind='stable')
    tgt = idx_post[order].astype(np.int32)
    w = wt[order]
    if w.max() > np.iinfo(np.uint16).max:
        log(f'clamping {int((w > 65535).sum())} edges above 65535 synapses')
        w = np.minimum(w, 65535)
    w = w.astype(np.uint16)
    counts = np.bincount(idx_pre[order], minlength=n).astype(np.int64)
    offsets = np.zeros(n + 1, dtype=np.int64)
    np.cumsum(counts, out=offsets[1:])
    if offsets[-1] > np.iinfo(np.int32).max:
        sys.exit('edge count overflows int32 offsets')
    offsets = offsets.astype(np.int32)

    log('writing')
    with open(os.path.join(OUT, 'offsets.bin'), 'wb') as f:
        f.write(offsets.tobytes())
    with open(os.path.join(OUT, 'targets.bin'), 'wb') as f:
        f.write(tgt.tobytes())
    with open(os.path.join(OUT, 'weights.bin'), 'wb') as f:
        f.write(w.tobytes())
    with open(os.path.join(OUT, 'sign.bin'), 'wb') as f:
        f.write(sign.tobytes())
    with open(os.path.join(OUT, 'bodies.bin'), 'wb') as f:
        f.write(bodies.astype(np.int64).tobytes())
    with open(os.path.join(OUT, 'types.json'), 'w') as f:
        json.dump(types, f)
    with open(os.path.join(OUT, 'classes.json'), 'w') as f:
        json.dump(classes, f)

    manifest = {
        'dataset': 'MaleCNS v1.0',
        'attribution': ('Janelia FlyEM, Cambridge Drosophila Connectomics Group (MRC LMB), '
                        'and Google Connectomics. Released 2026-09-03. CC BY 4.0.'),
        'built': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'minWeight': MIN_WEIGHT,
        'neurons': int(n),
        'neuronsAnnotated': len(universe),
        'edges': int(len(w)),
        'edgesBeforeCut': int(total_edges),
        'edgesDroppedNotNeuron': int(dropped_nonneuron),
        'synapses': int(wt.sum()),
        'typedNeurons': int(typed),
        'distinctTypes': len(types),
        'neurotransmitters': nt_counts,
        'silentPresynaptic': int(unknown),
        'excitatory': int((sign > 0).sum()),
        'inhibitory': int((sign < 0).sum()),
    }
    with open(os.path.join(OUT, 'graph.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
    log('done')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
