import type { NextApiRequest, NextApiResponse } from 'next';

// Proxy to USGS Travel Time service to avoid CORS and to normalize output
// Docs: https://earthquake.usgs.gov/ws/traveltime/

type PhaseCurve = { deg: number; timeSec: number }[];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const depthKm = Math.max(0, Math.min(700, parseFloat(String(req.query.depth ?? '10'))));
    const maxDeg = Math.max(1, Math.min(180, parseFloat(String(req.query.maxdeg ?? '30'))));
    const stepDeg = Math.max(0.1, Math.min(10, parseFloat(String(req.query.step ?? '0.25'))));
    const phases = String(req.query.phases ?? 'P,S');

    const distances: number[] = [];
    for (let d = 0; d <= maxDeg + 1e-9; d += stepDeg) distances.push(parseFloat(d.toFixed(6)));
    const distancesParam = distances.join(',');

    const url = `https://earthquake.usgs.gov/ws/traveltime/1/query?format=json&phases=${encodeURIComponent(phases)}&sourceDepth=${depthKm}&distances=${encodeURIComponent(distancesParam)}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) {
      return res.status(502).json({ error: 'Upstream error', status: r.status });
    }
    const data = await r.json();
    const curves: Record<string, PhaseCurve> = {};
    for (const entry of data?.travelTimes ?? []) {
      const deg = Number(entry?.distance); // degrees
      const arrs: any[] = entry?.times ?? entry?.phases ?? [];
      for (const phase of arrs) {
        const name: string = (phase?.phase ?? phase?.name ?? '').toUpperCase();
        const tSec = Number(phase?.time);
        if (!isFinite(deg) || !isFinite(tSec) || !name) continue;
        if (!curves[name]) curves[name] = [];
        curves[name].push({ deg, timeSec: tSec });
      }
    }
    // Ensure sorted by deg
    Object.keys(curves).forEach(k => curves[k].sort((a, b) => a.deg - b.deg));
    return res.status(200).json({ depthKm, distances, curves });
  } catch (e: any) {
    return res.status(500).json({ error: 'traveltime failed', message: e?.message ?? String(e) });
  }
}



