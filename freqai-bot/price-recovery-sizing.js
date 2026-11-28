'use strict';
const PRICE = .8, TARGET = 2;
const roundDown = n => Math.floor((n + 1e-10) * 100) / 100;
const newState = () => ({ version: 3, active: false, netPnl: 0, awaitingEntryId: null,
  eligibleWindowStart: 0, frozenBaseBudget: null, lastDecision: null });
function plan(s, windowStart, settledCapital) {
  const baseBudget = s.active ? s.frozenBaseBudget : Math.max(0, settledCapital) * .005;
  const ready = s.active && !s.awaitingEntryId && windowStart >= s.eligibleWindowStart;
  const targetNetProfit = ready ? TARGET - s.netPnl : 0;
  const baseShares = roundDown(baseBudget / PRICE);
  const requestedShares = ready ? Math.max(baseShares,
    Math.ceil((targetNetProfit / (1 - PRICE) - 1e-8) * 100) / 100) : baseShares;
  return { baseBudget, baseShares, requestedShares, targetNetProfit, role: ready ? 'RECOVERY' : 'BASE',
    phase: !s.active ? 'BASE' : s.awaitingEntryId ? 'WAITING_RESULT' : 'RECOVERY_READY',
    reason: ready ? `Recover actual cycle losses plus $2; base budget frozen at $${baseBudget.toFixed(4)}.`
      : s.active ? `Recovery awaiting eligibility/result; base budget stays $${baseBudget.toFixed(4)}.`
      : 'Base purchase budget is 0.5% of settled capital; no model signal required.' };
}
function recordAttempt(s, entry, choice) {
  Object.assign(entry, { recoveryRole: choice.role, baseBudget: choice.baseBudget,
    recoveryTargetNetProfit: choice.targetNetProfit });
  if (choice.role === 'RECOVERY') s.awaitingEntryId = entry.id;
}
function applyOutcome(s, entry, outcome, source, now) {
  if (entry.sizingOutcome) return false;
  if (!['WIN', 'LOSS'].includes(outcome) || !Number.isFinite(entry.realizedPnl)
    || !['RESOLVED_WIN', 'RESOLVED_LOSS'].includes(entry.status))
    throw new Error('Recovery requires a fully closed, reconciled position.');
  const pnl = entry.realizedPnl;
  Object.assign(entry, { sizingOutcome: outcome, sizingSource: source,
    sizingDecidedAt: now, sizingNetPnl: pnl });
  if (s.awaitingEntryId === entry.id) s.awaitingEntryId = null;
  if (s.active || pnl < 0) {
    if (!s.active) s.frozenBaseBudget = entry.baseBudget;
    s.active = true; s.netPnl += pnl;
    s.eligibleWindowStart = Math.max(s.eligibleWindowStart, entry.windowEnd);
    if (s.netPnl >= TARGET - 1e-8) {
      Object.assign(s, { active: false, netPnl: 0, frozenBaseBudget: null });
      entry.sizingEffect = 'RECOVERED_PLUS_2_RESET_TO_CAPITAL_BASE';
    } else entry.sizingEffect = 'RECOVER_ACTUAL_LOSSES_PLUS_2_NEXT_WINDOW';
  } else entry.sizingEffect = 'BASE_WIN_RECALCULATE_CAPITAL_BASE';
  s.lastDecision = { entryId: entry.id, outcome, source, at: now, effect: entry.sizingEffect };
  return true;
}
function validateState(s, entries) {
  if (!s || s.version !== 3 || typeof s.active !== 'boolean' || !Number.isFinite(s.netPnl)
    || (!s.active && (s.netPnl !== 0 || s.frozenBaseBudget !== null))
    || (s.active && (!(s.frozenBaseBudget >= 0) || !Number.isFinite(s.frozenBaseBudget) || s.netPnl >= TARGET))
    || !Number.isFinite(s.eligibleWindowStart)
    || (s.awaitingEntryId && !entries.some(e => e.id === s.awaitingEntryId && e.recoveryRole === 'RECOVERY' && !e.sizingOutcome)))
    throw new Error('Invalid saved price-strategy recovery state.');
  return structuredClone(s);
}
module.exports = { PRICE, TARGET, newState, plan, recordAttempt, applyOutcome, validateState };
