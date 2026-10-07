/**
 * The k-th milestone is reached at paid order k * n. Coupons are generated oldest milestone first, so the next one
 * to reward is the one after the highest already rewarded.
 */
export function milestoneProgress({ paidOrders, n, lastMilestone }: { paidOrders: number; n: number; lastMilestone: number }) {
  const reached = Math.floor(paidOrders / n);
  const unrewarded = reached - lastMilestone;
  const next = lastMilestone + 1;
  return {
    reached,
    unrewarded,
    next,
    eligible: unrewarded > 0,
    remainingEligible: Math.max(unrewarded - 1, 0),
    nextMilestoneAt: next * n,
  };
}
