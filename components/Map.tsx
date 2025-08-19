import React, { useEffect, useContext, useState, useCallback, useMemo, useRef } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import MapGL, { Marker, Popup, Source, Layer, MapRef } from 'react-map-gl';
import styles from '../styles/Map.module.css';
import { ThemeContext } from '../contexts/ThemeContext';
import { useLoading } from '../contexts/LoadingContext';
import { EEWData } from '../types/p2pquake';
import type { WolfxJmaEew, WolfxScEew, WolfxCencEew, WolfxFjEew } from '../types/wolfx';

// Default position for the map (Korea's center)
const defaultPosition: [number, number] = [36.5, 127.5];

interface PEWSEarthquake {
  lat: number;
  lon: number;
  mag: number;
  dep: number;
  timestamp: number;
  eventId: number;
  max: number;
  maxArea: number;
}

// MapLibre로 전환: Leaflet 의존 로직 제거

const getMagnitudeIcon = (scale: number, pixelSize: number) => {
  let iconFileName: string;
  if (scale === 10) iconFileName = '1.png';
  else if (scale === 20) iconFileName = '2.png';
  else if (scale === 30) iconFileName = '3.png';
  else if (scale === 40) iconFileName = '4.png';
  else if (scale === 45) iconFileName = '5-.png';
  else if (scale === 50) iconFileName = '5+.png';
  else if (scale === 55) iconFileName = '6-.png';
  else if (scale === 60) iconFileName = '6+.png';
  else if (scale === 70) iconFileName = '7.png';
  else iconFileName = '1.png'; // Default or fallback icon

  return {
    url: `/magnitude/magnitude/${iconFileName}`,
    size: pixelSize,
    anchor: [Math.round(pixelSize / 2), Math.round(pixelSize / 2)] as [number, number],
  };
};

// Map P2PQuake scale values to JMA intensity strings
function formatJmaIntensity(scale: number): string {
  switch (scale) {
    case 10: return '1';
    case 20: return '2';
    case 30: return '3';
    case 40: return '4';
    case 45: return '5-';
    case 50: return '5+';
    case 55: return '6-';
    case 60: return '6+';
    case 70: return '7';
    default: return String(scale);
  }
}

interface Earthquake {
  time: string;
  location: string;
  depth: number;
  magnitude: number;
  intensity: number;
  latitude?: number | null;
  longitude?: number | null;
}

export interface Point {
  addr: string;
  isArea: boolean;
  pref: string;
  scale: number;
  lat?: number | null;
  lng?: number | null;
}

interface MapProps {
  earthquake: {
    intensity: number;
    intensityText?: string;
    magnitude: number;
    depth: number;
    location: string;
    tsunamiWarning: 'none' | 'watch' | 'warning' | 'major_warning';
    recentEarthquakes: Earthquake[];
    latitude: number | null;
    longitude: number | null;
  };
  eewData: EEWData | null; // 긴급지진속보 데이터 추가
  points?: Point[];
  subtitleText?: string | null; // 자막 텍스트
  fitKey?: number; // 부모에서 제어하는 1회 한정 맞춤 트리거
  onPewsAvailableChange?: (available: boolean) => void;
  // Wolfx sources
  wolfxJma?: WolfxJmaEew | null;
  wolfxSc?: WolfxScEew | null;
  wolfxCenc?: WolfxCencEew | null;
  wolfxFj?: WolfxFjEew | null;
  tsunamiAreas?: { name: string; grade: string; height?: number }[];
  interactive?: boolean; // 지도 상호작용 허용 여부
  onUserInteracted?: () => void; // 사용자가 지도를 조작했음을 알림
  disableAutoFit?: boolean; // 자동 맞춤 비활성화
}

// New, simple bounds-fitting helper that only fits to provided points with a 50px padding
// MapLibre: fitBounds 헬퍼는 내부에서 수행

// Convert a Leaflet zoom level to an icon pixel size
function getIconPixelSizeForZoom(zoom: number): number {
  // Smaller when zoomed out, larger when zoomed in
  // Tuned for OSM default CRS; clamp to avoid extremes
  const size = Math.round(10 + zoom * 1.8);
  return Math.max(14, Math.min(size, 38));
}

// Dynamic radius for PEWS circle markers by zoom level
function getPewsCircleRadiusForZoom(zoom: number): number {
  // Scale approximately linearly with zoom, clamped
  // Example: zoom 3 -> 2px, 5 -> 4px, 8 -> 7px, 12 -> 10px
  const radius = Math.round((zoom - 1) * 1.0);
  return Math.max(2, Math.min(radius, 10));
}

// No collision shifting; render markers at their exact lat/lng

