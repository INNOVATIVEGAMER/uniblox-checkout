/** The k-th milestone is reached at paid order k * n. */
export function milestonesReached(paidOrders: number, n: number) {
  return Math.floor(paidOrders / n);
}

/**
 * Coupons are generated oldest milestone first, so the next one to reward is the one after the highest
 * already rewarded.
 */
export function milestoneProgress({ paidOrders, n, lastMilestone }: { paidOrders: number; n: number; lastMilestone: number }) {
  const reached = milestonesReached(paidOrders, n);
  const next = lastMilestone + 1;
  return {
    next,
    eligible: next <= reached,
    remainingEligible: Math.max(reached - next, 0),
    nextMilestoneAt: next * n,
  };
}
