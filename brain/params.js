/**
 * The published constants. Every one of them is Shiu et al.'s, verbatim.
 *
 *   Shiu, Sterne, Spiller et al., "A leaky integrate-and-fire computational model based on the
 *   connectome of the entire adult Drosophila brain reveals insights into sensorimotor processing"
 *   — model.py in github.com/philshiu/Drosophila_brain_model.
 *
 * NOTHING IN THIS FILE MAY BE TUNED TO IMPROVE TRADING. See DESIGN.md. A time constant chosen
 * because it made the fly more profitable turns this from a fly into a trading bot wearing one,
 * and every sentence on the site into a lie. Changing a value here requires a citation for the new
 * value, in the commit that changes it.
 *
 * Units are millivolts and milliseconds throughout, because the source is and a unit conversion in
 * the middle is a bug waiting for a decimal point.
 */
'use strict';

const params = {
  V_REST: -52,      // v_0   resting potential, mV
  V_RESET: -52,     // v_rst potential after a spike, mV
  V_THRESH: -45,    // v_th  spike threshold, mV — 7 mV above rest
  T_MBR: 20,        // t_mbr membrane time constant, ms
  TAU: 5,           // tau   synaptic conductance time constant, ms
  T_RFC: 2.2,       // t_rfc refractory period, ms
  T_DLY: 1.8,       // t_dly synaptic delay, ms
  W_SYN: 0.275,     // w_syn millivolts of g per SYNAPSE. Edge weight = w_syn * synapse count.
  F_POI: 250,       // f_poi scaling on injected (Poisson) input, so a stimulated neuron does fire
  R_POI: 150,       // r_poi default injection rate, Hz

  DT: 0.1,          // integration step, ms. Brian2's default, and what the above were fitted with.
};

// Derived once. The propagators below are the EXACT solution of the two-variable linear system
// over one step, not a forward-Euler approximation of it:
//
//   dv/dt = (v_0 - v + g) / t_mbr        du/dt = -u/t_mbr + g/t_mbr   with u = v - v_0
//   dg/dt = -g / tau                     g(t)  = g0 * exp(-t/tau)
//
// giving  g' = g*E_S  and  u' = u*E_M + g*K  with  K = tau*(E_S - E_M)/(tau - t_mbr).
// Euler at dt=0.1ms would be close, but "close" accumulates over 10,000 steps a second and the
// whole claim of this product is that a replay reproduces the spikes bit for bit.
params.E_M = Math.exp(-params.DT / params.T_MBR);
params.E_S = Math.exp(-params.DT / params.TAU);
params.K = (params.TAU * (params.E_S - params.E_M)) / (params.TAU - params.T_MBR);

params.DELAY_STEPS = Math.round(params.T_DLY / params.DT);   // 18
params.RFC_STEPS = Math.round(params.T_RFC / params.DT);     // 22
params.U_THRESH = params.V_THRESH - params.V_REST;           // 7 mV, since u is measured from rest

module.exports = params;
