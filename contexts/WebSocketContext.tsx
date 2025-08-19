import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { P2PQuakeData, EarthquakeData, EEWData, TsunamiData } from '../types/p2pquake';
import type { WolfxJmaEew, WolfxScEew, WolfxCencEew, WolfxFjEew } from '../types/wolfx';

interface WebSocketContextType {
  earthquakeData: EarthquakeData[] | null;
  eewData: EEWData | null;
  tsunamiData: TsunamiData | null;
  // Wolfx sources
  wolfxJma: WolfxJmaEew | null;
  wolfxSc: WolfxScEew | null;
  wolfxCenc: WolfxCencEew | null;
  wolfxFj: WolfxFjEew | null;
  simulateEarthquake: (earthquakeData: EarthquakeData) => void;
  simulateEEW: (eewData: EEWData | null) => void;
  wolfxStatus: {
    jmaConnected: boolean;
    scConnected: boolean;
    fjConnected: boolean;
    jmaLast: number | null;
    scLast: number | null;
    fjLast: number | null;
    cencLast: number | null;
  };
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => useContext(WebSocketContext);

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const [earthquakeData, setEarthquakeData] = useState<EarthquakeData[]>([]);
  const [eewData, setEewData] = useState<EEWData | null>(null);
  const [tsunamiData, setTsunamiData] = useState<TsunamiData | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
  const isMounted = useRef(false); // Add this ref to track mount status
  const localPollRef = useRef<NodeJS.Timeout | null>(null);
  const usingLocalRef = useRef<boolean>(false);
  const localPathRef = useRef<string>(
    (process.env.NEXT_PUBLIC_P2PQUAKE_TEST_FILE || '/p2pquake_test.json') as string
  );
  const lastLocalHashRef = useRef<string | null>(null);

  // Wolfx connections
  const wolfxJmaWs = useRef<WebSocket | null>(null);
  const wolfxScWs = useRef<WebSocket | null>(null);
  const wolfxFjWs = useRef<WebSocket | null>(null);
  const [wolfxJma, setWolfxJma] = useState<WolfxJmaEew | null>(null);
  const [wolfxSc, setWolfxSc] = useState<WolfxScEew | null>(null);
  const [wolfxCenc, setWolfxCenc] = useState<WolfxCencEew | null>(null);
  const [wolfxFj, setWolfxFj] = useState<WolfxFjEew | null>(null);
  const cencIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const wolfxBackoffMsRef = useRef<number>(5000);
  const wolfxLockIdRef = useRef<string | null>(null);
  const [wolfxStatus, setWolfxStatus] = useState({
    jmaConnected: false,
    scConnected: false,
    fjConnected: false,
    jmaLast: null as number | null,
    scLast: null as number | null,
    fjLast: null as number | null,
    cencLast: null as number | null,
  });

  const simulateEarthquake = (data: EarthquakeData) => {
    setEarthquakeData(prevData => [data, ...prevData]);
  };

  const ingestP2pquakePayload = (payload: any) => {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    twoDaysAgo.setHours(0, 0, 0, 0);

    const handleOne = (d: any) => {
      if (!d || typeof d !== 'object' || typeof d.code !== 'number') return;
      if (d.code === 551) {
        setEarthquakeData(prev => {
          const filteredPrev = prev.filter(item => new Date(item.time) >= twoDaysAgo);
          return [d as EarthquakeData, ...filteredPrev].slice(0, 50);
        });
      } else if (d.code === 556) {
        setEewData(d as EEWData);
      } else if (d.code === 552) {
        const tsu = d as TsunamiData;
        setTsunamiData(tsu);
        // Also synthesize a fake 551 to reuse existing TTS/UI pipeline
        if (!tsu.cancelled) {
          const areas = Array.isArray(tsu.areas) ? tsu.areas : [];
          const firstName = (areas[0] && areas[0].name) ? areas[0].name : '沿岸海域';
          const hasWarning = areas.some(a => a && a.grade === 'Warning');
          const hasWatch = areas.some(a => a && a.grade === 'Watch');
          const domesticTsunami = hasWarning ? 'Warning' : hasWatch ? 'Watch' : 'None';
          const nowIso = new Date().toISOString();
          const synthetic: EarthquakeData = {
            code: 551,
            time: nowIso,
            earthquake: {
              maxScale: 0,
              domesticTsunami,
              hypocenter: {
                name: `${firstName}`,
                latitude: 35.0,
                longitude: 139.0,
                depth: 10,
                magnitude: 3.0,
              }
            },
            comments: {
              freeFormComment: '津波情報に基づくテスト用の仮想地震です。'
            },
            points: []
          };
          // Mark to suppress normal 551 TTS; we will use 552-specific TTS instead
          (synthetic as any).syntheticFromTsunami = true;
          setEarthquakeData(prev => {
            const twoDaysAgoLocal = new Date();
            twoDaysAgoLocal.setDate(twoDaysAgoLocal.getDate() - 2);
            twoDaysAgoLocal.setHours(0, 0, 0, 0);
            const filteredPrev = prev.filter(item => new Date(item.time) >= twoDaysAgoLocal);
            return [synthetic, ...filteredPrev].slice(0, 50);
          });
        }
      }
    };

    if (Array.isArray(payload)) {
      payload.forEach(handleOne);
    } else {
      handleOne(payload);
    }
  };