const EqoMap: React.FC<MapProps> = ({ earthquake, eewData, points = [], fitKey, onPewsAvailableChange, wolfxJma, wolfxSc, wolfxCenc, wolfxFj, tsunamiAreas = [], interactive = true, onUserInteracted, disableAutoFit = false }) => {
  const { theme } = useContext(ThemeContext) as { theme: 'light' | 'dark' };
  const { setIsLoading } = useLoading();
  const [pewsData, setPewsData] = useState<PEWSEarthquake[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [isBlocked, setIsBlocked] = useState<boolean>(false);
  const [blockUntil, setBlockUntil] = useState<Date | null>(null);
  const [retryCount, setRetryCount] = useState<number>(0);
  const [retryTimeout, setRetryTimeout] = useState<NodeJS.Timeout | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(5);
  const mapRef = useRef<MapRef | null>(null);
  // Korean stations state
  interface KoreanStation { id: number; latitude: number; longitude: number; name: string; mmi?: number }
  const [krStations, setKrStations] = useState<KoreanStation[]>([]);
  // Calculate positions
  const earthquakePosition = earthquake.latitude && earthquake.longitude 
    ? [earthquake.latitude, earthquake.longitude] as [number, number] 
    : null;
    
  const eewEpicenterPosition = eewData?.latitude && eewData?.longitude
    ? [eewData.latitude, eewData.longitude] as [number, number]
    : null;

  // Wolfx epicenters (prefer component-provided EEW; else Wolfx)
  const wolfxJmaEpicenter = wolfxJma && Number.isFinite(wolfxJma.Latitude) && Number.isFinite(wolfxJma.Longitude)
    ? [wolfxJma.Latitude, wolfxJma.Longitude] as [number, number]
    : null;
  const wolfxScEpicenter = wolfxSc && Number.isFinite(wolfxSc.Latitude) && Number.isFinite(wolfxSc.Longitude)
    ? [wolfxSc.Latitude, wolfxSc.Longitude] as [number, number]
    : null;
  const wolfxFjEpicenter = wolfxFj && Number.isFinite(wolfxFj.Latitude) && Number.isFinite(wolfxFj.Longitude)
    ? [wolfxFj.Latitude, wolfxFj.Longitude] as [number, number]
    : null;
  const wolfxCencEpicenter = wolfxCenc && Number.isFinite(wolfxCenc.Latitude) && Number.isFinite(wolfxCenc.Longitude)
    ? [wolfxCenc.Latitude, wolfxCenc.Longitude] as [number, number]
    : null;

  // Tokyo reference point for arrival (approx: 35.6895, 139.6917)
  const tokyoLatLng: [number, number] = [35.6895, 139.6917];
  const tokyoArrive = (() => {
    if (!wolfxJma || !wolfxJma.WarnArea) return null;
    const tokyoAliases = ['東京都', '東京', '東京地方', '関東', '関東地方'];
    const area = wolfxJma.WarnArea.find(a => tokyoAliases.some(alias => a.Chiiki.includes(alias)));
    return area ? area.Arrive : null;
  })();

  // Check if response is valid binary data
  const isBinaryData = (data: ArrayBuffer): boolean => {
    // Check if the data looks like binary (not HTML)
    const header = new Uint8Array(data.slice(0, 100));
    const headerStr = String.fromCharCode.apply(null, Array.from(header));
    return !headerStr.includes('<html') && !headerStr.includes('<!DOCTYPE');
  };

  // Calculate next retry delay with exponential backoff (max 5 minutes)
  const getRetryDelay = (attempt: number): number => {
    const baseDelay = 1000; // 1 second
    const maxDelay = 5 * 60 * 1000; // 5 minutes
    return Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  };

  // PEWS 데이터 가져오기
  const fetchPewsData = useCallback(async () => {
    // Check if we're in a blocked state
    if (isBlocked && blockUntil && new Date() < blockUntil) {
      const timeLeft = blockUntil.getTime() - new Date().getTime();
      console.log(`PEWS 데이터 요청이 차단되었습니다. ${Math.ceil(timeLeft / 1000)}초 후에 다시 시도합니다.`);
      return;
    } else if (isBlocked) {
      // Block expired, reset state
      setIsBlocked(false);
      setBlockUntil(null);
    }

    try {
      const response = await fetch('/api/pews');
      
      if (!response.ok) {
        if (onPewsAvailableChange) onPewsAvailableChange(false);
        return; // Quietly exit without logging or throwing
      }
      
      const arrayBuffer = await response.arrayBuffer();
      
      // Check if the response is HTML (block page)
      if (!isBinaryData(arrayBuffer)) {
        // Silently handle HTML/block page without logging
        const blockTime = new Date();
        blockTime.setMinutes(blockTime.getMinutes() + 5); // Block for 5 minutes
        setIsBlocked(true);
        setBlockUntil(blockTime);
        setRetryCount(0); // Reset retry count when blocked
        if (onPewsAvailableChange) onPewsAvailableChange(false);
        return;
      }
      
      const dataView = new DataView(arrayBuffer);
      const earthquakes: PEWSEarthquake[] = [];
      
      // Reset retry count on successful binary data
      setRetryCount(0);
      
      // 헤더 스킵 (32바이트)
      let offset = 32;
      
      // 데이터 파싱
      while (offset < arrayBuffer.byteLength - 60) { // 최소한의 데이터 크기 확인
        try {
          const lat = dataView.getFloat32(offset, true);
          const lon = dataView.getFloat32(offset + 4, true);
          const mag = dataView.getFloat32(offset + 8, true);
          const dep = dataView.getFloat32(offset + 12, true);
          const timestamp = dataView.getUint32(offset + 16, true);
          const eventId = dataView.getUint32(offset + 20, true);
          const max = dataView.getUint8(offset + 24);
          const maxArea = dataView.getUint8(offset + 25);
          
          // 유효한 데이터인지 확인
          if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
            earthquakes.push({
              lat,
              lon,
              mag,
              dep,
              timestamp,
              eventId,
              max,
              maxArea
            });
          }
          
          // 다음 이벤트로 이동 (28바이트 + 60바이트 info text)
          offset += 88;
        } catch (e) {
          // Silently skip malformed record
          break;
        }
      }
      
      setPewsData(earthquakes);
      setLastUpdate(new Date());
      if (onPewsAvailableChange) onPewsAvailableChange(true);
    } catch {
      if (onPewsAvailableChange) onPewsAvailableChange(false);
    }
  }, []);

  // Handle retry with exponential backoff
  const scheduleRetry = useCallback(() => {
    if (retryTimeout) clearTimeout(retryTimeout);
    
    const delay = getRetryDelay(retryCount);
    console.log(`다음 재시도: ${delay / 1000}초 후`);
    
    const timeout = setTimeout(() => {
      setRetryCount(prev => prev + 1);
      fetchPewsData();
    }, delay);
    
    setRetryTimeout(timeout);
    return () => clearTimeout(timeout);
  }, [retryCount, fetchPewsData]);

  // 주기적으로 PEWS 데이터 갱신
  useEffect(() => {
    fetchPewsData();
    
    const interval = setInterval(() => {
      if (!isBlocked || (blockUntil && new Date() >= blockUntil)) {
        fetchPewsData();
      }
    }, 60000); // 1분마다 갱신
    
    return () => {
      clearInterval(interval);
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, [fetchPewsData, isBlocked, blockUntil]);
  
  // Handle retries when blocked
  useEffect(() => {
    if (isBlocked && blockUntil) {
      const now = new Date();
      if (now < blockUntil) {
        const timeLeft = blockUntil.getTime() - now.getTime();
        const timeout = setTimeout(() => {
          setIsBlocked(false);
          setBlockUntil(null);
          fetchPewsData();
        }, timeLeft);
        
        return () => clearTimeout(timeout);
      }
    }
  }, [isBlocked, blockUntil, fetchPewsData]);

  // 지도에 표시할 주소 마커 좌표 상태
  const [pointCoords, setPointCoords] = useState<Array<Point & { lat: number; lng: number }>>([]);

  useEffect(() => {
    if (points) {
      const coords = points
        .filter((p): p is Point & { lat: number; lng: number } => 
          p.lat !== undefined && p.lng !== undefined && p.lat !== null && p.lng !== null
        )
        .map(p => ({
          ...p,
          lat: p.lat!,
          lng: p.lng!
        }));
      setPointCoords(coords);
    }
  }, [points]);

  // 지도 스타일 설정 (MapLibre vector styles)
  const lightStyle = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
  const darkStyle = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
  const mapStyleUrl = theme === 'light' ? lightStyle : darkStyle;

  // 진도별 색상
  const getIntensityColor = (intensity: number) => {
    const colors = [
      '#FFFFFF', // 0
      '#00FF00', // 1
      '#00CC00', // 2
      '#009900', // 3
      '#006600', // 4
      '#FF0000', // 5
      '#CC0000', // 6
      '#990000', // 7
      '#660000'  // 8
    ];
    return colors[Math.min(Math.max(0, intensity), 8)];
  };

  // MapLibre GeoJSON 소스: PEWS 원형 마커 표현
  const pewsGeoJson = useMemo(() => ({
    type: 'FeatureCollection',
    features: pewsData.map((eq) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [eq.lon, eq.lat] },
      properties: {
        color: getIntensityColor(eq.max),
        mag: eq.mag,
        dep: eq.dep,
        timestamp: eq.timestamp,
      },
    })),
  }), [pewsData]);

  const pewsCircleLayer: any = {
    id: 'pews-circles',
    type: 'circle',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        3, 2,
        6, 4,
        9, 7,
        12, 10
      ],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.8,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#000000',
    },
  };

  // 한국 관측소 색상 (MMI 값에 따른 색상)
  const getColorByMMI = (mmi: number | undefined = 0): string => {
    const v = mmi || 0;
    const colors: Record<number, string> = {
      0: '#FFFFFF',
      1: '#FFFFFF',
      12: '#DFDFDF',
      13: '#BFBFBF',
      14: '#9F9F9F',
      2: '#A0E6FF',
      3: '#92D050',
      4: '#FFFF00',
      5: '#FFC000',
      6: '#FF0000',
      7: '#A32777',
      8: '#632523',
      9: '#4C2600',
      10: '#000000',
      11: '#000000',
    };
    return colors[v] || '#FFFFFF';
  };

  // 한국 관측소 주기적 갱신
  const fetchKrStations = useCallback(async () => {
    try {
      const resp = await fetch('/api/korea-stations');
      const json = await resp.json();
      if (json && json.success && Array.isArray(json.data?.stations)) {
        const unique = new (Map as new () => Map<number, KoreanStation>)();
        (json.data.stations as KoreanStation[]).forEach((st) => {
          if (!unique.has(st.id)) unique.set(st.id, st);
        });
        setKrStations(Array.from(unique.values()));
      }
    } catch (_) {
      // ignore network errors
    }
  }, []);

  useEffect(() => {
    fetchKrStations();
    const id = setInterval(fetchKrStations, 1000);
    return () => clearInterval(id);
  }, [fetchKrStations]);

  const krStationsGeoJson = useMemo(() => ({
    type: 'FeatureCollection',
    features: krStations.map((st) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [st.longitude, st.latitude] },
      properties: {
        color: getColorByMMI(st.mmi),
      },
    })),
  }), [krStations]);

  const krStationsCircleLayer: any = {
    id: 'kr-stations',
    type: 'circle',
    paint: {
      'circle-radius': 5,
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.8,
      'circle-stroke-width': 1,
      'circle-stroke-color': theme === 'dark' ? '#FFFFFF' : '#000000',
    },
  };

  // --- Tsunami bars --------------------------------------------------------
  type TsunamiFeature = { lon: number; lat: number; label: string; meters: number | null; color: string; z: number; } & { from: [number, number]; to: [number, number] };
  const [tsunamiFeatures, setTsunamiFeatures] = useState<TsunamiFeature[]>([]);
  const geocodeCacheRef = useRef<Map<string, { lat: number; lng: number }>>(new Map());
  const openCageDisabledKeysRef = useRef<Map<string, number>>(new Map());

  const loadDisabledKeys = () => {
    if (typeof window === 'undefined') return;
    if (openCageDisabledKeysRef.current.size > 0) return;
    try {
      const raw = localStorage.getItem('OC_DISABLED_KEYS');
      if (!raw) return;
      const obj = JSON.parse(raw);
      const now = Date.now();
      Object.entries(obj || {}).forEach(([k, exp]) => {
        if (typeof exp === 'number' && exp > now) openCageDisabledKeysRef.current.set(k, exp);
      });
    } catch {}
  };

  const saveDisabledKeys = () => {
    if (typeof window === 'undefined') return;
    try {
      const obj: Record<string, number> = {};
      const now = Date.now();
      for (const [k, v] of openCageDisabledKeysRef.current.entries()) {
        if (v > now) obj[k] = v;
      }
      localStorage.setItem('OC_DISABLED_KEYS', JSON.stringify(obj));
    } catch {}
  };

  const colorForGrade = (grade: string): string => {
    if (grade === 'MajorWarning') return '#a855f7'; // purple
    if (grade === 'Warning') return '#ef4444'; // red
    if (grade === 'Watch') return '#f59e0b'; // amber
    return '#6b7280'; // gray
  };

  const zIndexForGrade = (grade: string): number => {
    if (grade === 'MajorWarning') return 30;
    if (grade === 'Warning') return 20;
    if (grade === 'Watch') return 10;
    return 5;
  };

  // Fallback centroids for JMA tsunami coastal segments (approximate)
  // These are used when geocoders return 0 results
  const tsunamiCentroids: Record<string, { lat: number; lng: number }> = {
    '北海道太平洋沿岸東部': { lat: 42.7, lng: 143.8 },
    '北海道太平洋沿岸中部': { lat: 42.3, lng: 142.4 },
    '北海道太平洋沿岸西部': { lat: 41.9, lng: 141.2 },
    '北海道日本海沿岸北部': { lat: 44.3, lng: 141.8 },
    'オホーツク海沿岸': { lat: 44.1, lng: 143.4 },
    '青森県太平洋沿岸': { lat: 40.6, lng: 141.6 },
    '青森県日本海沿岸': { lat: 40.8, lng: 140.3 },
    '陸奥湾': { lat: 40.9, lng: 140.9 },
    '岩手県': { lat: 39.6, lng: 141.9 },
    '宮城県': { lat: 38.3, lng: 141.0 },
    '福島県': { lat: 37.5, lng: 141.0 },
    '茨城県': { lat: 36.3, lng: 140.6 },
    '千葉県九十九里・外房': { lat: 35.3, lng: 140.4 },
    '千葉県内房': { lat: 35.2, lng: 139.8 },
    '東京湾内湾': { lat: 35.5, lng: 139.9 },
    '相模湾・三浦半島': { lat: 35.1, lng: 139.5 },
    '静岡県': { lat: 34.8, lng: 138.3 },
    '愛知県外海': { lat: 34.6, lng: 137.1 },
    '伊勢・三河湾': { lat: 34.5, lng: 136.8 },
    '三重県南部': { lat: 34.1, lng: 136.2 },
    '和歌山県': { lat: 33.7, lng: 135.4 },
    '大阪府': { lat: 34.6, lng: 135.3 },
    '兵庫県瀬戸内海沿岸': { lat: 34.6, lng: 134.9 },
    '淡路島南部': { lat: 34.2, lng: 134.8 },
    '徳島県': { lat: 33.8, lng: 134.6 },
    '愛媛県宇和海沿岸': { lat: 33.3, lng: 132.6 },
    '高知県': { lat: 33.3, lng: 133.3 },
    '大分県瀬戸内海沿岸': { lat: 33.3, lng: 131.5 },
    '大分県豊後水道沿岸': { lat: 33.1, lng: 132.1 },
    '宮崎県': { lat: 31.9, lng: 131.4 },
    '鹿児島県東部': { lat: 31.4, lng: 130.7 },
    '種子島・屋久島地方': { lat: 30.4, lng: 130.6 },
    '奄美群島・トカラ列島': { lat: 28.3, lng: 129.4 },
    '鹿児島県西部': { lat: 31.6, lng: 130.4 },
    '沖縄本島地方': { lat: 26.3, lng: 127.8 },
    '大東島地方': { lat: 25.9, lng: 131.3 },
    '宮古島・八重山地方': { lat: 24.4, lng: 123.9 },
    '伊豆諸島': { lat: 33.0, lng: 139.5 },
    '小笠原諸島': { lat: 27.1, lng: 142.2 },
    '三陸沿岸北部': { lat: 40.1, lng: 141.9 },
    '三陸沿岸南部': { lat: 39.0, lng: 141.7 },
  };

  const geocodeName = useCallback(async (name: string): Promise<{ lat: number; lng: number } | null> => {
    const cached = geocodeCacheRef.current.get(name);
    if (cached) return cached;
    // 1) Static centroid fallback
    if (tsunamiCentroids[name]) {
      const pt = tsunamiCentroids[name];
      geocodeCacheRef.current.set(name, { lat: pt.lat, lng: pt.lng });
      return pt;
    }
    try {
      // Try OpenCage with key rotation (comma-separated keys)
      loadDisabledKeys();
      const keyStr = (process.env.NEXT_PUBLIC_OPENCAGE_API_KEYS || process.env.NEXT_PUBLIC_OPENCAGE_API_KEY || '').trim();
      const allKeys = keyStr.split(',').map(k => k.trim()).filter(Boolean).slice(0, 2); // limit to 2 keys max
      const now = Date.now();
      const keys = allKeys.filter(k => {
        const exp = openCageDisabledKeysRef.current.get(k);
        return !exp || exp <= now;
      });
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        try {
          const res = await fetch(`https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(name)}&key=${key}&language=ja&countrycode=jp&limit=1`);
          if (res.status === 429 || res.status === 402 || res.status === 401 || res.status === 403) {
            // rate/billing/auth issue: temporarily disable this key for 10 minutes and try next
            openCageDisabledKeysRef.current.set(key, now + 10 * 60 * 1000);
            saveDisabledKeys();
            continue;
          }
          if (!res.ok) continue;
          const j = await res.json();
          if (j.results && j.results[0]) {
            const { lat, lng } = j.results[0].geometry;
            const pt = { lat, lng };
            geocodeCacheRef.current.set(name, pt);
            return pt;
          }
          // No result: try next key
          continue;
        } catch {}
      }
      // Fallback: OpenStreetMap Nominatim (no API key). Please respect usage policy.
      const nomEmail = (process.env.NEXT_PUBLIC_NOMINATIM_EMAIL || '').trim();
      const emailParam = nomEmail ? `&email=${encodeURIComponent(nomEmail)}` : '';
      const r2 = await fetch(`https://nominatim.openstreetmap.org/search?format=json&accept-language=ja&countrycodes=jp&limit=1&q=${encodeURIComponent(name)}${emailParam}`);
      if (r2.ok) {
        const a = await r2.json();
        if (Array.isArray(a) && a.length > 0) {
          const lat = parseFloat(a[0].lat);
          const lng = parseFloat(a[0].lon);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const pt = { lat, lng };
            geocodeCacheRef.current.set(name, pt);
            return pt;
          }
        }
      }
    } catch {}
    return null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!tsunamiAreas || tsunamiAreas.length === 0) {
        setTsunamiFeatures([]);
        return;
      }
      const features: TsunamiFeature[] = [];
      // Process up to 20 areas
      const list = tsunamiAreas.slice(0, 20);
      for (const area of list) {
        const name = area.name;
        const height = (area as any).maxHeight?.value ?? area.height ?? null;
        const pt = await geocodeName(name);
        if (!pt) continue;
        // Convert meter height to approximate degrees in latitude
        const meters = Number.isFinite(height) ? Math.max(1, Number(height)) : 1;
        const scaleMetersPerUnit = 60000; // 60km per 1m bar for stronger visibility
        const totalMeters = meters * scaleMetersPerUnit;
        const deltaLat = totalMeters / 111320; // deg
        const from: [number, number] = [pt.lng, pt.lat - deltaLat / 2];
        const to: [number, number] = [pt.lng, pt.lat + deltaLat / 2];
        features.push({ lon: pt.lng, lat: pt.lat, label: `${height ?? ''}m`, meters: (height ?? null) as number | null, color: colorForGrade(area.grade), z: zIndexForGrade((area as any).grade), from, to });
      }
      if (!cancelled) setTsunamiFeatures(features);
    };
    run();
    return () => { cancelled = true; };
  }, [tsunamiAreas, geocodeName]);

  const tsunamiLinesGeoJson = useMemo(() => ({
    type: 'FeatureCollection',
    features: tsunamiFeatures.map(f => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [f.from, f.to] },
      properties: { color: f.color, label: f.label }
    }))
  }), [tsunamiFeatures]);

  const tsunamiPointsGeoJson = useMemo(() => ({
    type: 'FeatureCollection',
    features: tsunamiFeatures.flatMap(f => ([
      { type: 'Feature', geometry: { type: 'Point', coordinates: f.to }, properties: { color: f.color } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: f.from }, properties: { color: f.color } },
    ]))
  }), [tsunamiFeatures]);

  // Resolve overlaps: group nearby bars and apply small horizontal pixel offsets
  const tsunamiPlacedFeatures = useMemo(() => {
    if (!tsunamiFeatures || tsunamiFeatures.length === 0) return [] as Array<TsunamiFeature & { offsetPx: number; angleDeg: number }>;
    const map = mapRef.current?.getMap();
    const groups = new Map<string, Array<TsunamiFeature & { px: [number, number] }>>();
    const gridPx = 24; // group by ~24px horizontal proximity (visually close)
    tsunamiFeatures.forEach(f => {
      let px: [number, number] = [0,0];
      try {
        if (map) {
          const p = (map as any).project([f.lon, f.lat]);
          px = [Math.round(p.x), Math.round(p.y)] as [number, number];
        }
      } catch {}
      const gx = Math.round(px[0] / gridPx) * gridPx;
      const gy = Math.round(px[1] / gridPx) * gridPx;
      const key = `${gx}_${gy}`;
      const list = groups.get(key) || [];
      list.push(Object.assign({}, f, { px }));
      groups.set(key, list);
    });
    const placed: Array<TsunamiFeature & { offsetPx: number; angleDeg: number }> = [];
    groups.forEach(list => {
      // 높은 우선순위/높이가 중앙, 나머지는 좌우로 균등 배치 → 더 자연스러움
      list.sort((a,b) => (b.z - a.z) || (Number(b.meters||0) - Number(a.meters||0)));
      // 그룹 내 방향(기울기) 계산: 가장 낮은 높이 위치 → 가장 높은 높이 위치 벡터
      let angleDeg = 0;
      try {
        const withMeters = list.filter(v => Number.isFinite(v.meters as any));
        if (withMeters.length >= 2) {
          let min = withMeters[0];
          let max = withMeters[0];
          withMeters.forEach(v => {
            if ((v.meters as number) < (min.meters as number)) min = v;
            if ((v.meters as number) > (max.meters as number)) max = v;
          });
          const dx = (max.px[0] - min.px[0]);
          const dy = (max.px[1] - min.px[1]);
          const phi = Math.atan2(dy, dx); // x-axis 기준 라인 각도
          angleDeg = (phi * 180 / Math.PI) - 90; // 수직 기준 회전 각도
        }
      } catch {}
      const n = list.length;
      const base = (n - 1) / 2;
      list.forEach((f, i) => {
        const offset = (i - base) * 12; // 12px 간격 좌우 분산
        placed.push(Object.assign({}, f, { offsetPx: offset, angleDeg }));
      });
    });
    // 낮은 z 먼저 그리기
    placed.sort((a,b) => (a.z - b.z) || (Number(a.meters||0) - Number(b.meters||0)));
    return placed;
  }, [tsunamiFeatures, mapRef, zoomLevel]);

  const tsunamiLineLayerOutline: any = {
    id: 'tsunami-bars-outline',
    type: 'line',
    paint: {
      'line-color': '#ffffff',
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        3, 8,
        6, 14,
        9, 20,
        12, 26
      ],
      'line-opacity': 0.95,
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round'
    }
  };

  const tsunamiLineLayer: any = {
    id: 'tsunami-bars',
    type: 'line',
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ff00ff'],
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        3, 6,
        6, 12,
        9, 18,
        12, 24
      ],
      'line-opacity': 0.85,
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round'
    }
  };

  const tsunamiLabelLayer: any = {
    id: 'tsunami-labels',
    type: 'symbol',
    layout: {
      'text-field': ['get', 'label'],
      'text-size': [
        'interpolate', ['linear'], ['zoom'],
        3, 11,
        6, 13,
        9, 15,
        12, 17
      ],
      'text-offset': [0, 1.6],
      'text-anchor': 'top',
    },
    paint: {
      'text-color': '#0b1220',
      'text-halo-color': '#ffffff',
      'text-halo-width': 2.0,
    }
  };

  const tsunamiCapsLayer: any = {
    id: 'tsunami-caps',
    type: 'circle',
    paint: {
      'circle-color': ['coalesce', ['get', 'color'], '#ff00ff'],
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        3, 4,
        6, 6,
        9, 8,
        12, 10
      ],
      'circle-opacity': 0.9,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5
    }
  };

  // Tokyo 도착 표시
  const tokyoGeoJson = useMemo(() => ({
    type: 'FeatureCollection',
    features: tokyoArrive === null ? [] : [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [tokyoLatLng[1], tokyoLatLng[0]] },
      properties: { arrived: !!tokyoArrive },
    }],
  }), [tokyoArrive]);

  const tokyoCircleLayer: any = {
    id: 'tokyo-circle',
    type: 'circle',
    paint: {
      'circle-radius': 6,
      'circle-color': [
        'case',
        ['boolean', ['get', 'arrived'], false], '#ff0000', '#888888'
      ],
      'circle-opacity': 0.9,
      'circle-stroke-width': 2,
      'circle-stroke-color': [
        'case',
        ['boolean', ['get', 'arrived'], false], '#ff0000', '#888888'
      ],
    },
  };

  // fitBounds 처리
  useEffect(() => {
    if (disableAutoFit) return;
    const coords: [number, number][] = [];
    pointCoords.forEach(p => coords.push([p.lng, p.lat]));
    const epic = earthquakePosition ?? eewEpicenterPosition ?? wolfxJmaEpicenter ?? wolfxScEpicenter ?? wolfxFjEpicenter ?? wolfxCencEpicenter ?? null;
    if (epic) coords.push([epic[1], epic[0]]);
    // Include tsunami bars if available
    if (tsunamiFeatures && tsunamiFeatures.length > 0) {
      tsunamiFeatures.forEach(f => {
        coords.push(f.from);
        coords.push(f.to);
      });
    }
    if (coords.length === 0) return;
    if (!mapRef.current) return;

    if (coords.length === 1) {
      mapRef.current.getMap().flyTo({ center: coords[0] as any, zoom: 9, duration: 500 } as any);
      return;
    }
    const lngs = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    try {
      mapRef.current.getMap().fitBounds([[minLng, minLat], [maxLng, maxLat]] as any, { padding: 50, duration: 600 } as any);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, tsunamiFeatures, disableAutoFit]);

  // Auto-fit when tsunami announced (bars appear), even without fitKey changes
  useEffect(() => {
    if (disableAutoFit) return;
    if (!mapRef.current) return;
    if (!tsunamiFeatures || tsunamiFeatures.length === 0) return;
    const coords: [number, number][] = [];
    tsunamiFeatures.forEach(f => { coords.push(f.from); coords.push(f.to); });
    const epic = earthquakePosition ?? eewEpicenterPosition ?? wolfxJmaEpicenter ?? wolfxScEpicenter ?? wolfxFjEpicenter ?? wolfxCencEpicenter ?? null;
    if (epic) coords.push([epic[1], epic[0]]);
    if (coords.length === 0) return;
    try {
      const lngs = coords.map(c => c[0]);
      const lats = coords.map(c => c[1]);
      const minLng = Math.min(...lngs);
      const maxLng = Math.max(...lngs);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      mapRef.current.getMap().fitBounds([[minLng, minLat], [maxLng, maxLat]] as any, { padding: 70, duration: 600 } as any);
    } catch {}
  }, [tsunamiFeatures, disableAutoFit]);

  const [hoveredPointIdx, setHoveredPointIdx] = useState<number | null>(null);

  return (
    <div
      className={styles.mapContainer}
      style={{ pointerEvents: interactive ? 'auto' : 'none' }}
      onMouseDown={() => { try { onUserInteracted && onUserInteracted(); } catch {} }}
      onTouchStart={() => { try { onUserInteracted && onUserInteracted(); } catch {} }}
    >
      <MapGL
        ref={mapRef}
        mapLib={import('maplibre-gl') as unknown as any}
        initialViewState={{ longitude: defaultPosition[1], latitude: defaultPosition[0], zoom: 5 }}
        mapStyle={mapStyleUrl}
        onMove={(e) => setZoomLevel(e.viewState.zoom)}
        onMoveStart={() => { try { onUserInteracted && onUserInteracted(); } catch {} }}
        scrollZoom={interactive}
        dragPan={interactive as any}
        dragRotate={interactive as any}
        doubleClickZoom={interactive as any}
        keyboard={interactive as any}
        touchZoomRotate={interactive as any}
        touchPitch={interactive as any}
        attributionControl
      >
      {/* Main earthquake marker */}
      {earthquakePosition && (
        <Marker longitude={earthquakePosition[1]} latitude={earthquakePosition[0]} anchor="bottom">
          <img src="/marker.png" alt="epicenter" style={{ width: 38, height: 38 }} />
        </Marker>
      )}

      {/* Points 마커 */}
      {pointCoords.map((pt, idx) => {
        const icon = getMagnitudeIcon(pt.scale, getIconPixelSizeForZoom(zoomLevel));
        return (
          <Marker key={idx} longitude={pt.lng} latitude={pt.lat} anchor="center">
            <img
              src={icon.url}
              alt={pt.addr}
              style={{ width: icon.size, height: icon.size, transform: 'translate(-50%, -50%)' }}
            />
          </Marker>
        );
      })}

      {/* EEW Epicenter & Wolfx fallbacks */}
      {eewEpicenterPosition && (
        <Marker longitude={eewEpicenterPosition[1]} latitude={eewEpicenterPosition[0]} anchor="center">
          <img src="/globe.svg" alt="EEW epicenter" style={{ width: 20, height: 20 }} />
        </Marker>
      )}
      {!eewEpicenterPosition && wolfxJmaEpicenter && (
        <Marker longitude={wolfxJmaEpicenter[1]} latitude={wolfxJmaEpicenter[0]} anchor="center">
          <img src="/globe.svg" alt="JMA EEW (Wolfx)" style={{ width: 20, height: 20 }} />
        </Marker>
      )}
      {!eewEpicenterPosition && !wolfxJmaEpicenter && wolfxScEpicenter && (
        <Marker longitude={wolfxScEpicenter[1]} latitude={wolfxScEpicenter[0]} anchor="center">
          <img src="/globe.svg" alt="Sichuan EEW (Wolfx)" style={{ width: 20, height: 20 }} />
        </Marker>
      )}
      {!eewEpicenterPosition && !wolfxJmaEpicenter && !wolfxScEpicenter && wolfxFjEpicenter && (
        <Marker longitude={wolfxFjEpicenter[1]} latitude={wolfxFjEpicenter[0]} anchor="center">
          <img src="/globe.svg" alt="Fujian EEW (Wolfx)" style={{ width: 20, height: 20 }} />
        </Marker>
      )}
      {!eewEpicenterPosition && !wolfxJmaEpicenter && !wolfxScEpicenter && !wolfxFjEpicenter && wolfxCencEpicenter && (
        <Marker longitude={wolfxCencEpicenter[1]} latitude={wolfxCencEpicenter[0]} anchor="center">
          <img src="/globe.svg" alt="CENC EEW (Wolfx)" style={{ width: 20, height: 20 }} />
        </Marker>
      )}

      {/* Tokyo arrival indicator */}
      {tokyoArrive !== null && (
        <Source id="tokyo-src" type="geojson" data={tokyoGeoJson as any}>
          <Layer {...tokyoCircleLayer} />
        </Source>
      )}

      {/* PEWS circles */}
      {pewsData.length > 0 && (
        <Source id="pews-src" type="geojson" data={pewsGeoJson as any}>
          <Layer {...pewsCircleLayer} />
        </Source>
      )}

      {/* Korean stations layer */}
      {krStations.length > 0 && (
        <Source id="kr-stations-src" type="geojson" data={krStationsGeoJson as any}>
          <Layer {...krStationsCircleLayer} />
        </Source>
      )}

      {/* Tsunami bars */}
      {tsunamiPlacedFeatures.length > 0 && tsunamiPlacedFeatures.map((f, idx) => {
        // Convert desired ground meters to pixels for current zoom/lat
        const meters = (Number.isFinite(f.meters as any) ? (f.meters as number) : 1);
        const metersPerPixel = 156543.03392 * Math.cos((f.lat * Math.PI) / 180) / Math.pow(2, zoomLevel);
        const barMetersOnGround = meters * 60000; // keep same visual scaling as before (60km per 1m)
        const pxHeight = Math.max(20, Math.min(800, Math.round(barMetersOnGround / metersPerPixel)));
        const pxWidth = 14;
        const capSize = 8;
        const color = f.color;
        return (
          <React.Fragment key={`tsu-bar-${idx}`}>
            <Marker longitude={f.lon} latitude={f.lat} anchor="center">
              <div style={{
                width: pxWidth,
                height: pxHeight,
                background: color,
                borderRadius: pxWidth/2,
                boxShadow: '0 0 0 2px #ffffff',
                transform: `translate(calc(-50% + ${f.offsetPx}px), -50%) rotate(${f.angleDeg}deg)`,
                zIndex: f.z,
                position: 'relative',
              }} />
            </Marker>
            {/* No extra cap circle; bar has rounded ends via borderRadius */}
          </React.Fragment>
        );
      })}
      </MapGL>
    </div>
  );
};

export default EqoMap;
