/**
 * Domino Sky — Full-Stack Server Entry Point (Port 3000)
 *
 * Serves:
 *  - GET  /api/health              : Runtime health check
 *  - GET  /api/dataset             : Server-validated official flight_network.json
 *  - POST /api/simulate            : Deterministic disruption simulation
 *  - POST /api/recovery/candidates : Deterministic recovery candidate generation + rejected diagnostics
 *  - POST /api/recovery/evaluate   : Re-simulate & compare a single selected recovery candidate
 *  - POST /api/recovery/compare    : Re-simulate & compare multiple recovery candidates side-by-side
 *  - POST /api/recovery/ranked     : Generate, re-simulate, and transparently rank all feasible options
 *  - GET  /api/dispatcher/status   : Server-side Gemini dispatcher availability (never exposes API keys)
 *  - POST /api/dispatcher/recommend: Server-side Gemini AI Dispatcher with deterministic validation & fallback
 *  - Vite dev middleware (development) or static dist/ bundle (production)
 */

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedFlightNetwork, RawFlightNetworkDataset } from './src/types/dataset.ts';
import type { AirportClosureEvent, SimulationConfig } from './src/types/simulation.ts';
import { normalizeFlightNetwork } from './src/engine/dataset/loader.ts';
import { createAirportClosureEvent } from './src/engine/closure/index.ts';
import { simulateDisruption } from './src/engine/propagation/index.ts';
import {
  evaluateRecoveryCandidate,
  generateAndRankRecoveryOptions,
  generateRecoveryCandidates,
} from './src/engine/recovery/index.ts';
import { isValidHHMM, parseHHMMToMinutes } from './src/engine/time.ts';
import {
  DispatcherInputValidationError,
  GEMINI_DISPATCHER_MODEL,
  runDispatcherRecommendation,
} from './src/server/dispatcher/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DATASET_PATH = path.resolve(
  __dirname,
  'public/assets/aistudio/flight_network_78529dd1.json'
);

interface ScenarioRequestBody {
  airportId?: string | null;
  startTime?: string;
  startMin?: number;
  durationMinutes?: number;
  reason?: string;
  config?: Partial<SimulationConfig>;
}

function loadValidatedDatasetFromDisk() {
  const rawText = fs.readFileSync(DATASET_PATH, 'utf-8');
  const raw = JSON.parse(rawText) as RawFlightNetworkDataset;
  return normalizeFlightNetwork(raw);
}

