import type { NextApiRequest, NextApiResponse } from 'next';
import * as cheerio from 'cheerio';

type KmaEarthquake = {
  time: string; // ISO string (UTC)
  location: string;
  depth: number;
  magnitude: number;
  intensity: number; // use -1 (unknown)
  latitude: number | null;
  longitude: number | null;
  intensityText?: string; // KMA raw intensity text (as-is)
};

function parseKstToIsoUtc(input: string): string | null {
  // KMA format example: 2025/01/02 03:04:05
  const trimmed = input.trim();
  const m = trimmed.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [_, y, mo, d, hh, mm, ss] = m;
  const kst = new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}+09:00`);
  if (isNaN(kst.getTime())) return null;
  return new Date(kst.getTime()).toISOString();
}

function parseLat(text: string): number | null {
  const t = text.trim();
  const ns = t.includes('S') ? -1 : 1;
  const num = t.replace(/[NS]/g, '').trim();
  const v = Number.parseFloat(num);
  return Number.isFinite(v) ? ns * v : null;
}

function parseLng(text: string): number | null {
  const t = text.trim();
  const ew = t.includes('W') ? -1 : 1;
  const num = t.replace(/[EW]/g, '').trim();
  const v = Number.parseFloat(num);
  return Number.isFinite(v) ? ew * v : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const resp = await fetch('https://www.weather.go.kr/w/eqk-vol/search/korea.do', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko,en-US;q=0.9,en;q=0.8,ja;q=0.7'
      },
      cache: 'no-store'
    });
    if (!resp.ok) {
      res.status(200).json({ success: true, data: [] as KmaEarthquake[] });
      return;
    }
    const html = await resp.text();
    const $ = cheerio.load(html);

    const events: KmaEarthquake[] = [];
    $('#excel_body tbody tr').each((_i, tr) => {
      const tds = $(tr).find('td');
      if (tds.length === 0) return;
      const get = (idx: number) => $(tds[idx])?.text()?.trim() ?? '';
      // Column mapping based on referenced Go implementation
      const timeStr = get(1);
      const magStr = get(2);
      const depthStr = get(3);
      const intenStr = get(4);
      const latStr = get(5);
      const lngStr = get(6);
      const locStr = get(7);

      const iso = parseKstToIsoUtc(timeStr);
      const magnitude = Number.parseFloat(magStr);
      const depth = Number.parseFloat(depthStr);
      const latitude = parseLat(latStr);
      const longitude = parseLng(lngStr);

      if (!iso) return;

      events.push({
        time: iso,
        location: locStr || '대한민국',
        depth: Number.isFinite(depth) ? depth : 0,
        magnitude: Number.isFinite(magnitude) ? magnitude : 0,
        intensity: -1,
        latitude: Number.isFinite(latitude as number) ? (latitude as number) : null,
        longitude: Number.isFinite(longitude as number) ? (longitude as number) : null,
        intensityText: intenStr || undefined,
      });
    });

    // Sort by time desc
    events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

    res.status(200).json({ success: true, data: events });
  } catch (e) {
    // Fail-soft: return empty list on error
    res.status(200).json({ success: true, data: [] as KmaEarthquake[] });
  }
}


