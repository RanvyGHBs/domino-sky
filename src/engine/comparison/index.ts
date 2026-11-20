/**
 * Module 8: Before-and-After Network Comparison
 *
 * Computes deterministic deltas between a disrupted baseline SimulationResult
 * and a post-recovery SimulationResult across delays, cancellations, connections,
 * stranded passenger totals, and crew duty-time violations.
 */

import type {
  RecoveryAction,
  RecoveryComparison,
  SimulationResult,
} from '../../types/index.ts';

export interface NetworkComparisonEngine {
  compareScenarios(
    baseline: SimulationResult,
    recovered: SimulationResult,
    appliedAction: RecoveryAction
  ): RecoveryComparison;
}
