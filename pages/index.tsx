import React, { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
import dynamic from 'next/dynamic';
import { EarthquakeData } from '../types/p2pquake';
import { useLoading } from '../contexts/LoadingContext';
import { supabase } from '../lib/supabase';

const LeafletMap = dynamic(() => import('../components/Map'), {
  ssr: false,
  loading: () => <p>Loading map...</p>
});
import styles from '../styles/Home.module.css';
import { playAlertTone } from '../lib/alertTone';
import { useWebSocket } from '../contexts/WebSocketContext';
import type { WolfxJmaEew, WolfxScEew, WolfxCencEew, WolfxFjEew } from '../types/wolfx';

import Sidebar from '../components/Sidebar';

declare global {
  interface Window {
    triggerEarthquake: () => void;
  }
}

interface Earthquake {
  time: string;
  location: string;
  depth: number;
  magnitude: number;
  intensity: number;
  latitude: number | null;
  longitude: number | null;
  points?: { addr: string; isArea: boolean; pref: string; scale: number }[];
  intensityText?: string; // KMA 원문 진도 텍스트
  source?: 'JMA' | 'KMA';
}

// This interface might need adjustment based on the actual API data structure
interface TransformedData {
  intensity: number;
  intensityText?: string;
  magnitude: number;
  depth: number;
  location: string;
  tsunamiWarning: 'none' | 'watch' | 'warning' | 'major_warning';
  recentEarthquakes: Earthquake[];
  latitude: number | null;
  longitude: number | null;
  points?: { addr: string; isArea: boolean; pref: string; scale: number; lat?: number | null; lng?: number | null }[];
  source?: 'JMA' | 'KMA';
}

const Home = ({ initialEarthquakes }: { initialEarthquakes: Earthquake[] }) => {
  const webSocketContext = useWebSocket();
  const earthquakeData: EarthquakeData[] = webSocketContext?.earthquakeData ?? [];
  const eewData = webSocketContext ? webSocketContext.eewData : null;
  const tsunamiData = webSocketContext ? (webSocketContext as any).tsunamiData : null;
  const simulateEEW = webSocketContext ? webSocketContext.simulateEEW : () => {};
  const wolfxJma: WolfxJmaEew | null = webSocketContext?.wolfxJma ?? null;
  const wolfxSc: WolfxScEew | null = webSocketContext?.wolfxSc ?? null;
  const wolfxCenc: WolfxCencEew | null = webSocketContext?.wolfxCenc ?? null;
  const wolfxFj: WolfxFjEew | null = webSocketContext?.wolfxFj ?? null;

  // Function to transform the raw WebSocket data into the format Sidebar expects
  const transformData = (data: EarthquakeData | null): TransformedData => {
    if (!data || data.code !== 551) { // 551 is for earthquake info
      return {
        intensity: 0,
        intensityText: undefined,
        magnitude: 0,
        depth: 0,
        location: '',
        tsunamiWarning: (() => {
          // If tsunami data present, reflect highest grade
          if (tsunamiData && tsunamiData.code === 552 && !tsunamiData.cancelled) {
            const hasWarning = (tsunamiData.areas || []).some((a: any) => a.grade === 'Warning');
            const hasWatch = (tsunamiData.areas || []).some((a: any) => a.grade === 'Watch');
            if (hasWarning) return 'warning';
            if (hasWatch) return 'watch';
          }
          return 'none';
        })(),
        recentEarthquakes: [],
        latitude: null,
        longitude: null,
        source: 'JMA',
      };
    }

    const earthquake = data.earthquake || {};
    const hypocenter = earthquake.hypocenter || {};

    const intensity = earthquake.maxScale || 0;
    const magnitude = hypocenter.magnitude || 0;
    const depth = hypocenter.depth || 0;
    const location = hypocenter.name || '';
    const latitude = hypocenter.latitude || null;
    const longitude = hypocenter.longitude || null;
    const domesticTsunami = earthquake.domesticTsunami || 'None';

    let tsunamiWarning: TransformedData['tsunamiWarning'] = (() => {
      // Prefer explicit tsunami feed if available
      if (tsunamiData && tsunamiData.code === 552 && !tsunamiData.cancelled) {
        const hasWarning = (tsunamiData.areas || []).some((a: any) => a.grade === 'Warning');
        const hasWatch = (tsunamiData.areas || []).some((a: any) => a.grade === 'Watch');
        if (hasWarning) return 'warning';
        if (hasWatch) return 'watch';
      }
      return 'none';
    })();

    const points = data && 'points' in data ? data.points : [];
    return { intensity, intensityText: undefined, magnitude, depth, location, tsunamiWarning, recentEarthquakes: [], latitude, longitude, points, source: 'JMA' };
  };

  const latestEarthquakeData = earthquakeData ? earthquakeData.find(item => item.code === 551) || null : null;
  const initialSidebarData = transformData(latestEarthquakeData);

  const [displayedEarthquakeData, setDisplayedEarthquakeData] = useState<TransformedData>(initialSidebarData);
  const [isTemporaryDisplay, setIsTemporaryDisplay] = useState(false);
  const [remainingTime, setRemainingTime] = useState(0);
  const [displaySessionId, setDisplaySessionId] = useState(0);
  const [fitKey, setFitKey] = useState(0); // triggers one-time map fit per change
  const [mapInstanceKey, setMapInstanceKey] = useState(0); // force remount when needed
  const [mapInteractive, setMapInteractive] = useState(true); // toggle interactivity
  const [userNavigating, setUserNavigating] = useState(false); // 사용자가 직접 조작 중인지
  const userNavigateTimerRef = useRef<NodeJS.Timeout | null>(null);
  const fitRetryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fitRetryTimeoutRef2 = useRef<NodeJS.Timeout | null>(null);
  const majorToneLoopRef = useRef<NodeJS.Timeout | null>(null);
  const [isPewsAvailable, setIsPewsAvailable] = useState<boolean>(true);
  const { isLoading, setIsLoading } = useLoading();

  const scheduleFit = () => {
    if (fitRetryTimeoutRef.current) clearTimeout(fitRetryTimeoutRef.current);
    if (fitRetryTimeoutRef2.current) clearTimeout(fitRetryTimeoutRef2.current);
    // Allow React render + Map pointCoords effect to settle first
    fitRetryTimeoutRef.current = setTimeout(() => {
      setFitKey(prev => prev + 1);
      // Second stabilization fit
      fitRetryTimeoutRef2.current = setTimeout(() => {
        setFitKey(prev => prev + 1);
      }, 200);
    }, 80);
  };

  // 사용자 조작 감지: 마지막 조작 후 N초 동안은 자동 맞춤을 억제
  useEffect(() => {
    if (!userNavigating) return;
    if (userNavigateTimerRef.current) clearTimeout(userNavigateTimerRef.current);
    userNavigateTimerRef.current = setTimeout(() => {
      setUserNavigating(false);
    }, 8000); // 8초간 사용자 조작으로 간주
    return () => {
      if (userNavigateTimerRef.current) clearTimeout(userNavigateTimerRef.current);
    };
  }, [userNavigating]);

  const handleEewClose = () => {
    if (simulateEEW) {
      simulateEEW(null); // simulateEEW 함수를 사용하여 EEW 데이터를 null로 설정하여 UI 숨김
    }
  };

  const convertIntensityToSpeechString = (intensityValue: number): string => {
    switch (intensityValue) {
      case 10: return '1';
      case 20: return '2';
      case 30: return '3';
      case 40: return '4';
      case 45: return '5弱';
      case 50: return '5強';
      case 55: return '6弱';
      case 60: return '6強';
      case 70: return '7';
      default: return '情報なし';
    }
  };

  

  useEffect(() => {
    window.triggerEarthquake = () => {
      // This functionality is removed as per the edit hint.
      // setIsModalOpen(true);
    };

    return () => {
      window.triggerEarthquake = () => {};
    }
  }, []);

  // Fit once on initial render (refresh)
  useEffect(() => {
    scheduleFit();
  }, []);

  const enrichPointsWithCoords = useCallback(async (
    rawPoints: { addr: string; isArea: boolean; pref: string; scale: number; lat?: number | null; lng?: number | null }[]
  ) => {
    setIsLoading(true);
    try {
      if (!rawPoints || rawPoints.length === 0) return [] as typeof rawPoints;

      const addressKeyOf = (p: { pref: string; addr: string }) => `${p.pref} ${p.addr}`.trim();

      // Separate already-known coords and those needing enrichment
      const coordinatesByKey = new Map<string, { lat: number | null; lng: number | null }>();
      const pointsNeedingCoords: Array<{ idx: number; point: typeof rawPoints[number]; addressKey: string }> = [];

      rawPoints.forEach((point, idx) => {
        if (point.lat !== undefined && point.lat !== null && point.lng !== undefined && point.lng !== null) {
          coordinatesByKey.set(addressKeyOf(point), { lat: point.lat, lng: point.lng });
        } else {
          const addressKey = addressKeyOf(point);
          pointsNeedingCoords.push({ idx, point, addressKey });
        }
      });

      if (pointsNeedingCoords.length === 0) return rawPoints;

      // Batch fetch from Supabase cache
      const uniqueKeys = Array.from(new Set(pointsNeedingCoords.map(p => p.addressKey)));
      try {
        const { data: cachedRows } = await supabase
          .from('geocoded_locations')
          .select('address, lat, lng')
          .in('address', uniqueKeys);
        if (cachedRows) {
          for (const row of cachedRows) {
            coordinatesByKey.set(row.address, { lat: row.lat, lng: row.lng });
          }
        }
      } catch (e) {
        // ignore cache fetch errors, proceed with geocoding
      }

      // Filter those still needing external geocoding
      const toGeocode = pointsNeedingCoords.filter(p => !coordinatesByKey.has(p.addressKey));

      // Geocode concurrently with configurable limit and retries
      const resultsToInsert: Array<{ address: string; lat: number; lng: number }> = [];

      const fetchWithTimeout = async (input: RequestInfo | URL, init?: RequestInit & { timeoutMs?: number }) => {
        const { timeoutMs = 10000, ...rest } = init || {};
        const ctrl = new AbortController();
        const id = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          return await fetch(input, { ...rest, signal: ctrl.signal } as any);
        } finally {
          clearTimeout(id);
        }
      };

      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      const geocodeWithRetry = async (addressKey: string, maxRetries = 3) => {
        let attempt = 0;
        let lastError: any = null;
        const keys = ((process.env.NEXT_PUBLIC_OPENCAGE_API_KEYS || process.env.NEXT_PUBLIC_OPENCAGE_API_KEY || '')
          .split(',')
          .map(k => k.trim())
          .filter(Boolean));

        // If no keys configured, skip straight to fallback
        if (keys.length === 0) {
          console.warn('No OpenCage API keys configured');
        } else {
          // Try each key, with per-key retry on 429
          for (let ki = 0; ki < keys.length; ki++) {
            attempt = 0;
            const key = keys[ki];
            while (attempt < maxRetries) {
              try {
                const res = await fetchWithTimeout(
                  `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(addressKey)}&key=${key}&language=ja&countrycode=jp&limit=1`,
                  { timeoutMs: 10000 }
                );
                if (res.status === 429) {
                  // Rate-limited: wait and retry same key
                  const backoff = 800 * (attempt + 1);
                  await sleep(backoff);
                  attempt++;
                  continue;
                }
                if (!res.ok) {
                  // 401/402/403/5xx etc: move to next key
                  break;
                }
                const geoData = await res.json();
                if (geoData.results && geoData.results.length > 0) {
                  const { lat, lng } = geoData.results[0].geometry;
                  return { lat, lng } as { lat: number; lng: number };
                }
                return { lat: null, lng: null } as { lat: number | null; lng: number | null };
              } catch (e) {
                lastError = e;
                const backoff = 800 * (attempt + 1);
                await sleep(backoff);
                attempt++;
              }
            }
          }
        }
        // Fallback provider: geocode.maps.co (Nominatim-backed)
        try {
          const res2 = await fetchWithTimeout(
            `https://geocode.maps.co/search?q=${encodeURIComponent(addressKey)}`,
            { timeoutMs: 10000 }
          );
          if (res2.ok) {
            const alt = await res2.json();
            if (Array.isArray(alt) && alt.length > 0) {
              const lat = parseFloat(alt[0].lat);
              const lng = parseFloat(alt[0].lon);
              if (Number.isFinite(lat) && Number.isFinite(lng)) {
                return { lat, lng } as { lat: number; lng: number };
              }
            }
          }
        } catch (e2) {
          lastError = e2;
        }
        console.error('Geocoding failed after retries and fallback for', addressKey, lastError);
        return { lat: null, lng: null } as { lat: number | null; lng: number | null };
      };

      const limit = Number.parseInt(process.env.NEXT_PUBLIC_GEOCODE_CONCURRENCY || '1', 10);
      for (let i = 0; i < toGeocode.length; i += limit) {
        const batch = toGeocode.slice(i, i + limit);
        await Promise.all(
          batch.map(async ({ point, addressKey }, idx) => {
            // Stagger starts inside the batch to reduce burstiness
            await sleep(idx * 250);
            try {
              const result = await geocodeWithRetry(addressKey);
              if (result.lat !== null && result.lng !== null) {
                const { lat, lng } = result;
                coordinatesByKey.set(addressKey, { lat, lng });
                resultsToInsert.push({ address: addressKey, lat, lng });
              } else {
                coordinatesByKey.set(addressKey, { lat: null, lng: null });
              }
            } catch (e) {
              console.error('Geocoding failed for', point.addr, e);
              coordinatesByKey.set(addressKey, { lat: null, lng: null });
            }
          })
        );
      }

      // Bulk insert new geocoded results (best-effort)
      if (resultsToInsert.length > 0) {
        try {
          await supabase.from('geocoded_locations').insert(resultsToInsert);
        } catch (e) {
          console.error('Failed to bulk-insert geocoded_locations:', e);
        }
      }

      // Reconstruct enriched list preserving original order
      const enriched = rawPoints.map(point => {
        if (point.lat !== undefined && point.lat !== null && point.lng !== undefined && point.lng !== null) {
          return point;
        }
        const key = addressKeyOf(point);
        const coords = coordinatesByKey.get(key);
        if (coords) {
          return { ...point, lat: coords.lat ?? null, lng: coords.lng ?? null };
        }
        return { ...point, lat: null, lng: null };
      });

      return enriched;
    } finally {
      setIsLoading(false);
    }
  }, [setIsLoading]);

  // Update displayed data when latest earthquake data changes, unless a temporary display is active
  useEffect(() => {
    if (!isTemporaryDisplay) {
      const update = async () => {
        const base = transformData(latestEarthquakeData);
        const points = latestEarthquakeData && 'points' in latestEarthquakeData ? (latestEarthquakeData as any).points : [];
        if (points && points.length > 0) {
          const enriched = await enrichPointsWithCoords(points);
          setDisplayedEarthquakeData({ ...base, points: enriched });
          if (!userNavigating) scheduleFit();
          setMapInteractive(true);
        } else {
          setDisplayedEarthquakeData(base);
          if (!userNavigating) scheduleFit();
          setMapInteractive(true);
        }
      };
      update();
    }

    // TTS Announcement
    const storedLastAnnouncedEarthquakeTime = localStorage.getItem('lastAnnouncedEarthquakeTime');
    if (latestEarthquakeData && latestEarthquakeData.time !== storedLastAnnouncedEarthquakeTime) {
      if ((latestEarthquakeData as any).syntheticFromTsunami) {
        // For tsunami-triggered synthetic 551, skip 551 TTS; 552 TTS will handle it
        localStorage.setItem('lastAnnouncedEarthquakeTime', latestEarthquakeData.time);
        return;
      }
      console.log("Announcing new earthquake via TTS:", latestEarthquakeData.time);
      const earthquake = latestEarthquakeData.earthquake || {};
      const hypocenter = earthquake.hypocenter || {};

      const intensity = earthquake.maxScale || 0;
      const magnitude = hypocenter.magnitude || 0;
      const location = hypocenter.name || '不明';
      const domesticTsunami = earthquake.domesticTsunami || 'None';

      const freeFormComment = latestEarthquakeData.comments?.freeFormComment || '';

      let tsunamiMessage = '';
      if (domesticTsunami === 'Warning') {
        tsunamiMessage = '津波警報が発表されています。';
      } else if (domesticTsunami === 'Watch') {
        tsunamiMessage = '津波注意報が発表されています。';
      } else if (domesticTsunami === 'MajorWarning') {
        tsunamiMessage = '大津波警報が発表されています。';
      } else if (domesticTsunami === 'None') {
        tsunamiMessage = '津波の心配はありません。';
      }

      const commentText = freeFormComment ? `特異事項および伝達事項が届きました。内容は次のとおりです。 ${freeFormComment}` : '';
      const speechText = `地震情報。最大震度${convertIntensityToSpeechString(intensity)}の地震が発生しました。規模はマグニチュード${magnitude.toFixed(1)}、震源地は${location}です。${tsunamiMessage} ${commentText}`;

      if ('speechSynthesis' in window) {
        const audio = new Audio('/notification.mp3');
        audio.volume = 0.2;
        audio.play().catch(e => console.error("Error playing sound:", e));

        setTimeout(() => {
          audio.pause();
          audio.currentTime = 0;
          const utterance = new SpeechSynthesisUtterance(speechText);
          utterance.lang = 'ja-JP'; // Set language to Japanese
          window.speechSynthesis.speak(utterance);
        }, 1500);
      } else {
        console.warn("Browser does not support Web Speech API for TTS.");
      }
      localStorage.setItem('lastAnnouncedEarthquakeTime', latestEarthquakeData.time);

      
    }
  }, [latestEarthquakeData, tsunamiData, isTemporaryDisplay, userNavigating]);

  // TTS for Tsunami (code 552) - Japanese announcement
  useEffect(() => {
    if (!tsunamiData || (tsunamiData as any).code !== 552) return;
    if ((tsunamiData as any).cancelled) return;
    try {
      const last = localStorage.getItem('lastAnnouncedTsunamiTime');
      const timeStr = (tsunamiData as any).time || '';
      if (last === timeStr) {
        // Allow retrigger if user wants to test repeatedly, or if last play was >15s ago
        const allow = localStorage.getItem('ALLOW_TTS_REPEAT_552') === '1';
        const lastMsStr = localStorage.getItem('lastAnnouncedTsunamiMs');
        const lastMs = lastMsStr ? parseInt(lastMsStr, 10) : 0;
        const nowMs = Date.now();
        const elapsed = nowMs - lastMs;
        if (!allow && !(elapsed > 15000)) return;
      }

      const areas = Array.isArray((tsunamiData as any).areas) ? (tsunamiData as any).areas : [];
      const hasWarning = areas.some((a: any) => a && a.grade === 'Warning');
      const hasWatch = areas.some((a: any) => a && a.grade === 'Watch');
      const gradeKo = hasWarning ? '津波警報' : hasWatch ? '津波注意報' : '津波情報';
      const items = areas
        .filter((a: any) => a && a.name)
        .slice(0, 6)
        .map((a: any) => {
          const v = a?.maxHeight?.value;
          if (typeof v === 'number' && isFinite(v)) return `${a.name}に${v}メートル`;
          return `${a.name}`;
        });
      const list = items.join('、');
      const suffix = areas.length > 6 ? `、ほか${areas.length - 6}地域` : '';
      const commentExtra = (
        latestEarthquakeData &&
        (latestEarthquakeData as any).syntheticFromTsunami &&
        latestEarthquakeData.comments?.freeFormComment
      ) ? ` 特異事項および伝達事項が届きました。内容は次のとおりです。${latestEarthquakeData.comments?.freeFormComment}` : '';
      const intro = '海岸や河口付近にいる方は、直ちに高台や海から離れた安全な場所へ避難してください。テレビやラジオの情報を確認しながら避難を続けてください。津波は繰り返し押し寄せるおそれがあります。絶対に海や川に近づかないでください。周囲の方にも避難を呼びかけてください。';
      const speechText = `${gradeKo}。${gradeKo}が発表されました。${intro}現在、${gradeKo}が発表されている区域は次のとおりです。${list}${suffix}。${commentExtra}`;

      if ('speechSynthesis' in window) {
        const isWatchOnly = hasWatch && !hasWarning; // 津波注意報のみ
        const isWarning = hasWarning; // 津波警報
        const isMajor = areas.some((a: any) => a && a.grade === 'MajorWarning'); // 大津波警報
        const src = isMajor ? '/warning4.mp3' : (isWarning ? '/warning3.mp3' : (isWatchOnly ? '/warning2.mp3' : '/notification.mp3'));
        const cutMs = isMajor ? 3000 : (isWarning ? 2000 : 1100); // 大津波=3.0s, 警報=2.0s, 注意報=1.1s

        const speak = () => {
          try { window.speechSynthesis.cancel(); } catch {}
          const utterance = new SpeechSynthesisUtterance(speechText);
          utterance.lang = 'ja-JP';
          try { utterance.rate = Number(localStorage.getItem('TTS_RATE_552') || '1.2'); } catch { utterance.rate = 1.5; }
          utterance.pitch = 1;
          try { utterance.volume = Math.min(1, Number(localStorage.getItem('TTS_VOL_552') || (isMajor ? '1.0' : '1.0'))); } catch { utterance.volume = 1; }
          window.speechSynthesis.speak(utterance);
          // For MajorWarning, repeat once to increase perceived loudness
          if (isMajor) {
            setTimeout(() => {
              const u2 = new SpeechSynthesisUtterance(speechText);
              u2.lang = 'ja-JP';
              u2.rate = utterance.rate;
              u2.pitch = utterance.pitch;
              u2.volume = utterance.volume;
              window.speechSynthesis.speak(u2);
            }, 250);
          }
        };

        // Pitch shift without speed-up using Tone.js (fallbacks if unavailable)
        const semis = Number(localStorage.getItem('TTS_TONE_SEMITONES_552') || (isMajor ? '6' : (isWarning ? '5' : '4')));
        const vol = Number(localStorage.getItem('TTS_TONE_VOL_552') || (isMajor ? '1.0' : (isWarning ? '1.0' : (isWatchOnly ? '1.0' : '0.35'))));
        const gain = Number(localStorage.getItem('TTS_TONE_GAIN_552') || (isMajor ? '2.0' : (isWarning ? '1.6' : (isWatchOnly ? '1.4' : '1.0'))));
        playAlertTone({ src, cutMs, semitones: semis, volume: vol, gain }).finally(() => speak());

        // For 大津波警報: keep repeating tone until cleared
        if (isMajor) {
          if (majorToneLoopRef.current) {
            clearInterval(majorToneLoopRef.current as unknown as number);
            majorToneLoopRef.current = null;
          }
          const loopIntervalMs = Math.max(3500, cutMs + 500);
          majorToneLoopRef.current = setInterval(() => {
            playAlertTone({ src, cutMs, semitones: semis, volume: vol, gain }).catch(() => {});
          }, loopIntervalMs) as unknown as NodeJS.Timeout;
        } else {
          if (majorToneLoopRef.current) {
            clearInterval(majorToneLoopRef.current as unknown as number);
            majorToneLoopRef.current = null;
          }
        }
      }
      localStorage.setItem('lastAnnouncedTsunamiTime', timeStr);
      localStorage.setItem('lastAnnouncedTsunamiMs', String(Date.now()));
    } catch {}
    return () => {
      if (majorToneLoopRef.current) {
        clearInterval(majorToneLoopRef.current as unknown as number);
        majorToneLoopRef.current = null;
      }
    };
  }, [tsunamiData, latestEarthquakeData]);

  // Fallback on refresh before live data arrives: show first pre-rendered earthquake and fit once
  useEffect(() => {
    if (isTemporaryDisplay) return;
    const hasLive = !!latestEarthquakeData && (latestEarthquakeData as any).code === 551;
    if (!hasLive && initialEarthquakes && initialEarthquakes.length > 0) {
      const first = initialEarthquakes[0];
      setDisplayedEarthquakeData({
        intensity: first.intensity,
        magnitude: first.magnitude,
        depth: first.depth,
        location: first.location,
        tsunamiWarning: 'none',
        recentEarthquakes: [],
        latitude: first.latitude,
        longitude: first.longitude,
        points: first.points || [],
      });
      scheduleFit();
    }
  }, [initialEarthquakes, isTemporaryDisplay, latestEarthquakeData]);

  const [allEarthquakes, setAllEarthquakes] = useState<Earthquake[]>(initialEarthquakes);
  const [kmaEarthquakes, setKmaEarthquakes] = useState<Earthquake[]>([]);

  useEffect(() => {
    const newEarthquakes = earthquakeData
      .filter((msg): msg is EarthquakeData => msg.code === 551)
      .map(msg => ({
        time: msg.time,
        location: msg.earthquake.hypocenter.name,
        depth: msg.earthquake.hypocenter.depth || 0,
        magnitude: msg.earthquake.hypocenter.magnitude || 0,
        intensity: msg.earthquake.maxScale || 0,
        latitude: msg.earthquake.hypocenter.latitude,
        longitude: msg.earthquake.hypocenter.longitude,
        points: msg.points || [],
        source: 'JMA' as const,
      }));

    setAllEarthquakes(prevEarthquakes => {
      const combined = [...newEarthquakes, ...prevEarthquakes];
      const uniqueEarthquakes = Array.from(new Map(combined.map(item => [item.time, item])).values());
      return uniqueEarthquakes.slice(0, 100); // Keep the latest 100 earthquakes
    });
  }, [earthquakeData]);

  // KMA 최근 지진 데이터 주기적 수집 (1분 간격)
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const res = await fetch('/api/kma');
        if (!res.ok) return;
        const json = await res.json();
        if (!mounted) return;
        const list = Array.isArray(json?.data) ? json.data : [];
        // Ensure fields are present and typed
        const mapped: Earthquake[] = list.map((e: any) => ({
          time: e.time,
          location: e.location || '',
          depth: Number.isFinite(e.depth) ? e.depth : 0,
          magnitude: Number.isFinite(e.magnitude) ? e.magnitude : 0,
          intensity: Number.isFinite(e.intensity) ? e.intensity : -1,
          latitude: Number.isFinite(e.latitude) ? e.latitude : null,
          longitude: Number.isFinite(e.longitude) ? e.longitude : null,
          intensityText: typeof e.intensityText === 'string' && e.intensityText ? e.intensityText : undefined,
          source: 'KMA' as const,
        }));
        setKmaEarthquakes(mapped);
      } catch {} 
    };
    load();
    const id = setInterval(load, 1000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  // 최근 지진: JMA(P2P) + KMA 통합 후 최신순 상위 30개
  const recentEarthquakes = [...allEarthquakes, ...kmaEarthquakes]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 30);

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const handleEarthquakeClick = async (earthquake: Earthquake) => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }

    const enrichedPoints = await enrichPointsWithCoords(earthquake.points || []);

    const newDisplayedData: TransformedData = {
      intensity: earthquake.intensity,
      intensityText: earthquake.intensityText,
      magnitude: earthquake.magnitude,
      depth: earthquake.depth,
      location: earthquake.location,
      tsunamiWarning: 'none' as TransformedData['tsunamiWarning'],
      recentEarthquakes: [],
      latitude: earthquake.latitude,
      longitude: earthquake.longitude,
      points: enrichedPoints,
      source: earthquake.source,
    };

    setDisplayedEarthquakeData(newDisplayedData);
    setIsTemporaryDisplay(true);
    setRemainingTime(15);
    setDisplaySessionId(prev => prev + 1);
    // For KMA (Korean) recent earthquakes, do not trigger map fit/zoom
    if (earthquake.source !== 'KMA') {
      // Trigger delayed fit(s) so that points are propagated to Map first
      if (!userNavigating) scheduleFit();
      setMapInteractive(true);
    } else {
      // Korean quake: refresh map instance and disable interactions
      setMapInstanceKey(prev => prev + 1);
      setMapInteractive(false);
    }
  };

  useEffect(() => {
    if (isTemporaryDisplay && !isLoading) {
      timerRef.current = setInterval(() => {
        setRemainingTime(prevTime => {
          if (prevTime <= 1) {
            clearInterval(timerRef.current!);
            setIsTemporaryDisplay(false);
            setDisplayedEarthquakeData(transformData(latestEarthquakeData));
            scheduleFit();
            setMapInteractive(true);
            return 0;
          }
          return prevTime - 1;
        });
      }, 1000);
    } else if (isLoading && timerRef.current) {
      clearInterval(timerRef.current);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isTemporaryDisplay, isLoading, latestEarthquakeData, displaySessionId]);

  return (
    <div className={styles.container}>
      <Head>
        <title>EQO</title>
        <meta name="description" content="Earthquake and Tsunami Information" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main className={styles.main}>
        {(() => null)()}
        <Sidebar
          {...displayedEarthquakeData}
          tsunamiWarning={(function(){
            const td: any = tsunamiData as any;
            if (td && td.code === 552 && !td.cancelled) {
              const areas = Array.isArray(td.areas) ? td.areas : [];
              if (areas.some((a:any)=>a && a.grade==='MajorWarning')) return 'major_warning' as const;
              if (areas.some((a:any)=>a && a.grade==='Warning')) return 'warning' as const;
              if (areas.some((a:any)=>a && a.grade==='Watch')) return 'watch' as const;
            }
            return 'none' as const;
          })()}
          freeFormComment={latestEarthquakeData?.comments?.freeFormComment}
          recentEarthquakes={recentEarthquakes}
          onEarthquakeClick={handleEarthquakeClick}
          isTemporaryDisplay={isTemporaryDisplay}
          remainingTime={remainingTime}
          eewData={eewData}
          onEewClose={handleEewClose}
          isPewsAvailable={isPewsAvailable}
          wolfxJma={wolfxJma}
          wolfxSc={wolfxSc}
          wolfxCenc={wolfxCenc}
          wolfxFj={wolfxFj}
        />
                <LeafletMap
                  key={`earthquake-map-${mapInstanceKey}`}
                  earthquake={displayedEarthquakeData}
                  eewData={eewData}
                  points={displayedEarthquakeData.points}
                  fitKey={fitKey}
                  onPewsAvailableChange={setIsPewsAvailable}
                  wolfxJma={wolfxJma}
                  wolfxSc={wolfxSc}
                  wolfxCenc={wolfxCenc}
                  wolfxFj={wolfxFj}
                  tsunamiAreas={(function(){
                    const td:any = tsunamiData as any;
                    if (td && td.code === 552 && !td.cancelled && Array.isArray(td.areas)) {
                      return td.areas.map((a:any)=>({ name: a.name, grade: a.grade, height: a?.maxHeight?.value }));
                    }
                    return [] as any[];
                  })()}
                  interactive={mapInteractive}
                  onUserInteracted={() => setUserNavigating(true)}
                  disableAutoFit={userNavigating}
                />
      </main>
    </div>
  );
};

