/**
 * Domino Sky — Full-Stack Server Entry Point (Port 3000)
 *
 * Serves:
 *  - GET /api/health             : Runtime health check
 *  - GET /api/dataset            : Server-validated official flight_network.json
 *  - GET /api/dispatcher/status  : Server-side Gemini dispatcher availability (never exposes API keys)
 *  - POST /api/dispatcher/recommend : Reserved for Phase 4 Gemini AI dispatcher endpoint
 *  - Vite dev middleware (development) or static dist/ bundle (production)
 */

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawFlightNetworkDataset } from './src/types/dataset.ts';
import type { SimulationConfig } from './src/types/simulation.ts';
import { normalizeFlightNetwork } from './src/engine/dataset/loader.ts';
import { createAirportClosureEvent } from './src/engine/closure/index.ts';
import { simulateDisruption } from './src/engine/propagation/index.ts';
import { isValidHHMM, parseHHMMToMinutes } from './src/engine/time.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DATASET_PATH = path.resolve(
  __dirname,
  'public/assets/aistudio/flight_network_78529dd1.json'
);
const PLANNED_GEMINI_MODEL = 'gemini-4-hydrogen';

function loadValidatedDatasetFromDisk() {
  const rawText = fs.readFileSync(DATASET_PATH, 'utf-8');
  const raw = JSON.parse(rawText) as RawFlightNetworkDataset;
  return normalizeFlightNetwork(raw);
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
      const body = (req.body ?? {}) as {
        airportId?: string | null;
        startTime?: string;
        startMin?: number;
        durationMinutes?: number;
        reason?: string;
        config?: Partial<SimulationConfig>;
      };

      let closure = null;
      if (body.airportId) {
        let startMin: number;
        if (typeof body.startMin === 'number' && Number.isFinite(body.startMin)) {
          startMin = body.startMin;
        } else if (typeof body.startTime === 'string' && isValidHHMM(body.startTime)) {
          startMin = parseHHMMToMinutes(body.startTime);
        } else {
          res.status(400).json({ error: 'Provide a valid 24-hour HH:MM startTime or integer startMin.' });
          return;
        }

        const durationMinutes = Number(body.durationMinutes);
        if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
          res.status(400).json({ error: 'durationMinutes must be a positive number.' });
          return;
        }

        closure = createAirportClosureEvent(
          bundle.network,
          body.airportId,
          startMin,
          durationMinutes,
          body.reason
        );
      }

      const result = simulateDisruption(bundle.network, closure, body.config);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Simulation failed.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/dispatcher/status', (_req, res) => {
    const hasKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
    res.json({
      available: hasKey,
      mode: hasKey ? 'gemini_ready' : 'offline_deterministic_only',
      model: PLANNED_GEMINI_MODEL,
      message: hasKey
        ? 'Server-side Gemini API key detected. Ready for AI dispatcher integration once the simulation engine is active.'
        : 'Running in deterministic-only mode. The simulator operates completely without Gemini when no API key is configured.',
    });
  });

  app.post('/api/dispatcher/recommend', (_req, res) => {
    res.status(501).json({
      error:
        'AI dispatcher recommendations are scheduled for Phase 4 after the deterministic propagation and recovery engines are implemented.',
    });
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
