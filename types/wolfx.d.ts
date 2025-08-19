// Wolfx API types

export interface WolfxJmaEew {
  jma_eew: string; // type field name in docs
  Title: string;
  CodeType: string;
  Issue: {
    Source: string;
    Status: string;
  };
  EventID: string;
  Serial: number;
  AnnouncedTime: string; // JST
  OriginTime: string; // JST
  Hypocenter: string;
  Latitude: number;
  Longitude: number;
  Magunitude: number;
  Depth: number;
  MaxIntensity: string; // e.g., Weak/Strong
  Accuracy: {
    Epicenter: string;
    Depth: string;
    Magnitude: string;
  };
  MaxIntChange: {
    String: string;
    Reason: string;
  };
  WarnArea?: {
    Chiiki: string;
    Shindo1: string;
    Shindo2: string;
    Time: string;
    Type: 'Forecast' | 'Warning';
    Arrive: boolean;
  }[];
  isSea: boolean;
  isTraining: boolean;
  isAssumption: boolean;
  isWarn: boolean;
  isFinal: boolean;
  isCancel: boolean;
  OriginalText: string;
}

export interface WolfxScEew {
  sc_eew: string;
  ID: number;
  EventID: string;
  ReportTime: string; // CST
  ReportNum: number;
  OriginTime: string; // CST
  HypoCenter: string;
  Latitude: number;
  Longitude: number;
  Magunitude: number;
  Depth: number; // May be 0 if not provided
  MaxIntensity: number;
}

export interface WolfxCencEew {
  cenc_eew: string;
  ID: number;
  EventID: string;
  ReportTime: string; // CST
  ReportNum: number;
  OriginTime: string; // CST
  HypoCenter: string;
  Latitude: number;
  Longitude: number;
  Magunitude: number;
  Depth: number;
  MaxIntensity: number;
}

export interface WolfxFjEew {
  fj_eew: string;
  ID: number;
  EventID: string;
  ReportTime: string; // CST
  ReportNum: number;
  OriginTime: string; // CST
  HypoCenter: string;
  Latitude: number;
  Longitude: number;
  Magunitude: number;
  isFinal: boolean;
}

export type WolfxAnyEew =
  | { source: 'JMA'; payload: WolfxJmaEew }
  | { source: 'SC'; payload: WolfxScEew }
  | { source: 'CENC'; payload: WolfxCencEew }
  | { source: 'FJ'; payload: WolfxFjEew };

export interface WolfxJmaEqListItem {
  jma_eqlist: string;
  Title: string;
  No: string; // '1'..'50'
  time: string; // JST
  location: string;
  magnitude: string;
  shindo: string; // with ±
  depth: string;
  latitude: string;
  longitude: string;
  info?: string;
  md5: string;
}

export interface WolfxCencEqListItem {
  cenc_eqlist: string;
  No: string;
  type: string; // automatic|reviewed
  time: string; // CST
  location: string;
  magnitude: string;
  depth: string;
  latitude: string;
  longitude: string;
  intensity: string;
  md5: string;
}


