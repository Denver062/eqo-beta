import { useCallback, useEffect, useRef, useState } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

interface KoreanStation {
  id: number;
  latitude: number;
  longitude: number;
  name: string;
  mmi?: number;
}

interface ApiResponse {
  success: boolean;
  data?: {
    stations: KoreanStation[];
    timestamp: string;
    source: string;
    totalStations: number;
    warning?: string;
  };
  error?: string;
  message?: string;
}

// MMI 값을 로마 숫자로 변환
const getMMIDescription = (mmi: number | undefined = 0): string => {
  const mmiValue = mmi || 0; // Ensure we have a number
  const descriptions: { [key: number]: string } = {
    0: '의미 없음',
    1: 'Ⅰ-1',
    12: 'Ⅰ-2',
    13: 'Ⅰ-3',
    14: 'Ⅰ-4',
    2: 'Ⅱ',
    3: 'Ⅲ',
    4: 'Ⅳ',
    5: 'Ⅴ',
    6: 'Ⅵ',
    7: 'Ⅶ',
    8: 'Ⅷ',
    9: 'Ⅸ',
    10: 'Ⅹ+',
    11: 'Ⅹ+',
  };
  
  return descriptions[mmiValue] || 'N/A';
};

// 한국 관측소 마커 색상 (MMI 값에 따른 색상)
const getColorByMMI = (mmi: number | undefined = 0): string => {
  const mmiValue = mmi || 0; // Ensure we have a number
  const colors: { [key: number]: string } = {
    0: '#FFFFFF',   // 의미 알 수 없음
    1: '#FFFFFF',   // Ⅰ (세분화 1단계)
    12: '#DFDFDF',  // Ⅰ (세분화 2단계)
    13: '#BFBFBF',  // Ⅰ (세분화 3단계)
    14: '#9F9F9F',  // Ⅰ (세분화 4단계)
    2: '#A0E6FF',   // Ⅱ
    3: '#92D050',   // Ⅲ
    4: '#FFFF00',   // Ⅳ
    5: '#FFC000',   // Ⅴ
    6: '#FF0000',   // Ⅵ
    7: '#A32777',   // Ⅶ
    8: '#632523',   // Ⅷ
    9: '#4C2600',   // Ⅸ
    10: '#000000',  // Ⅹ+
    11: '#000000',  // Ⅹ+
  };
  
  return colors[mmiValue] || '#FFFFFF'; // Default: White
};

interface Point {
  addr: string;
  scale: number;
  lat: number;
  lng: number;
  name?: string;
}

interface KoreanStationMarkersProps {
  points: Point[];
}

// Check if dark mode is enabled
const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

// Marker sizing
const STATION_MARKER_RADIUS_PX = 5; // Adjust this to change size globally

// Get marker style based on MMI
  const getMarkerStyle = (mmi: number | undefined = 0, zoom: number = 5): L.CircleMarkerOptions => {
  // 모든 관측소 마커 크기를 고정(줌 레벨과 무관)하여 일관성 유지
  const radius = STATION_MARKER_RADIUS_PX; // px
  
  const fillColor = getColorByMMI(mmi);
  // 다크 모드이고 마커 색상이 검정색(#000000)인 경우 흰색 테두리 적용
  const borderColor = (isDarkMode && fillColor === '#000000') ? '#FFFFFF' : '#000';
  
  return {
    radius: radius,
    fillColor: fillColor,
    color: borderColor,
     weight: 1,
    opacity: 1,
    fillOpacity: 0.8
  };
};

// Tooltips removed per request