  const tryStartLocalMode = async (): Promise<boolean> => {
    const forceLocal = process.env.NEXT_PUBLIC_USE_LOCAL_P2PQUAKE_JSON === '1';
    const url = localPathRef.current;
    const withNoCache = `${url}${url.includes('?') ? '&' : '?'}ts=${Date.now()}`;
    try {
      const resp = await fetch(withNoCache, { cache: 'no-store' } as RequestInit);
      if (!resp.ok) {
        if (forceLocal) console.warn('Local P2PQuake test file not found or not OK:', url, resp.status);
        return false;
      }
      const json = await resp.json();
      const hash = JSON.stringify(json);
      if (lastLocalHashRef.current !== hash) {
        ingestP2pquakePayload(json);
        lastLocalHashRef.current = hash;
      }
      usingLocalRef.current = true;
      // Poll for changes every 2s (lightweight, no-cache)
      if (localPollRef.current) clearInterval(localPollRef.current as unknown as number);
      const pollMs = Number(process.env.NEXT_PUBLIC_P2PQUAKE_POLL_MS || '2000');
      if (pollMs > 0) {
        localPollRef.current = setInterval(async () => {
          try {
            const r = await fetch(`${url}?ts=${Date.now()}`, { cache: 'no-store' } as RequestInit);
            if (!r.ok) return;
            const j = await r.json();
            const h = JSON.stringify(j);
            if (lastLocalHashRef.current !== h) {
              ingestP2pquakePayload(j);
              lastLocalHashRef.current = h;
            }
          } catch {}
        }, pollMs) as unknown as NodeJS.Timeout;
      }
      return true;
    } catch (e) {
      if (forceLocal) console.error('Failed to load local P2PQuake test file:', e);
      return false;
    }
  };

  const connectWebSocket = () => {
    if (ws.current) {
      ws.current.close(); // Close existing connection if any
    }

    ws.current = new WebSocket('wss://api.p2pquake.net/v2/ws');

    ws.current.onopen = () => {
      console.log('WebSocket connected');
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
        reconnectTimeout.current = null;
      }
    };

