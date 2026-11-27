'use strict';
const WINDOW_MS = 300000;
const newState = () => ({ version: 1, step: 0, cycleSequence: 0, cycleId: null,
  originWindowStart: null, latestAttemptWindowStart: null, eligibleWindowStart: 0,
  awaitingEntryId: null, ignoreThroughWindowStart: -1, lastDecision: null });

function validateState(s, entries) {
  if (!s || s.version !== 1 || !Number.isInteger(s.step) || s.step < 0 || s.step > 3
    || !Number.isInteger(s.cycleSequence) || s.cycleSequence < 0
    || !Number.isFinite(s.eligibleWindowStart) || !Number.isFinite(s.ignoreThroughWindowStart)
    || (s.step > 0 && (!Number.isInteger(s.cycleId) || s.cycleId < 1
      || s.cycleId > s.cycleSequence || !Number.isFinite(s.originWindowStart)))
    || (s.step === 0 && (s.cycleId !== null || s.awaitingEntryId !== null))
    || (s.awaitingEntryId && !entries.some(e => e.id === s.awaitingEntryId
      && e.recoveryCycleId === s.cycleId && !e.sizingOutcome))) {
    throw new Error('Invalid saved martingale state; refusing to silently reset recovery.');
  }
  return structuredClone(s);
}

function outcomeForMid(mid) {
  if (mid == null || !Number.isFinite(mid) || mid < 0 || mid > 1) return null;
  return mid > .98 ? 'WIN' : mid < .02 ? 'LOSS' : null;
}

function plan(s, windowStart) {
  const ready = s.step > 0 && !s.awaitingEntryId && windowStart >= s.eligibleWindowStart;
  return { requestedShares: ready ? 100 * 2 ** s.step : 100,
    role: ready ? 'RECOVERY' : 'BASE', step: ready ? s.step : 0, cycleId: s.cycleId,
    phase: !s.step ? 'BASE' : s.awaitingEntryId ? 'WAITING_RESULT' : ready ? 'RECOVERY_READY' : 'COOLDOWN',
    reason: !s.step ? 'Base trading at 100 shares.'
      : s.awaitingEntryId ? 'Recovery result is unclear; base trading continues at 100 shares.'
      : ready ? `Recovery ${s.step}/3 ready: ${100 * 2 ** s.step} shares.`
      : 'One intervening window before recovery; base trading continues at 100 shares.' };
}

function recordAttempt(s, entry, choice) {
  Object.assign(entry, { recoveryRole: choice.role, recoveryStep: choice.step,
    recoveryCycleId: choice.cycleId });
  if (choice.role === 'RECOVERY') {
    s.awaitingEntryId = entry.id;
    s.latestAttemptWindowStart = entry.windowStart;
  }
}

function applyOutcome(s, entry, outcome, source, now) {
  if (entry.sizingOutcome || !['WIN', 'LOSS'].includes(outcome) || now < entry.windowEnd) return false;
  Object.assign(entry, { sizingOutcome: outcome, sizingSource: source, sizingDecidedAt: now });
  const staleRecovery = entry.recoveryRole === 'RECOVERY'
    && (entry.recoveryCycleId !== s.cycleId || s.awaitingEntryId !== entry.id);
  if (staleRecovery || entry.windowStart <= s.ignoreThroughWindowStart
    || (s.step > 0 && entry.windowStart < s.originWindowStart)) {
    entry.sizingEffect = 'OLD_CYCLE_NO_CHANGE'; return true;
  }
  const reset = reason => {
    s.ignoreThroughWindowStart = Math.max(s.ignoreThroughWindowStart,
      entry.windowStart, s.latestAttemptWindowStart ?? -1);
    Object.assign(s, { step: 0, cycleId: null, awaitingEntryId: null,
      originWindowStart: null, latestAttemptWindowStart: null, eligibleWindowStart: 0 });
    entry.sizingEffect = reason;
  };
  if (outcome === 'WIN') reset('WIN_RESET_TO_100');
  else if (entry.recoveryRole === 'RECOVERY') {
    if (entry.recoveryStep === 3) reset('MAXIMUM_LOSS_RESET_TO_100');
    else {
      s.step = entry.recoveryStep + 1;
      s.awaitingEntryId = null;
      s.eligibleWindowStart = entry.windowEnd + WINDOW_MS;
      entry.sizingEffect = 'ADVANCE_AFTER_ONE_BASE_WINDOW';
    }
  } else if (s.step > 0) {
    // A base loss in the pause never doubles again or starts a parallel chain.
    entry.sizingEffect = 'INTERVENING_BASE_LOSS_NO_CHANGE';
  } else {
    s.cycleId = ++s.cycleSequence; s.step = 1;
    s.originWindowStart = entry.windowStart;
    s.latestAttemptWindowStart = entry.windowStart;
    s.eligibleWindowStart = entry.windowEnd + WINDOW_MS;
    entry.sizingEffect = 'START_RECOVERY_AFTER_ONE_BASE_WINDOW';
  }
  s.lastDecision = { entryId: entry.id, outcome, source, at: now, effect: entry.sizingEffect };
  return true;
}
module.exports = { WINDOW_MS, newState, validateState, outcomeForMid, plan, recordAttempt, applyOutcome };
