# What is covered by what

The **code** in this repository is MIT (see `LICENSE`). The two things it is built on are not
ours, and neither is covered by that licence.

## The connectome

**MaleCNS v1.0** — the complete central nervous system of an adult male *Drosophila melanogaster*.
Janelia FlyEM Project Team, the Cambridge Drosophila Connectomics Group (MRC LMB), and the
Connectomics group at Google. Released 2026-09-03 under **CC BY 4.0**.

Attribution is a condition of that licence, not a courtesy. It appears in `brain/graph/graph.json`,
on the site, and in `brain/build-graph.py`, and it must survive any fork. The raw `.feather` files
are not redistributed here — `brain/build-graph.py` fetches them and the README says from where.

FlyWire (the older, female-brain dataset) is **CC BY-NC** and is deliberately not used anywhere in
this project.

## The dynamics

The leaky integrate-and-fire model and every constant in `brain/params.js` follow Shiu, Sterne,
Spiller et al., *"A leaky integrate-and-fire computational model based on the connectome of the
entire adult Drosophila brain reveals insights into sensorimotor processing."* The values are
theirs, cited in the file, and may not be changed without a citation for the new ones.

## Market data

`backtest/data/lighter-hourly.csv` is recorded observations of a public exchange API — marks,
volumes, ranges and best quotes. Facts about a market, not anybody's work product.

## What this is not

This is not financial advice, not a product, and not a promise that anything here makes money. It
is a wiring diagram from a real animal, a simulation of it, and a trading account. Running it with
your own funds is entirely your risk.
