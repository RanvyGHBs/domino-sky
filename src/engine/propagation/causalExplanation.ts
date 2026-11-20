/**
 * Domino Sky — Deterministic Causal Explanation Builder
 *
 * Generates traceable, structured 6-point operational explanations for every flight
 * directly from deterministic simulation math (never generated or altered by Gemini).
 */

import type {
  AirportClosureEvent,
  DisruptionCause,
  FlightCausalExplanation,
  FlightImpactCategory,
  FlightOperationalStatus,
  ScheduledFlight,
} from '../../types/index.ts';
import { formatMinutesToClock } from '../time.ts';

export interface CausalExplanationInput {
  flight: ScheduledFlight;
  status: FlightOperationalStatus;
  impactCategory: FlightImpactCategory;
  precedingFlightId: string | null;
  incomingUpstreamDelayMin: number;
  turnaroundSlackAvailableMin: number;
  turnaroundSlackAbsorbedMin: number;
  residualUpstreamDelayMin: number;
  closureGroundHoldMinutes: number;
  airborneHoldMinutes: number;
  reopeningSlotDelayMinutes: number;
  finalArrivalDelayMin: number;
  causes: DisruptionCause[];
  closure: AirportClosureEvent | null;
  minTurnaroundMinutes: number;
}

export function buildFlightCausalExplanation(
  input: CausalExplanationInput
): FlightCausalExplanation {
  const {
    flight,
    status,
    impactCategory,
    precedingFlightId,
    incomingUpstreamDelayMin,
    turnaroundSlackAvailableMin,
    turnaroundSlackAbsorbedMin,
    residualUpstreamDelayMin,
    closureGroundHoldMinutes,
    airborneHoldMinutes,
    reopeningSlotDelayMinutes,
    finalArrivalDelayMin,
    causes,
    closure,
    minTurnaroundMinutes,
  } = input;

  const directLegDelayMin =
    closureGroundHoldMinutes + airborneHoldMinutes + reopeningSlotDelayMinutes;

  const closureLabel = closure
    ? `${closure.airportId} closure (${formatMinutesToClock(closure.startMin)}–${formatMinutesToClock(closure.endMin)})`
    : 'airport closure';

  // Cancelled flight explanation
  if (status === 'cancelled') {
    const primary = causes[0];
    const primaryTrigger = primary
      ? primary.explanation
      : `Flight ${flight.flightId} cancelled`;
    return {
      impactCategory,
      primaryTrigger,
      precedingFlightId,
      incomingUpstreamDelayMin,
      turnaroundSlackAvailableMin,
      turnaroundSlackAbsorbedMin,
      residualUpstreamDelayMin,
      directLegDelayMin,
      finalArrivalDelayMin: 0,
      summary: primaryTrigger,
    };
  }

  // On-time flight (possibly after absorbing upstream delay via turnaround slack)
  if (status === 'on_time') {
    if (incomingUpstreamDelayMin > 0 && precedingFlightId) {
      return {
        impactCategory: 'unaffected',
        primaryTrigger: `Upstream delay from ${precedingFlightId} fully absorbed`,
        precedingFlightId,
        incomingUpstreamDelayMin,
        turnaroundSlackAvailableMin,
        turnaroundSlackAbsorbedMin,
        residualUpstreamDelayMin: 0,
        directLegDelayMin: 0,
        finalArrivalDelayMin: 0,
        summary: `On time. Previous leg ${precedingFlightId} arrived ${incomingUpstreamDelayMin}m late, but ${turnaroundSlackAvailableMin}m of turnaround slack (above the ${minTurnaroundMinutes}m minimum turnaround) absorbed all ${turnaroundSlackAbsorbedMin}m of delay, leaving 0m remaining delay.`,
      };
    }
    return {
      impactCategory: 'unaffected',
      primaryTrigger: 'Operating on schedule',
      precedingFlightId,
      incomingUpstreamDelayMin: 0,
      turnaroundSlackAvailableMin,
      turnaroundSlackAbsorbedMin: 0,
      residualUpstreamDelayMin: 0,
      directLegDelayMin: 0,
      finalArrivalDelayMin: 0,
      summary: `On time. Unaffected by disruption; operates ${flight.origin}→${flight.destination} as scheduled (${flight.scheduledDepStr}–${flight.scheduledArrStr}).`,
    };
  }

  // Delayed flight: assemble all 6 deterministic points
  const parts: string[] = [];

  if (impactCategory === 'direct') {
    parts.push(`Direct disruption on ${flight.flightId}.`);
  } else if (impactCategory === 'propagated') {
    parts.push(`Propagated domino disruption on ${flight.flightId}.`);
  } else {
    parts.push(`Combined propagated and direct disruption on ${flight.flightId}.`);
  }

  // Upstream propagation & turnaround slack accounting
  if (incomingUpstreamDelayMin > 0 && precedingFlightId) {
    if (turnaroundSlackAbsorbedMin > 0) {
      parts.push(
        `Preceding leg ${precedingFlightId} arrived ${incomingUpstreamDelayMin}m late; ${turnaroundSlackAbsorbedMin}m of ${turnaroundSlackAvailableMin}m turnaround slack (above ${minTurnaroundMinutes}m minimum turnaround) absorbed part of the delay, leaving ${residualUpstreamDelayMin}m propagated delay.`
      );
    } else {
      parts.push(
        `Preceding leg ${precedingFlightId} arrived ${incomingUpstreamDelayMin}m late with 0m turnaround slack (scheduled at the ${minTurnaroundMinutes}m minimum turnaround), propagating all ${residualUpstreamDelayMin}m.`
      );
    }
  }

  // Direct leg disruption causes
  if (closureGroundHoldMinutes > 0) {
    const isOriginHit = causes.some((c) => c.type === 'origin_airport_closure_ground_hold');
    if (isOriginHit) {
      parts.push(
        `${closureLabel} held departure at origin ${flight.origin} by +${closureGroundHoldMinutes}m.`
      );
    } else {
      parts.push(
        `${closureLabel} required a destination Ground Delay Program hold at origin ${flight.origin} of +${closureGroundHoldMinutes}m so arrival occurs after reopening.`
      );
    }
  }

  if (airborneHoldMinutes > 0) {
    parts.push(
      `Already airborne before ${closureLabel} began; incurred +${airborneHoldMinutes}m of airborne arrival holding until reopening.`
    );
  }

  if (reopeningSlotDelayMinutes > 0) {
    parts.push(
      `Reopening runway capacity queue at ${closure?.airportId ?? flight.origin} added +${reopeningSlotDelayMinutes}m.`
    );
  }

  parts.push(`Total remaining arrival delay: +${finalArrivalDelayMin}m.`);

  let primaryTrigger: string;
  if (impactCategory === 'direct') {
    primaryTrigger =
      airborneHoldMinutes > 0
        ? `Airborne holding for ${closureLabel}`
        : closureGroundHoldMinutes > 0
          ? closureLabel
          : `Reopening capacity queue at ${closure?.airportId ?? flight.origin}`;
  } else if (impactCategory === 'propagated') {
    primaryTrigger = `Late inbound aircraft from ${precedingFlightId ?? 'prior leg'}`;
  } else {
    primaryTrigger = `Late inbound ${precedingFlightId ?? 'prior leg'} + ${closureLabel}`;
  }

  return {
    impactCategory,
    primaryTrigger,
    precedingFlightId,
    incomingUpstreamDelayMin,
    turnaroundSlackAvailableMin,
    turnaroundSlackAbsorbedMin,
    residualUpstreamDelayMin,
    directLegDelayMin,
    finalArrivalDelayMin,
    summary: parts.join(' '),
  };
}