function parseClosureFromBody(
  network: NormalizedFlightNetwork,
  body: ScenarioRequestBody
): AirportClosureEvent | null {
  if (!body.airportId) {
    return null;
  }

  let startMin: number;
  if (typeof body.startMin === 'number' && Number.isFinite(body.startMin)) {
    startMin = body.startMin;
  } else if (typeof body.startTime === 'string' && isValidHHMM(body.startTime)) {
    startMin = parseHHMMToMinutes(body.startTime);
  } else {
    throw new Error('Provide a valid 24-hour HH:MM startTime or integer startMin.');
  }

  const durationMinutes = Number(body.durationMinutes);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new Error('durationMinutes must be a positive number.');
  }

  return createAirportClosureEvent(
    network,
    body.airportId,
    startMin,
    durationMinutes,
    body.reason
  );
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'domino-sky',
      datasetPresent: fs.existsSync(DATASET_PATH),
    });
  });

  app.get('/api/dataset', (_req, res) => {
    try {
      const bundle = loadValidatedDatasetFromDisk();
      res.json({
        raw: bundle.raw,
        validation: bundle.validation,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load official dataset.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/simulate', (req, res) => {
    try {
      const bundle = loadValidatedDatasetFromDisk();
      const body = (req.body ?? {}) as ScenarioRequestBody;
      const closure = parseClosureFromBody(bundle.network, body);
      const result = simulateDisruption(bundle.network, closure, body.config);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Simulation failed.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/recovery/candidates', (req, res) => {
    try {
      const bundle = loadValidatedDatasetFromDisk();
      const body = (req.body ?? {}) as ScenarioRequestBody;
      const closure = parseClosureFromBody(bundle.network, body);
      const baseline = simulateDisruption(bundle.network, closure, body.config);
      const { candidates, rejectedCandidates } = generateRecoveryCandidates(
        bundle.network,
        baseline
      );
      res.json({
        scenarioId: baseline.scenarioId,
        baselineKpis: baseline.kpis,
        candidates,
        rejectedCandidates,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Candidate generation failed.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/recovery/evaluate', (req, res) => {
    try {
      const bundle = loadValidatedDatasetFromDisk();
      const body = (req.body ?? {}) as ScenarioRequestBody & { actionId?: string };
      if (!body.actionId || typeof body.actionId !== 'string') {
        res.status(400).json({ error: 'actionId is required to evaluate a recovery candidate.' });
        return;
      }

      const closure = parseClosureFromBody(bundle.network, body);
      const baseline = simulateDisruption(bundle.network, closure, body.config);
      const { candidates, rejectedCandidates } = generateRecoveryCandidates(
        bundle.network,
        baseline
      );

      const matchedFeasible = candidates.find((c) => c.actionId === body.actionId);
      if (matchedFeasible) {
        const comparison = evaluateRecoveryCandidate(bundle.network, baseline, matchedFeasible);
        res.json({ comparison });
        return;
      }

      const matchedRejected = rejectedCandidates.find((c) => c.actionId === body.actionId);
      if (matchedRejected) {
        res.status(422).json({
          error: `Recovery action "${body.actionId}" is physically or legally infeasible.`,
          action: matchedRejected,
        });
        return;
      }

      res.status(404).json({
        error: `Unknown recovery actionId "${body.actionId}" for this scenario.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recovery evaluation failed.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/recovery/compare', (req, res) => {
    try {
      const bundle = loadValidatedDatasetFromDisk();
      const body = (req.body ?? {}) as ScenarioRequestBody & { actionIds?: string[] };
      const closure = parseClosureFromBody(bundle.network, body);
      const baseline = simulateDisruption(bundle.network, closure, body.config);
      const { candidates, rejectedCandidates } = generateRecoveryCandidates(
        bundle.network,
        baseline
      );

      let selected = candidates;
      if (Array.isArray(body.actionIds) && body.actionIds.length > 0) {
        const missingIds: string[] = [];
        selected = [];
        for (const id of body.actionIds) {
          const found = candidates.find((c) => c.actionId === id);
          if (!found) {
            missingIds.push(id);
          } else {
            selected.push(found);
          }
        }
        if (missingIds.length > 0) {
          res.status(404).json({
            error: `One or more requested actionIds are unknown or infeasible: ${missingIds.join(', ')}`,
          });
          return;
        }
      }

      const comparisons = selected.map((candidate) =>
        evaluateRecoveryCandidate(bundle.network, baseline, candidate)
      );

      res.json({
        scenarioId: baseline.scenarioId,
        baselineKpis: baseline.kpis,
        comparisons,
        rejectedCandidates,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recovery comparison failed.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/recovery/ranked', (req, res) => {
    try {
      const bundle = loadValidatedDatasetFromDisk();
      const body = (req.body ?? {}) as ScenarioRequestBody;
      const closure = parseClosureFromBody(bundle.network, body);
      const baseline = simulateDisruption(bundle.network, closure, body.config);
      const ranked = generateAndRankRecoveryOptions(bundle.network, baseline);
      res.json({
        scenarioId: baseline.scenarioId,
        baselineKpis: baseline.kpis,
        rankedOptions: ranked.rankedOptions,
        rejectedCandidates: ranked.rejectedCandidates,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recovery ranking failed.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/dispatcher/status', (_req, res) => {
    const rawKey = (process.env.GEMINI_API_KEY ?? '').trim();
    const hasKey = rawKey.length > 0 && rawKey !== 'MY_GEMINI_API_KEY';
    res.json({
      available: hasKey,
      mode: hasKey ? 'gemini_ready' : 'offline_deterministic_only',
      model: GEMINI_DISPATCHER_MODEL,
      message: hasKey
        ? `Server-side Gemini AI Dispatcher active (${GEMINI_DISPATCHER_MODEL}) with deterministic validation and automatic fallback.`
        : 'Running in deterministic fallback mode. Configure server-side GEMINI_API_KEY to enable Gemini reasoning; deterministic simulation and recovery remain fully operational.',
    });
  });

  app.post('/api/dispatcher/recommend', async (req, res) => {
    try {
      const bundle = loadValidatedDatasetFromDisk();
      const recommendation = await runDispatcherRecommendation(bundle.network, req.body);
      res.json(recommendation);
    } catch (error) {
      if (error instanceof DispatcherInputValidationError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Unable to generate dispatcher recommendation.';
      res.status(500).json({ error: message });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Domino Sky server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Domino Sky server:', err);
  process.exit(1);
});
