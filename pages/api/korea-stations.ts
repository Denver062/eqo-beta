import { NextApiRequest, NextApiResponse } from 'next';
import axios from 'axios';

interface Station {
  id: number;
  latitude: number;
  longitude: number;
  name: string;
  mmi: number;
}

// Helper class to read bits from a Buffer
class BitReader {
  private buffer: Buffer;
  private bitOffset: number;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
    this.bitOffset = 0;
  }

  readBits(numBits: number): number {
    let value = 0;
    for (let i = 0; i < numBits; i++) {
      const byteIndex = Math.floor(this.bitOffset / 8);
      const bitInByteIndex = 7 - (this.bitOffset % 8);
      const bit = (this.buffer[byteIndex] >> bitInByteIndex) & 1;
      value = (value << 1) | bit;
      this.bitOffset++;
    }
    return value;
  }
}

async function fetchMMIData(timestamp: string): Promise<number[]> {
  const b_url = `https://www.weather.go.kr/pews/data/${timestamp}.b`;
  console.log(`Fetching MMI data from: ${b_url}`);

  try {
    const response = await axios.get(b_url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/octet-stream'
      },
      timeout: 10000 // 10 second timeout
    });

    const buffer = Buffer.from(response.data);
    const reader = new BitReader(buffer);
    
    // Skip header (first 32 bits)
    reader.readBits(32);
    
    // Read STMI data (4 bits per station)
    const mmiData: number[] = [];
    const totalStations = Math.floor(((buffer.length * 8) - 32) / 4); // Each MMI is 4 bits
    
    for (let i = 0; i < totalStations; i++) {
      mmiData.push(reader.readBits(4));
    }
    
    console.log(`Successfully parsed ${mmiData.length} MMI values`);
    return mmiData;
  } catch (_error) {
    console.error('Error fetching MMI data');
    throw _error;
  }
}

async function fetchStations(timestamp: string) {
  const s_url = `https://www.weather.go.kr/pews/data/${timestamp}.s`;
  console.log(`Fetching station data from: ${s_url}`);

  try {
    // Fetch station data and MMI data in parallel
    const [stationResponse, mmiData] = await Promise.all([
      axios.get(s_url, { 
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'application/octet-stream'
        },
        timeout: 10000 // 10 second timeout
      }),
      fetchMMIData(timestamp).catch(error => {
        console.error('Failed to fetch MMI data, using default values');
        return null;
      })
    ]);

    const buffer = Buffer.from(stationResponse.data);
    const reader = new BitReader(buffer);
    const stations: Station[] = [];
    const totalStations = Math.floor((buffer.length * 8) / 20); // Each station is 20 bits (10 lat + 10 lon)

    // Parse station coordinates from .s file
    for (let i = 0; i < totalStations; i++) {
      // Read 10 bits for latitude and 10 bits for longitude
      const latBits = reader.readBits(10);
      const lonBits = reader.readBits(10);
      
      // Convert to coordinates (30 + lat/100, 120 + lon/100)
      const lat = 30 + (latBits / 100);
      let lon = 120 + (lonBits / 100);
      
      // Fix for Ulleungdo station coordinates (add 10 to longitude)
      if (lat >= 37.0 && lat <= 38.0 && lon >= 120.0 && lon <= 121.0) {
        lon += 10;
      }
      
      // Get MMI value if available
      const mmi = mmiData && i < mmiData.length ? mmiData[i] : 0;
      
      // Add station to the list
      stations.push({ 
        id: i + 1,  // 1-based index
        latitude: parseFloat(lat.toFixed(6)), 
        longitude: parseFloat(lon.toFixed(6)),
        name: `STN-${i + 1}`,
        mmi: mmi
      });
    }

    console.log(`Successfully parsed ${stations.length} stations with MMI data`);
    return stations;
  } catch (_error) {
    console.error('Error fetching station data');
    throw _error;
  }
}

/**
 * Korean Earthquake Observation Stations API
 * Provides locations of seismic monitoring stations in South Korea
 * 
 * Data source: KMA PEWS (Public Earthquake Warning Service)
 * Format: Binary data with 20 bits per station (10 bits lat, 10 bits lon)
 * Coordinate conversion: lat = 30 + (lat_bits/100), lon = 120 + (lon_bits/100)
 * Special case: Ulleungdo stations need +10 to longitude
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  try {
    // Use UTC+0 for Korean Meteorological Administration PEWS data
    const now = new Date();
    
    // Try to get current data (with 5 second offset to handle server processing delays)
    const utcTime = new Date(now.getTime() - 5000);
    
    // Format timestamp as YYYYMMDDHHmmss
    const year = utcTime.getUTCFullYear();
    const month = String(utcTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(utcTime.getUTCDate()).padStart(2, '0');
    const hours = String(utcTime.getUTCHours()).padStart(2, '0');
    const minutes = String(utcTime.getUTCMinutes()).padStart(2, '0');
    const seconds = String(utcTime.getUTCSeconds()).padStart(2, '0');
    
    const timestamp = `${year}${month}${day}${hours}${minutes}${seconds}`;
    
    // Try to fetch current data
    try {
      const stations = await fetchStations(timestamp);
      return res.status(200).json({
        success: true,
        data: {
          stations,
          timestamp: now.toISOString(),
          source: 'realtime',
          totalStations: stations.length
        }
      });
    } catch (error) {
      console.error('Error fetching current data, trying 1 minute ago...', error);
      
      // If current data fails, try data from 1 minute ago
      const oneMinuteAgo = new Date(now.getTime() - 60000);
      const prevYear = oneMinuteAgo.getUTCFullYear();
      const prevMonth = String(oneMinuteAgo.getUTCMonth() + 1).padStart(2, '0');
      const prevDay = String(oneMinuteAgo.getUTCDate()).padStart(2, '0');
      const prevHours = String(oneMinuteAgo.getUTCHours()).padStart(2, '0');
      const prevMinutes = String(oneMinuteAgo.getUTCMinutes()).padStart(2, '0');
      const prevSeconds = String(oneMinuteAgo.getUTCSeconds()).padStart(2, '0');
      
      const prevTimestamp = `${prevYear}${prevMonth}${prevDay}${prevHours}${prevMinutes}${prevSeconds}`;
      
      try {
        const stations = await fetchStations(prevTimestamp);
        return res.status(200).json({
          success: true,
          data: {
            stations,
            timestamp: oneMinuteAgo.toISOString(),
            source: '1min-delayed',
            totalStations: stations.length,
            warning: 'Using data from 1 minute ago'
          }
        });
      } catch (fallbackError) {
        console.error('Error fetching fallback data:', fallbackError);
        throw new Error('Failed to fetch station data from both current and fallback sources');
      }
    }
  } catch (error) {
    console.error('Error in API handler:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch station data',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
      timestamp: new Date().toISOString()
    });
  }
}
