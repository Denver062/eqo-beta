import { supabase } from './supabase';

export interface GeocodeResult {
  formatted_address: string;
  latitude: number;
  longitude: number;
}

export async function geocodeLocation(location: string): Promise<GeocodeResult | null> {
  // 1. 먼저 캐시에서 조회
  const { data: cachedData, error } = await supabase
    .from('location_cache')
    .select('*')
    .eq('query', location)
    .single();

  // 2. 캐시에 있으면 캐시된 데이터 반환
  if (cachedData && !error) {
    return {
      formatted_address: cachedData.formatted_address,
      latitude: cachedData.latitude,
      longitude: cachedData.longitude,
    };
  }

  // 3. 캐시에 없으면 OpenCage API 호출
  const apiKey = process.env.NEXT_PUBLIC_OPENCAGE_API_KEY;
  if (!apiKey) {
    throw new Error('OpenCage API key is not configured');
  }

  const response = await fetch(
    `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(location)}&key=${apiKey}&language=ko&pretty=1`
  );
  
  if (!response.ok) {
    throw new Error('Failed to fetch geocoding data');
  }

  const data = await response.json();
  
  if (!data.results || data.results.length === 0) {
    return null;
  }

  const result = data.results[0];
  const geocodeResult = {
    formatted_address: result.formatted,
    latitude: result.geometry.lat,
    longitude: result.geometry.lng,
  };

  // 4. 결과를 캐시에 저장 (비동기로 처리, 실패해도 무시)
  try {
    await supabase
      .from('location_cache')
      .insert([
        {
          query: location,
          formatted_address: geocodeResult.formatted_address,
          latitude: geocodeResult.latitude,
          longitude: geocodeResult.longitude,
        },
      ]);
  } catch (err) {
    console.error('Failed to cache geocode result:', err);
    // 캐시 저장에 실패해도 에러를 던지지 않고 계속 진행
  }

  return geocodeResult;
}
