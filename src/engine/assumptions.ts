/**
 * Domino Sky — Operational Rules & Documented Assumptions Registry
 *
 * Explicitly separates official rules stated in flight_network.json (`meta.notes`)
 * from engineering/modelling assumptions chosen where the dataset leaves operational
 * policy unspecified. Configurable assumptions are tagged with their exact config keys
 * and are never silently presented as verified dataset data.
 */

export type RuleSourceType = 'official_dataset_rule' | 'documented_assumption';

export interface OperationalRuleRecord {
  id: string;
  title: string;
  domain:
    | 'Time & Calendar'
    | 'Airport Closure'
    | 'Aircraft Rotation'
    | 'Spare Aircraft'
    | 'Passenger Connections'
    | 'Crew Duty'
    | 'Recovery'
    | 'AI Dispatcher';
  source: RuleSourceType;
  isConfigurable: boolean;
  configKey?: string;
  ruleStatement: string;
  rationale: string;
  datasetReference?: string;
}

export const OFFICIAL_AND_ASSUMED_RULES: OperationalRuleRecord[] = [
  // Official Dataset Rules
  {
    id: 'RULE-01',
    title: 'Minimum Aircraft Turnaround & Leg Sequencing',
    domain: 'Aircraft Rotation',
    source: 'official_dataset_rule',
    isConfigurable: false,
    ruleStatement:
      'Each aircraft flies its assigned flights strictly in leg_order. A flight cannot depart before the previous flight of the same aircraft has arrived plus min_turnaround_minutes (30 minutes). Scheduled turnaround above 30 minutes acts as absorbable schedule buffer.',
    rationale:
      'Directly enforced from dataset metadata. Any upstream arrival delay shrinks scheduled turnaround buffer down to 30 minutes before propagating downstream.',
    datasetReference: 'meta.min_turnaround_minutes = 30; meta.notes[0]',
  },
  {
    id: 'RULE-02',
    title: 'Passenger Connection Minimum Connect Time (MCT)',
    domain: 'Passenger Connections',
    source: 'official_dataset_rule',
    isConfigurable: false,
    ruleStatement:
      'A passenger connection is made if and only if both from_flight and to_flight operate and actualDep(to_flight) - actualArr(from_flight) >= min_connect_minutes (40 or 45 minutes per connection record).',
    rationale: 'Directly enforced from each connection record in the official JSON.',
    datasetReference: 'connections[].min_connect_minutes; meta.notes[2]',
  },
  {
    id: 'RULE-03',
    title: 'Crew Duty Limit & Actual Completion Evaluation',
    domain: 'Crew Duty',
    source: 'official_dataset_rule',
    isConfigurable: false,
    ruleStatement:
      'Crew duty begins at duty_start and runs until the ACTUAL arrival time of the crew’s last operated flight. Total duty must not exceed max_duty_mins (600 minutes / 10 hours).',
    rationale:
      'Dataset meta.notes references scheduled arrival for baseline schedules, while operational disruption evaluation uses actual flight completion times to catch delay-induced duty violations (e.g., CR03 starts with only 10 minutes of baseline duty margin).',
    datasetReference: 'crews[].duty_start, crews[].max_duty_mins = 600',
  },

  // Documented Modelling Assumptions
  {
    id: 'RULE-04',
    title: 'Absolute-Minute Time Axis Past Midnight',
    domain: 'Time & Calendar',
    source: 'documented_assumption',
    isConfigurable: false,
    ruleStatement:
      'All times are converted to integer absolute minutes from 00:00 IST on the operating day. Delays pushing departures or arrivals past 23:59 continue monotonically (e.g., 1475 min = 00:35 (+1d)) with no midnight wrap-around.',
    rationale:
      'Late flights arrive after 21:00 (e.g., DS1005 at 21:45, DS1604 at 21:30). Monotonic integer minutes preserve exact turnaround, connection, and crew-duty math across midnight.',
  },
  {
    id: 'RULE-05',
    title: 'Airport Closure Evaluated Against Actual Timelines (Ground Hold vs Airborne Disruption)',
    domain: 'Airport Closure',
    source: 'documented_assumption',
    isConfigurable: false,
    ruleStatement:
      'Every flight is evaluated against the closure window [startMin, endMin) using its ACTUAL ready departure and estimated arrival timeline (incorporating upstream rotation delays). Zero departure or arrival movements are permitted inside [startMin, endMin). (1) Outbound flights from the closed airport ready inside [startMin, endMin) are ground-held until >= endMin. (2) Inbound flights that have NOT yet departed by closure startMin whose estimated arrival falls inside [startMin, endMin) are ground-held at origin (GDP) so actualArr >= endMin. (3) Inbound flights ALREADY AIRBORNE (actualDep < startMin) whose arrival falls inside [startMin, endMin) are modelled as airborne arrival holding until >= endMin without altering actualDep. (4) Flights that can legally depart and arrive completely outside [startMin, endMin) receive ZERO arbitrary closure delay.',
    rationale:
      'Evaluating actual timelines catches flights pushed into a closure by upstream delays, strictly separates ground holds from airborne holding, forbids illegal movements during closures, and avoids penalizing unaffected flights.',
  },
  {
    id: 'RULE-06',
    title: 'Reopening Runway Capacity Metering & Queue-Ordering Policy',
    domain: 'Airport Closure',
    source: 'documented_assumption',
    isConfigurable: true,
    configKey: 'enforceReopeningCapacityMetering, reopeningQueueOrdering',
    ruleStatement:
      'When reopening capacity metering is active, movements queued for [endMin, ...) at the closed airport are ordered deterministically by earliest ready movement time, then original scheduled movement time, then flight_id. Movement slot k (0-indexed) receives earliest slot endMin + floor(k * 60 / capacity_per_hour) minutes, enforcing at most capacity_per_hour movements per 60-minute window without delaying movements whose natural ready time already exceeds the next open slot.',
    rationale:
      'The official JSON includes capacity_per_hour (8–40/hr) without defining slot allocation. Documenting the exact deterministic queue-ordering and slot-spacing formula ensures repeatable, auditable backlog recovery.',
    datasetReference: 'airports[].capacity_per_hour',
  },
  {
    id: 'RULE-07',
    title: 'Physical Aircraft Continuity on Flight Cancellations',
    domain: 'Aircraft Rotation',
    source: 'documented_assumption',
    isConfigurable: false,
    ruleStatement:
      'An aircraft cannot teleport. Cancelling leg k (origin X -> destination Y) leaves the aircraft physically at X. Every cancellation must pass physical rotation validation: subsequent legs are only operable if their origin matches the aircraft’s actual physical location (e.g., cancelling an out-and-back pair X->Y and Y->X preserves position at X); otherwise downstream incompatible legs must also be cancelled or legally covered by a physically positioned replacement aircraft.',
    rationale:
      'Guarantees every simulated schedule and recovery scenario obeys real-world aircraft positioning.',
  },
  {
    id: 'RULE-08',
    title: 'Spare Aircraft Physical Constraints & Configurable Standby Crew Modelling Assumption',
    domain: 'Spare Aircraft',
    source: 'documented_assumption',
    isConfigurable: true,
    configKey: 'assumedStandbyCrew.{enabled, preDepartureBriefingMins, maxDutyMins}',
    ruleStatement:
      'Spare aircraft VT-DS17 (base BLR, available 05:00, 180 seats) and VT-DS18 (base DEL, available 05:00, 180 seats) must strictly respect their base, availability time, tracked physical position, and seat capacity (seats >= flight.pax). IMPORTANT MODELLING ASSUMPTION: The official dataset contains NO standby crew records. When assumedStandbyCrew.enabled is true (configurable), deploying a spare models an assumed standby crew at the spare’s base with a configurable pre-departure lead time (default 45 minutes) and 600-minute duty limit; every resulting crew record and recovery action is explicitly flagged as relying on this modelling assumption and is never presented as verified dataset data.',
    rationale:
      'Honors every physical constraint of the spare fleet while making the absence of reserve crew data in flight_network.json completely transparent and user-configurable.',
    datasetReference: 'spare_aircraft[VT-DS17 @ BLR, VT-DS18 @ DEL] (no reserve_crews table in JSON)',
  },
  {
    id: 'RULE-09',
    title: 'Passenger Impact & Non-Double-Counting Methodology',
    domain: 'Passenger Connections',
    source: 'documented_assumption',
    isConfigurable: false,
    ruleStatement:
      'Stranded passenger impact separates two mutually exclusive primary counts: (1) cancelledFlightPax (sum of pax on cancelled flights) and (2) missedConnectionPax (sum of connection.passengers where BOTH from_flight and to_flight operated, but connect time < min_connect_minutes). Connections broken because either flight was cancelled are reported separately as cancelledConnectionOverlapPax and excluded from totalStrandedPaxEstimate so connecting passengers are never double-counted. Because individual PNR itineraries are absent, figures represent affected passenger-trips.',
    rationale:
      'Eliminates double counting when cancellations also break connections and honestly discloses dataset passenger-identity granularity.',
  },
  {
    id: 'RULE-10',
    title: 'Crew Duty Violation Policy (Flag-Only Default, Configurable Strict Enforcement)',
    domain: 'Crew Duty',
    source: 'documented_assumption',
    isConfigurable: true,
    configKey: 'crewViolationPolicy',
    ruleStatement:
      'Default behaviour is flag_violation: legs completing past duty_start + max_duty_mins are explicitly flagged as Crew Duty Violations (with exact overage minutes) WITHOUT automatically cancelling flights. Strict enforcement (cancel_violating_legs) is an explicit opt-in configurable policy; whenever any leg is cancelled under strict enforcement, the cancellation MUST pass through aircraft-position and downstream rotation validation.',
    rationale:
      'Prevents silent flight cancellations by default while supporting optional strict legal-cutoff simulation with full aircraft-continuity integrity.',
  },
  {
    id: 'RULE-11',
    title: 'Recovery Feasibility Verification & Mandatory Engine Re-Simulation',
    domain: 'Recovery',
    source: 'documented_assumption',
    isConfigurable: false,
    ruleStatement:
      'Every candidate recovery action (spare deployment, flight-chain cancellation, connection hold, or tail swap) must pass explicit physical and crew feasibility checks before it can be applied. Tail swaps are NEVER assumed feasible without validating both aircraft positions, availability times, seat capacities, and crew assignments/legality. Every feasible candidate MUST be re-simulated by the deterministic engine; Gemini AI can only recommend a validated actionId and provide qualitative trade-off analysis.',
    rationale:
      'Prevents infeasible recovery suggestions and ensures every before-and-after metric is 100% engine-verified.',
  },
];