export const KoreanStationMarkers: React.FC<KoreanStationMarkersProps> = ({ points }) => {
  const map = useMap();
  const stationLayersRef = useRef<{ [id: string]: L.CircleMarker }>({});
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [currentZoom, setCurrentZoom] = useState<number>(map?.getZoom() || 5);

  const updateMarkers = useCallback((stations: Array<KoreanStation & { name: string; mmi?: number }>) => {
    if (!map) return;
    
    const updatedLayers: { [id: string]: L.CircleMarker } = {};
    const zoom = map.getZoom();
    setCurrentZoom(zoom);
    
    // Deduplicate by stable id; fallback to rounded coordinates if id collides
    const seen = new Set<string>();
    stations.forEach((station) => {
      // Snap id + quantized lat/lng to avoid duplicates rendered by slight coord changes
      const quantLat = Math.round(station.latitude * 1000) / 1000;
      const quantLng = Math.round(station.longitude * 1000) / 1000;
      const key = `${station.id}-${quantLat}-${quantLng}`;
      if (seen.has(key)) return;
      seen.add(key);

      const existingMarker = stationLayersRef.current[key];
      const newStyle = getMarkerStyle(station.mmi, zoom);
      
      if (existingMarker) {
        // Update existing marker
        if (existingMarker.options.fillColor !== newStyle.fillColor) {
          existingMarker.setStyle(newStyle);
        }
        updatedLayers[key] = existingMarker;
      } else {
        // Create new marker
        const marker = L.circleMarker(
          [station.latitude, station.longitude],
          newStyle
        ).addTo(map);
        // Ensure the drawn circle centers exactly on the coordinate
        marker.setLatLng([station.latitude, station.longitude]);
        
        updatedLayers[key] = marker;
      }
    });
    
    // Remove old markers that are no longer in the data
    Object.entries(stationLayersRef.current).forEach(([id, marker]) => {
      if (!updatedLayers[id]) {
        map.removeLayer(marker);
      }
    });
    
    stationLayersRef.current = updatedLayers;
  }, [map]);

  const [stations, setStations] = useState<KoreanStation[]>([]);

  const fetchStationData = useCallback(async () => {
    if (isLoading) return;
    
    try {
      setIsLoading(true);
      const response = await fetch('/api/korea-stations');
      const data = await response.json();
      
      if (data.success && Array.isArray(data.data?.stations)) {
        // Deduplicate by id to avoid duplicates from API
        const unique = new Map<number, KoreanStation>();
        (data.data.stations as KoreanStation[]).forEach(st => {
          if (!unique.has(st.id)) unique.set(st.id, st);
        });
        const list = Array.from(unique.values());
        setStations(list);
        updateMarkers(list);
      }
    } catch (err) {
      console.error('Error fetching station data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, updateMarkers]);
  
  // Set up auto-refresh
  useEffect(() => {
    let isMounted = true;
    
    const fetchAndUpdate = async () => {
      if (!isMounted) return;
      await fetchStationData();
    };
    
    // Initial fetch
    fetchAndUpdate();
    
    // Set up interval for auto-refresh (1000ms = 1초)
    const intervalId = setInterval(fetchAndUpdate, 1000);
    
    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [fetchStationData]);

  // 지도 zoom 이벤트 핸들러
  useEffect(() => {
    if (!map) return;

    const handleZoom = () => {
      const newZoom = map.getZoom();
      setCurrentZoom(newZoom);
      
      // 모든 마커의 크기를 업데이트
      Object.entries(stationLayersRef.current).forEach(([id, marker]) => {
        const stationId = id.split('-')[0];
        const station = stations.find(s => String(s.id) === stationId);
        if (station) {
          const newRadius = getMarkerStyle(station.mmi, newZoom).radius;
          if (marker.setRadius) {
            marker.setRadius(newRadius);
          } else {
            marker.setStyle({
              ...marker.options,
              radius: newRadius
            });
          }
        }
      });
    };

    map.on('zoom', handleZoom);
    
    return () => {
      if (map) {
        map.off('zoom', handleZoom);
      }
    };
  }, [map, stations]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      // Remove all markers
      Object.values(stationLayersRef.current).forEach(marker => {
        map?.removeLayer(marker);
      });
      stationLayersRef.current = {};
    };
  }, [map]);

  // Update markers when points change
  // Update markers when points change
  // Update markers when points change
  useEffect(() => {
    if (stations.length === 0 || points.length === 0) return;
    
    (points as Point[]).forEach((point) => {
      // Find the closest station to this point based on latitude and longitude
      let closestStation: KoreanStation | null = null;
      let minDistance = Infinity;

      stations.forEach((station) => {
        const distance = Math.sqrt(
          Math.pow(station.latitude - point.lat, 2) +
          Math.pow(station.longitude - point.lng, 2)
        );
        if (distance < minDistance) {
          minDistance = distance;
          closestStation = station;
        }
      });

      // If we found a close enough station, update its MMI
      if (closestStation !== null && minDistance < 0.1) { // 0.1 degrees ~= 11km
        const qLat: number = Math.round((closestStation as KoreanStation).latitude * 1000) / 1000;
        const qLng: number = Math.round((closestStation as KoreanStation).longitude * 1000) / 1000;
        const compKey: string = `${(closestStation as KoreanStation).id}-${qLat}-${qLng}`;
        const marker = stationLayersRef.current[compKey];
        if (marker) {
          // Only update if the color would change
          const newColor = getColorByMMI(point.scale);
          if (marker.options.fillColor !== newColor) {
            marker.setStyle({
              fillColor: newColor,
              fillOpacity: 0.8
            });
          }
        }
      }
    });
  }, [stations, points]);

  return null;
};

export default KoreanStationMarkers;