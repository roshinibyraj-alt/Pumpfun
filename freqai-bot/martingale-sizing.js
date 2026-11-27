'use strict';
const WINDOW_MS = 300000;
const BASE_SHARES = 50, PROFIT_TARGET = 10;
const newState = () => ({ version: 2, active: false, netPnl: 0, awaitingEntryId: null,
  eligibleWindowStart: 0, lastDecision: null });

function validateState(s, entries) {
  if (!s || s.version !== 2 || typeof s.active !== 'boolean' || !Number.isFinite(s.netPnl)
    || (!s.active && s.netPnl !== 0) || (s.active && s.netPnl >= PROFIT_TARGET)
    || !Number.isFinite(s.eligibleWindowStart)
    || (s.awaitingEntryId && !entries.some(e => e.id === s.awaitingEntryId
      && e.recoveryRole === 'RECOVERY' && !e.sizingOutcome))) {
    throw new Error('Invalid saved recovery state; refusing to silently reset recovery.');
  }
  return structuredClone(s);
}
function outcomeForMid(mid) {
  if (mid == null || !Number.isFinite(mid) || mid < 0 || mid > 1) return null;
  return mid > .98 ? 'WIN' : mid < .02 ? 'LOSS' : null;
}
function plan(s, windowStart) {
  const ready = s.active && !s.awaitingEntryId && windowStart >= s.eligibleWindowStart;
  return { requestedShares: BASE_SHARES, role: ready ? 'RECOVERY' : 'BASE',
    targetNetProfit: ready ? PROFIT_TARGET - s.netPnl : 0,
    phase: !s.active ? 'BASE' : s.awaitingEntryId ? 'WAITING_RESULT' : 'RECOVERY_READY',
    reason: !s.active ? 'Base trading at 50 shares.'
      : s.awaitingEntryId ? 'Recovery result unclear; 50-share base trading continues.'
      : `Recover $${Math.max(0, -s.netPnl).toFixed(2)} outstanding loss plus the remaining $10 cycle target; size uses actual ask depth and fees.` };
}
function recordAttempt(s, entry, choice) {
  Object.assign(entry, { recoveryRole: choice.role, recoveryTargetNetProfit: choice.targetNetProfit || 0 });
  if (choice.role === 'RECOVERY') s.awaitingEntryId = entry.id;
}
function applyOutcome(s, entry, outcome, source, now) {
  if (entry.sizingOutcome || !['WIN', 'LOSS'].includes(outcome) || now < entry.windowEnd) return false;
  const pnl = (outcome === 'WIN' ? entry.shares : 0) - entry.totalCost - entry.fees;
  if (!Number.isFinite(pnl)) throw new Error('Cannot size recovery from invalid entry costs.');
  Object.assign(entry, { sizingOutcome: outcome, sizingSource: source, sizingDecidedAt: now, sizingNetPnl: pnl });
  if (s.awaitingEntryId === entry.id) s.awaitingEntryId = null;
  if (s.active || pnl < 0) {
    s.active = true;
    s.netPnl += pnl;
    s.eligibleWindowStart = Math.max(s.eligibleWindowStart, entry.windowEnd);
    if (s.netPnl >= PROFIT_TARGET - 1e-8) {
      s.active = false; s.netPnl = 0;
      entry.sizingEffect = 'RECOVERED_PLUS_10_RESET_TO_50';
    } else entry.sizingEffect = 'RECOVER_LOSSES_PLUS_10_NEXT_WINDOW';
  } else entry.sizingEffect = 'BASE_WIN_STAY_50';
  s.lastDecision = { entryId: entry.id, outcome, source, at: now, effect: entry.sizingEffect };
  return true;
}
module.exports = { WINDOW_MS, BASE_SHARES, PROFIT_TARGET, newState, validateState, outcomeForMid, plan, recordAttempt, applyOutcome };