    ws.current.onmessage = (event) => {
      try {
        const receivedData: P2PQuakeData = JSON.parse(event.data);

        if (receivedData.code === 551) {
          console.log("Received Earthquake Data (code 551). Checking for points field:", receivedData.points);
          setEarthquakeData(prevData => {
            const twoDaysAgo = new Date();
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
            twoDaysAgo.setHours(0, 0, 0, 0);

            const filteredPrevData = prevData.filter(item => new Date(item.time) >= twoDaysAgo);
            const updatedData = [receivedData as EarthquakeData, ...filteredPrevData];

            const latestEarthquake = updatedData.find((item: EarthquakeData) => item.code === 551);
            const storedLastPlayedSoundTime = localStorage.getItem('lastPlayedSoundTime');

            if (latestEarthquake && latestEarthquake.time !== storedLastPlayedSoundTime) {
              console.log("Playing notification sound for new earthquake:", latestEarthquake.time);
              localStorage.setItem('lastPlayedSoundTime', latestEarthquake.time);
            }

            return updatedData;
          });
        } else if (receivedData.code === 556) {
          setEewData(receivedData as EEWData);
          console.log("Received EEW Data:", receivedData);
        } else if (receivedData.code === 552) {
          setTsunamiData(receivedData as TsunamiData);
          console.log("Received Tsunami Data:", receivedData);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    ws.current.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.current.onclose = (event) => {
      console.log('WebSocket disconnected:', event.code, event.reason);
      if (!event.wasClean && event.code !== 1000) {
        console.log('Attempting to reconnect WebSocket...');
        reconnectTimeout.current = setTimeout(connectWebSocket, 3000);
      }
    };
  };

  // Connect Wolfx WebSockets (JMA, SC, FJ). CENC is HTTP only per docs.
  const acquireWolfxLock = (): boolean => {
    try {
      const now = Date.now();
      const myId = wolfxLockIdRef.current || Math.random().toString(36).slice(2);
      wolfxLockIdRef.current = myId;
      const raw = localStorage.getItem('wolfx_lock');
      const parsed = raw ? JSON.parse(raw) as { id: string; ts: number } : null;
      if (!parsed || (now - parsed.ts) > 10000) {
        localStorage.setItem('wolfx_lock', JSON.stringify({ id: myId, ts: now }));
        return true;
      }
      return parsed.id === myId;
    } catch {}
    return true;
  };

  const refreshWolfxLock = () => {
    try {
      if (!wolfxLockIdRef.current) return;
      localStorage.setItem('wolfx_lock', JSON.stringify({ id: wolfxLockIdRef.current, ts: Date.now() }));
    } catch {}
  };

  useEffect(() => {
    const id = setInterval(refreshWolfxLock, 3000) as unknown as NodeJS.Timeout;
    return () => { try { clearInterval(id as unknown as number); } catch {} };
  }, []);

  useEffect(() => {
    const beforeUnload = () => {
      try {
        const raw = localStorage.getItem('wolfx_lock');
        const parsed = raw ? JSON.parse(raw) as { id: string; ts: number } : null;
        if (parsed && parsed.id === wolfxLockIdRef.current) localStorage.removeItem('wolfx_lock');
      } catch {}
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  const isWolfxDisabled = (): boolean => {
    if (process.env.NEXT_PUBLIC_DISABLE_WOLFX === '1') return true;
    try { return localStorage.getItem('DISABLE_WOLFX') === '1'; } catch { return false; }
  };

  const closeWolfx = () => {
    try { if (wolfxJmaWs.current) wolfxJmaWs.current.close(1000, 'Disabled'); } catch {}
    try { if (wolfxScWs.current) wolfxScWs.current.close(1000, 'Disabled'); } catch {}
    try { if (wolfxFjWs.current) wolfxFjWs.current.close(1000, 'Disabled'); } catch {}
    setWolfxStatus(s => ({ ...s, jmaConnected: false, scConnected: false, fjConnected: false }));
  };

  const connectWolfx = () => {
    if (isWolfxDisabled()) { closeWolfx(); return; }
    if (document.visibilityState !== 'visible') return;
    if (!acquireWolfxLock()) return;
    try {
      if (wolfxJmaWs.current) wolfxJmaWs.current.close();
      wolfxJmaWs.current = new WebSocket('wss://ws-api.wolfx.jp/jma_eew');
      wolfxJmaWs.current.onopen = () => {
        setWolfxStatus(s => ({ ...s, jmaConnected: true }));
        wolfxBackoffMsRef.current = 5000;
      };
      wolfxJmaWs.current.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as WolfxJmaEew;
          if (data && data.jma_eew) setWolfxJma(data);
          setWolfxStatus(s => ({ ...s, jmaLast: Date.now() }));
        } catch (e) {}
      };
      wolfxJmaWs.current.onclose = () => {
        setWolfxStatus(s => ({ ...s, jmaConnected: false }));
        // try to reconnect after 3s
        const delay = isWolfxDisabled() ? 0 : Math.min(60000, wolfxBackoffMsRef.current * 2);
        wolfxBackoffMsRef.current = delay;
        if (delay > 0) setTimeout(() => { if (!isWolfxDisabled() && document.visibilityState === 'visible') connectWolfx(); }, delay);
      };
    } catch {}

    try {
      if (wolfxScWs.current) wolfxScWs.current.close();
      wolfxScWs.current = new WebSocket('wss://ws-api.wolfx.jp/sc_eew');
      wolfxScWs.current.onopen = () => {
        setWolfxStatus(s => ({ ...s, scConnected: true }));
        wolfxBackoffMsRef.current = 5000;
      };
      wolfxScWs.current.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as WolfxScEew;
          if (data && data.sc_eew) setWolfxSc(data);
          setWolfxStatus(s => ({ ...s, scLast: Date.now() }));
        } catch (e) {}
      };
      wolfxScWs.current.onclose = () => {
        setWolfxStatus(s => ({ ...s, scConnected: false }));
        const delay = isWolfxDisabled() ? 0 : Math.min(60000, wolfxBackoffMsRef.current * 2);
        wolfxBackoffMsRef.current = delay;
        if (delay > 0) setTimeout(() => { if (!isWolfxDisabled() && document.visibilityState === 'visible') connectWolfx(); }, delay);
      };
    } catch {}

    try {
      if (wolfxFjWs.current) wolfxFjWs.current.close();
      wolfxFjWs.current = new WebSocket('wss://ws-api.wolfx.jp/fj_eew');
      wolfxFjWs.current.onopen = () => {
        setWolfxStatus(s => ({ ...s, fjConnected: true }));
        wolfxBackoffMsRef.current = 5000;
      };
      wolfxFjWs.current.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as WolfxFjEew;
          if (data && data.fj_eew) setWolfxFj(data);
          setWolfxStatus(s => ({ ...s, fjLast: Date.now() }));
        } catch (e) {}
      };
      wolfxFjWs.current.onclose = () => {
        setWolfxStatus(s => ({ ...s, fjConnected: false }));
        const delay = isWolfxDisabled() ? 0 : Math.min(60000, wolfxBackoffMsRef.current * 2);
        wolfxBackoffMsRef.current = delay;
        if (delay > 0) setTimeout(() => { if (!isWolfxDisabled() && document.visibilityState === 'visible') connectWolfx(); }, delay);
      };
    } catch {}
  };

  // Poll CENC JSON periodically
  const pollWolfxCenc = async () => {
    try {
      const resp = await fetch('https://api.wolfx.jp/cenc_eew.json');
      if (!resp.ok) return;
      const json = await resp.json();
      // The endpoint may return either a single object or array; handle both
      const data = Array.isArray(json) ? json[0] : json;
      if (data && data.cenc_eew) setWolfxCenc(data as WolfxCencEew);
      setWolfxStatus(s => ({ ...s, cencLast: Date.now() }));
    } catch (_) {}
  };

  useEffect(() => {
    const fetchHistoricalData = async () => {
      try {
        // If using local mode, do not fetch remote history
        if (usingLocalRef.current) return;
        const response = await fetch('https://api.p2pquake.net/v2/history?limit=100');
        const historicalData: P2PQuakeData[] = await response.json();
        if (historicalData && historicalData.length > 0) {
          const twoDaysAgo = new Date();
          twoDaysAgo.setDate(twoDaysAgo.getDate() - 15);
          twoDaysAgo.setHours(0, 0, 0, 0);

          const filteredHistoricalData = historicalData.filter((item: P2PQuakeData) => {
            const itemDate = new Date(item.time);
            return item.code === 551 && itemDate >= twoDaysAgo;
          }) as EarthquakeData[];
          setEarthquakeData(filteredHistoricalData.slice(0, 15));
        }
      } catch (error) {
        console.error('Error fetching historical data:', error);
      }
    };

    if (!isMounted.current) {
      // Try local test mode first (forced if env var=1). If not available, fall back to live WS.
      tryStartLocalMode().then((startedLocal) => { if (!startedLocal) connectWebSocket(); });
      if (!isWolfxDisabled()) connectWolfx();
      pollWolfxCenc();
      cencIntervalRef.current = setInterval(pollWolfxCenc, 10000) as unknown as NodeJS.Timeout;
      fetchHistoricalData();
      isMounted.current = true;
    }

    return () => {
      if (ws.current) {
        ws.current.close(1000, 'Component unmounted');
      }
      if (localPollRef.current) {
        clearInterval(localPollRef.current as unknown as number);
        localPollRef.current = null;
      }
      if (wolfxJmaWs.current) wolfxJmaWs.current.close(1000, 'Unmount');
      if (wolfxScWs.current) wolfxScWs.current.close(1000, 'Unmount');
      if (wolfxFjWs.current) wolfxFjWs.current.close(1000, 'Unmount');
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
      if (cencIntervalRef.current) {
        clearInterval(cencIntervalRef.current as unknown as number);
        cencIntervalRef.current = null;
      }
    };
  }, []);

  // Expose quick toggles for disabling/enabling Wolfx via console
  useEffect(() => {
    const w = window as any;
    w.disableWolfx = () => { try { localStorage.setItem('DISABLE_WOLFX', '1'); } catch {}; closeWolfx(); };
    w.enableWolfx = () => { try { localStorage.removeItem('DISABLE_WOLFX'); } catch {}; connectWolfx(); };
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'DISABLE_WOLFX') {
        if (e.newValue === '1') closeWolfx(); else connectWolfx();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('storage', onStorage); w.disableWolfx = undefined; w.enableWolfx = undefined; };
  }, []);

  // Debug/mock helpers exposed on window for manual testing without live events
  useEffect(() => {
    const w = window as unknown as {
      simWolfxJma?: (overrides?: Partial<WolfxJmaEew>) => void;
      simWolfxSc?: (overrides?: Partial<WolfxScEew>) => void;
      simWolfxFj?: (overrides?: Partial<WolfxFjEew>) => void;
      simWolfxCenc?: (overrides?: Partial<WolfxCencEew>) => void;
      clearWolfx?: () => void;
      injectP2PQuake?: (payloadOrJson: unknown) => void;
      p2pquake?: () => void;
      openP2PQuakeTester?: () => void;
      p2pquakeInject?: (payloadOrJson: unknown) => void;
    };

    w.simWolfxJma = (overrides = {}) => {
      const base: WolfxJmaEew = {
        jma_eew: 'jma_eew',
        Title: '緊急地震速報（予報）',
        CodeType: 'Ｍ、最大予測震度及び主要動到達予測時刻の緊急地震速報',
        Issue: { Source: '東京', Status: '通常' },
        EventID: '20250811174016',
        Serial: 3,
        AnnouncedTime: '2025/08/11 17:41:04',
        OriginTime: '2025/08/11 17:40:08',
        Hypocenter: '宮古島近海',
        Latitude: 24.4,
        Longitude: 125.2,
        Magunitude: 3.7,
        Depth: 10,
        MaxIntensity: '2',
        Accuracy: { Epicenter: 'IPF 法（5 点以上）', Depth: 'IPF 法（5 点以上）', Magnitude: '防災科研システム' },
        MaxIntChange: { String: 'ほとんど変化なし', Reason: '不明、未設定時、キャンセル時' },
        WarnArea: [],
        isSea: true,
        isTraining: false,
        isAssumption: false,
        isWarn: false,
        isFinal: true,
        isCancel: false,
        OriginalText: '37 03 00 250811174104 C11 250811174008 ND20250811174016 NCN903 JD////////////// JN/// 853 N244 E1252 010 37 02 RK44209 RT10/// RC0//// 9999='
      };
      setWolfxJma({ ...base, ...overrides });
    };

    w.simWolfxSc = (overrides = {}) => {
      const base: WolfxScEew = {
        sc_eew: 'sc_eew',
        ID: 1,
        EventID: 'SC-DEBUG',
        ReportTime: '2025/08/12 11:34:56',
        ReportNum: 1,
        OriginTime: '2025/08/12 11:34:40',
        HypoCenter: '四川省中部',
        Latitude: 30.5,
        Longitude: 104.1,
        Magunitude: 4.8,
        Depth: 12,
        MaxIntensity: 5,
      };
      setWolfxSc({ ...base, ...overrides });
    };

    w.simWolfxFj = (overrides = {}) => {
      const base: WolfxFjEew = {
        fj_eew: 'fj_eew',
        ID: 1,
        EventID: 'FJ-DEBUG',
        ReportTime: '2025/08/12 11:34:56',
        ReportNum: 1,
        OriginTime: '2025/08/12 11:34:40',
        HypoCenter: '福建省沿岸',
        Latitude: 25.9,
        Longitude: 119.3,
        Magunitude: 4.2,
        isFinal: false,
      };
      setWolfxFj({ ...base, ...overrides });
    };

    w.simWolfxCenc = (overrides = {}) => {
      const base: WolfxCencEew = {
        cenc_eew: 'cenc_eew',
        ID: 1,
        EventID: 'CENC-DEBUG',
        ReportTime: '2025/08/12 11:34:56',
        ReportNum: 1,
        OriginTime: '2025/08/12 11:34:40',
        HypoCenter: '中国本土',
        Latitude: 34.2,
        Longitude: 108.9,
        Magunitude: 5.1,
        Depth: 10,
        MaxIntensity: 6,
      };
      setWolfxCenc({ ...base, ...overrides });
    };

    w.clearWolfx = () => {
      setWolfxJma(null);
      setWolfxSc(null);
      setWolfxFj(null);
      setWolfxCenc(null);
    };

    // Direct injector for P2PQuake payloads from console
    w.injectP2PQuake = (payloadOrJson: unknown) => {
      try {
        const data = typeof payloadOrJson === 'string' ? JSON.parse(payloadOrJson) : payloadOrJson;
        ingestP2pquakePayload(data);
        console.log('[P2PQuake] Injected test payload');
      } catch (e) {
        console.error('[P2PQuake] Failed to inject payload:', e);
      }
    };

    // Minimal popup tester
    const openTester = () => {
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.left = '0';
      overlay.style.top = '0';
      overlay.style.width = '100%';
      overlay.style.height = '100%';
      overlay.style.background = 'rgba(0,0,0,0.4)';
      overlay.style.zIndex = '99999';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';

      const modal = document.createElement('div');
      modal.style.width = 'min(900px, 92vw)';
      modal.style.maxHeight = '84vh';
      modal.style.background = '#fff';
      modal.style.borderRadius = '8px';
      modal.style.boxShadow = '0 10px 30px rgba(0,0,0,0.25)';
      modal.style.display = 'flex';
      modal.style.flexDirection = 'column';
      modal.style.overflow = 'hidden';

      const header = document.createElement('div');
      header.textContent = 'P2PQuake Test Input (paste JSON and Apply)';
      header.style.padding = '12px 16px';
      header.style.background = '#111827';
      header.style.color = '#fff';
      header.style.fontWeight = '600';
      header.style.fontSize = '14px';

      const area = document.createElement('textarea');
      area.style.flex = '1';
      area.style.minHeight = '340px';
      area.style.padding = '12px 14px';
      area.style.border = 'none';
      area.style.outline = 'none';
      area.style.resize = 'vertical';
      area.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
      area.style.fontSize = '12px';
      area.placeholder = '{\n  "code": 551,\n  ...\n}  or  [ { ... }, { ... } ]';

      const footer = document.createElement('div');
      footer.style.display = 'flex';
      footer.style.gap = '8px';
      footer.style.padding = '12px';
      footer.style.justifyContent = 'flex-end';
      footer.style.background = '#F9FAFB';

      const btnExample551 = document.createElement('button');
      btnExample551.textContent = 'Insert 551 example + Apply';
      btnExample551.style.padding = '8px 12px';
      btnExample551.onclick = () => {
        area.value = JSON.stringify({
          code: 551,
          time: new Date().toISOString(),
          earthquake: {
            maxScale: 45,
            domesticTsunami: 'None',
            hypocenter: { name: 'テスト震源', latitude: 35.6, longitude: 139.7, depth: 40, magnitude: 5.2 }
          },
          points: [ { pref: '東京都', addr: '千代田区', isArea: false, scale: 40 } ],
          comments: { freeFormComment: 'テスト入力' }
        }, null, 2);
        // Auto-apply for quick TTS testing
        try {
          const parsed = JSON.parse(area.value);
          // Ensure fresh time so TTS isn't deduped by localStorage
          if (Array.isArray(parsed) && parsed.length > 0) {
            const last = parsed[parsed.length - 1];
            if (last && typeof last === 'object') {
              last.time = new Date().toISOString();
              last.cancelled = false;
            }
          } else if (parsed && typeof parsed === 'object') {
            parsed.time = new Date().toISOString();
            parsed.cancelled = false;
          }
          ingestP2pquakePayload(parsed);
          document.body.removeChild(overlay);
        } catch (e) {
          alert('Invalid JSON');
        }
      };

      const btnExample556 = document.createElement('button');
      btnExample556.textContent = 'Insert 556 example';
      btnExample556.style.padding = '8px 12px';
      btnExample556.onclick = () => {
        area.value = JSON.stringify({
          code: 556,
          time: new Date().toISOString(),
          type: '緊急地震速報（予報）',
          report_id: 'TEST',
          report_num: 1,
          report_time: new Date().toISOString(),
          region_name: '関東',
          latitude: 35.6,
          longitude: 139.7,
          is_final: false,
          is_training: false,
          depth: 10,
          magnitude: 4.2,
          forecast_max_intensity: '4',
          forecast_max_lpgm_intensity: '3',
          regions: [ { name: '東京', forecast_intensity: '4', is_warning: false } ]
        }, null, 2);
      };

      const btnExample552Warn = document.createElement('button');
      btnExample552Warn.textContent = 'Insert 552 Warning + Apply';
      btnExample552Warn.style.padding = '8px 12px';
      btnExample552Warn.onclick = () => {
        const payload = {
          code: 552,
          time: new Date().toISOString(),
          cancelled: false,
          areas: [
            { name: '伊豆諸島', grade: 'Warning', immediate: false, maxHeight: { description: '３ｍ', value: 3 } },
            { name: '小笠原諸島', grade: 'Warning', immediate: false, maxHeight: { description: '３ｍ', value: 3 } }
          ]
        } as any;
        area.value = JSON.stringify(payload, null, 2);
        try {
          ingestP2pquakePayload(payload);
          document.body.removeChild(overlay);
        } catch (e) {
          alert('Invalid JSON');
        }
      };

      const btnExample552Major = document.createElement('button');
      btnExample552Major.textContent = 'Insert 552 MajorWarning + Apply';
      btnExample552Major.style.padding = '8px 12px';
      btnExample552Major.onclick = () => {
        const payload = {
          code: 552,
          time: new Date().toISOString(),
          cancelled: false,
          areas: [
            { name: '三陸沿岸北部', grade: 'MajorWarning', immediate: true, maxHeight: { description: '５ｍ以上', value: 5 } },
            { name: '三陸沿岸南部', grade: 'MajorWarning', immediate: true, maxHeight: { description: '５ｍ以上', value: 5 } }
          ]
        } as any;
        area.value = JSON.stringify(payload, null, 2);
        try {
          ingestP2pquakePayload(payload);
          document.body.removeChild(overlay);
        } catch (e) {
          alert('Invalid JSON');
        }
      };

      const btnExample552 = document.createElement('button');
      btnExample552.textContent = 'Insert 552 example + Apply';
      btnExample552.style.padding = '8px 12px';
      btnExample552.onclick = () => {
        area.value = `[
  {
    "areas": [],
    "cancelled": true,
    "code": 552,
    "created_at": "2025/07/31 16:30:35.714",
    "id": "688b1b9b64680b00075a5408",
    "issue": {
      "source": "気象庁",
      "time": "2025/07/31 16:30:16",
      "type": "Focus"
    },
    "time": "2025/07/31 16:30:18.068",
    "timestamp": {
      "convert": "2025/07/31 16:30:18.058",
      "register": "2025/07/31 16:30:18.068"
    },
    "user_agent": "jmaxml-seis-parser-go, relay, register-api",
    "ver": "20231023"
  },
  {
    "areas": [
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "北海道太平洋沿岸東部"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "北海道太平洋沿岸中部"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "北海道太平洋沿岸西部"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "青森県太平洋沿岸"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "岩手県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "宮城県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "福島県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "茨城県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "千葉県九十九里・外房"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "伊豆諸島"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "種子島・屋久島地方"
      }
    ],
    "cancelled": false,
    "code": 552,
    "created_at": "2025/07/31 10:45:53.045",
    "id": "688acad164680b00075a5397",
    "issue": {
      "source": "気象庁",
      "time": "2025/07/31 10:45:20",
      "type": "Focus"
    },
    "time": "2025/07/31 10:45:20.615",
    "timestamp": {
      "convert": "2025/07/31 10:45:20.611",
      "register": "2025/07/31 10:45:20.615"
    },
    "user_agent": "jmaxml-seis-parser-go, relay, register-api",
    "ver": "20231023"
  },
  {
    "areas": [
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "北海道太平洋沿岸東部"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "北海道太平洋沿岸中部"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "北海道太平洋沿岸西部"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "北海道日本海沿岸北部"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "オホーツク海沿岸"
      },
      {
        "firstHeight": {
          "condition": "津波到達中と推測"
        },
        "grade": "Watch",
        "immediate": true,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "青森県日本海沿岸"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "青森県太平洋沿岸"
      },
      {
        "firstHeight": {
          "condition": "津波到達中と推測"
        },
        "grade": "Watch",
        "immediate": true,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "陸奥湾"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "岩手県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "宮城県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "福島県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "茨城県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "千葉県九十九里・外房"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "千葉県内房"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "東京湾内湾"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "伊豆諸島"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "小笠原諸島"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "相模湾・三浦半島"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "静岡県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "愛知県外海"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "伊勢・三河湾"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "三重県南部"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "大阪府"
      },
      {
        "firstHeight": {
          "condition": "津波到達中と推測"
        },
        "grade": "Watch",
        "immediate": true,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "兵庫県瀬戸内海沿岸"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "淡路島南部"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "和歌山県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "徳島県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "愛媛県宇和海沿岸"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "高知県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "大分県瀬戸内海沿岸"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "大分県豊後水道沿岸"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "宮崎県"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "鹿児島県東部"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "種子島・屋久島地方"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "奄美群島・トカラ列島"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "鹿児島県西部"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "沖縄本島地方"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "大東島地方"
      },
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "宮古島・八重山地方"
      }
    ],
    "cancelled": false,
    "code": 552,
    "created_at": "2025/07/30 20:45:40.491",
    "id": "688a05e464680b00075a52b9",
    "issue": {
      "source": "気象庁",
      "time": "2025/07/30 20:45:06",
      "type": "Focus"
    },
    "time": "2025/07/30 20:45:07.671",
    "timestamp": {
      "convert": "2025/07/30 20:45:07.667",
      "register": "2025/07/30 20:45:07.671"
    },
    "user_agent": "jmaxml-seis-parser-go, relay, register-api",
    "ver": "20231023"
  },
  {
    "areas": [
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:00:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "北海道太平洋沿岸東部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:00:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "北海道太平洋沿岸中部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:30:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "北海道太平洋沿岸西部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:30:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "青森県太平洋沿岸"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:00:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "岩手県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:30:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "宮城県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:00:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "福島県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:30:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "茨城県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:30:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "千葉県九十九里・外房"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:00:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "千葉県内房"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:00:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "伊豆諸島"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:30:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "小笠原諸島"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:00:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "相模湾・三浦半島"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:30:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "静岡県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:30:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "愛知県外海"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:30:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "三重県南部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:30:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "和歌山県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "北海道日本海沿岸北部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "オホーツク海沿岸"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "青森県日本海沿岸"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "陸奥湾"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "東京湾内湾"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "伊勢・三河湾"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "大阪府"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "兵庫県瀬戸内海沿岸"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "淡路島南部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "岡山県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "徳島県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "愛媛県宇和海沿岸"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "高知県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 13:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "大分県瀬戸内海沿岸"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "大分県豊後水道沿岸"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "宮崎県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "鹿児島県東部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "種子島・屋久島地方"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "奄美群島・トカラ列島"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 13:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "鹿児島県西部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 13:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "沖縄本島地方"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "大東島地方"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 13:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "宮古島・八重山地方"
      }
    ],
    "cancelled": false,
    "code": 552,
    "created_at": "2025/07/30 09:40:32.896",
    "id": "68896a0064680b00075a51de",
    "issue": {
      "source": "気象庁",
      "time": "2025/07/30 09:40:10",
      "type": "Focus"
    },
    "time": "2025/07/30 09:40:10.906",
    "timestamp": {
      "convert": "2025/07/30 09:40:10.902",
      "register": "2025/07/30 09:40:10.906"
    },
    "user_agent": "jmaxml-seis-parser-go, relay, register-api",
    "ver": "20231023"
  },
  {
    "areas": [
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "北海道太平洋沿岸東部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "北海道太平洋沿岸中部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "北海道太平洋沿岸西部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "青森県太平洋沿岸"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:00:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "岩手県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 10:30:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "宮城県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:00:00"
        },
        "grade": "Warning",
        "immediate": false,
        "maxHeight": {
          "description": "３ｍ",
          "value": 3
        },
        "name": "福島県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "茨城県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:00:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "千葉県九十九里・外房"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "小笠原諸島"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "静岡県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "三重県南部"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 11:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "和歌山県"
      },
      {
        "firstHeight": {
          "arrivalTime": "2025/07/30 12:30:00"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "宮崎県"
      }
    ],
    "cancelled": false,
    "code": 552,
    "created_at": "2025/07/30 08:38:16.999",
    "id": "68895b6864680b00075a51b8",
    "issue": {
      "source": "気象庁",
      "time": "2025/07/30 08:37:45",
      "type": "Focus"
    },
    "time": "2025/07/30 08:37:45.891",
    "timestamp": {
      "convert": "2025/07/30 08:37:45.881",
      "register": "2025/07/30 08:37:45.891"
    },
    "user_agent": "jmaxml-seis-parser-go, relay, register-api",
    "ver": "20231023"
  },
  {
    "areas": [],
    "cancelled": true,
    "code": 552,
    "created_at": "2025/01/13 23:51:11.382",
    "id": "6785285f64680b0007d8c148",
    "issue": {
      "source": "気象庁",
      "time": "2025/01/13 23:50:37",
      "type": "Focus"
    },
    "time": "2025/01/13 23:50:38.572",
    "timestamp": {
      "convert": "2025/01/13 23:50:38.568",
      "register": "2025/01/13 23:50:38.572"
    },
    "user_agent": "jmaxml-seis-parser-go, relay, register-api",
    "ver": "20231023"
  },
  {
    "areas": [
      {
        "firstHeight": {
          "condition": "津波到達中と推測"
        },
        "grade": "Watch",
        "immediate": true,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "高知県"
      },
      {
        "firstHeight": {
          "condition": "津波到達中と推測"
        },
        "grade": "Watch",
        "immediate": true,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "宮崎県"
      }
    ],
    "cancelled": false,
    "code": 552,
    "created_at": "2025/01/13 21:29:43.008",
    "id": "6785073764680b0007d8c0ae",
    "issue": {
      "source": "気象庁",
      "time": "2025/01/13 21:29:40",
      "type": "Focus"
    },
    "time": "2025/01/13 21:29:41.327",
    "timestamp": {
      "convert": "2025/01/13 21:29:41.321",
      "register": "2025/01/13 21:29:41.327"
    },
    "user_agent": "jmaxml-seis-parser-go, relay, register-api",
    "ver": "20231023"
  },
  {
    "areas": [],
    "cancelled": true,
    "code": 552,
    "created_at": "2024/09/24 11:01:32.667",
    "id": "66f21d7c64680b0007d7a51c",
    "issue": {
      "source": "気象庁",
      "time": "2024/09/24 11:00:59",
      "type": "Focus"
    },
    "time": "2024/09/24 11:00:59.857",
    "timestamp": {
      "convert": "2024/09/24 11:00:59.854",
      "register": "2024/09/24 11:00:59.857"
    },
    "user_agent": "jmaxml-seis-parser-go, relay, register-api",
    "ver": "20231023"
  },
  {
    "areas": [
      {
        "firstHeight": {
          "condition": "第１波の到達を確認"
        },
        "grade": "Watch",
        "immediate": false,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "伊豆諸島"
      },
      {
        "firstHeight": {
          "condition": "津波到達中と推測"
        },
        "grade": "Watch",
        "immediate": true,
        "maxHeight": {
          "description": "１ｍ",
          "value": 1
        },
        "name": "小笠原諸島"
      }
    ],
    "cancelled": false,
    "code": 552,
    "created_at": "2024/09/24 09:12:08.317",
    "id": "66f203d864680b0007d7a4ef",
    "issue": {
      "source": "気象庁",
      "time": "2024/09/24 09:11:34",
      "type": "Focus"
    },
    "time": "2024/09/24 09:11:35.297",
    "timestamp": {
      "convert": "2024/09/24 09:11:35.294",
      "register": "2024/09/24 09:11:35.297"
    },
    "user_agent": "jmaxml-seis-parser-go, relay, register-api",
    "ver": "20231023"
  }
]`;
        // Auto-apply after inserting
        try {
          const parsed = JSON.parse(area.value);
          ingestP2pquakePayload(parsed);
          document.body.removeChild(overlay);
        } catch (e) {
          alert('Invalid JSON');
        }
      };

      const btnApply = document.createElement('button');
      btnApply.textContent = 'Apply';
      btnApply.style.padding = '8px 12px';
      btnApply.style.background = '#2563eb';
      btnApply.style.color = '#fff';
      btnApply.style.border = 'none';
      btnApply.style.borderRadius = '6px';
      btnApply.onclick = () => {
        try {
          const parsed = JSON.parse(area.value);
          ingestP2pquakePayload(parsed);
          document.body.removeChild(overlay);
        } catch (e) {
          alert('Invalid JSON');
        }
      };

      const btnClose = document.createElement('button');
      btnClose.textContent = 'Close';
      btnClose.style.padding = '8px 12px';
      btnClose.onclick = () => {
        document.body.removeChild(overlay);
      };

      footer.appendChild(btnExample551);
      footer.appendChild(btnExample556);
      footer.appendChild(btnExample552Warn);
      footer.appendChild(btnExample552Major);
      footer.appendChild(btnExample552);
      footer.appendChild(btnApply);
      footer.appendChild(btnClose);
      modal.appendChild(header);
      modal.appendChild(area);
      modal.appendChild(footer);
      overlay.appendChild(modal);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) document.body.removeChild(overlay);
      });
      document.body.appendChild(overlay);
    };

    w.openP2PQuakeTester = openTester;
    w.p2pquake = openTester;
    w.p2pquakeInject = w.injectP2PQuake;

    return () => {
      w.simWolfxJma = undefined;
      w.simWolfxSc = undefined;
      w.simWolfxFj = undefined;
      w.simWolfxCenc = undefined;
      w.clearWolfx = undefined;
      w.injectP2PQuake = undefined;
      w.p2pquake = undefined;
      w.openP2PQuakeTester = undefined;
      w.p2pquakeInject = undefined;
    };
  }, []);

  useEffect(() => {
    const downloadEarthquakeData = () => {
      if (earthquakeData) {
        const json = JSON.stringify(earthquakeData, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'earthquake_data.json';
        setTimeout(() => {
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url); // <-- 반드시 다운로드 후에 해제!
        }, 0);
      }
    };

    // 아래처럼 window에 등록만 하고, 실제 호출은 버튼 등에서만 하세요.
    (window as any).downloadEarthquakeData = downloadEarthquakeData;

    return () => {
      (window as any).downloadEarthquakeData = null;
    };
  }, [earthquakeData]);

  const simulateEEW = (data: EEWData | null) => {
    setEewData(data);
  };

  return (
    <WebSocketContext.Provider value={{ earthquakeData, eewData, tsunamiData, wolfxJma, wolfxSc, wolfxCenc, wolfxFj, simulateEarthquake, simulateEEW, wolfxStatus }}>
      {children}
    </WebSocketContext.Provider>
  );
};