// keep above import only once; remove duplicate

export async function getStaticProps() {
  // Allow skipping remote fetch during build with env toggle
  if (
    process.env.NEXT_PUBLIC_DISABLE_BUILD_FETCH === '1' ||
    process.env.NEXT_PUBLIC_USE_LOCAL_P2PQUAKE_JSON === '1'
  ) {
    return { props: { initialEarthquakes: [] }, revalidate: 60 };
  }

  const fetchWithTimeout = async (input: RequestInfo | URL, init?: RequestInit & { timeoutMs?: number }) => {
    const { timeoutMs = 5000, ...rest } = init || {};
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(input, { ...rest, signal: ctrl.signal } as any);
    } finally {
      clearTimeout(id);
    }
  };

  try {
    const res = await fetchWithTimeout('https://api.p2pquake.net/v2/jma/quake?limit=30', { timeoutMs: 5000 });
    const data = await res.json();

    const initialEarthquakes = await Promise.all(
      data.map(async (msg: EarthquakeData) => {
        // For build speed and reliability, do not geocode here; keep provided coords only
        const pointsWithCoords = (msg.points || []).map((point: any) => ({
          ...point,
          lat: point.lat ?? null,
          lng: point.lng ?? null,
        }));

        return {
          time: msg.time,
          location: msg.earthquake.hypocenter.name,
          depth: msg.earthquake.hypocenter.depth || 0,
          magnitude: msg.earthquake.hypocenter.magnitude || 0,
          intensity: msg.earthquake.maxScale || 0,
          latitude: msg.earthquake.hypocenter.latitude,
          longitude: msg.earthquake.hypocenter.longitude,
          points: pointsWithCoords,
        };
      })
    );

    return {
      props: {
        initialEarthquakes,
      },
      revalidate: 60,
    };
  } catch {
    // Fallback to empty list if network fails or times out
    return { props: { initialEarthquakes: [] }, revalidate: 60 };
  }
}

export default Home;
