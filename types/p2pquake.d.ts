export type P2PQuakeData = (EarthquakeData | EEWData | StationIntensityData | TsunamiData);

// 551: 지진 정보
export interface EarthquakeData {
  code: 551;
  time: string;
  earthquake: {
    maxScale: number;
    domesticTsunami: string;
    hypocenter: {
      name: string;
      latitude: number;
      longitude: number;
      depth: number;
      magnitude: number;
    };
  };
  points?: { addr: string; isArea: boolean; pref: string; scale: number }[];
  comments?: {
    freeFormComment?: string;
  };
}

// 556: 긴급지진속보 (EEW)
export interface EEWData {
  code: 556;
  time: string;
  type: '緊急地震速報（予報）' | '緊急地震速報（警報）';
  report_id: string;
  report_num: number;
  report_time: string;
  region_name: string;
  latitude: number;
  longitude: number;
  is_final: boolean;
  is_training: boolean;
  depth: number;
  magnitude: number;
  forecast_max_intensity: string; // 예: '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'
  forecast_max_lpgm_intensity: string; // 예: '1', '2', '3', '4'
  regions: { name: string; forecast_intensity: string; is_warning: boolean }[];
}

// 555: 지점 진도 정보
export interface StationIntensityData {
  code: 555;
  time: string;
  points: { 
    pref: string;
    addr: string;
    lat: number;
    lng: number;
    scale: number; // 진도 계급 (10-70)
  }[];
}

// 552: 津波情報（注意報・警報）
export interface TsunamiData {
  code: 552;
  time: string;
  cancelled: boolean;
  areas: Array<{
    name: string;
    grade: 'Watch' | 'Warning' | string;
    immediate?: boolean;
    maxHeight?: { description?: string; value?: number };
    firstHeight?: { condition?: string; arrivalTime?: string };
  }>;
  [key: string]: any;
}
