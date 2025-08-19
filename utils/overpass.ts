import L from 'leaflet';

interface OverpassGeoJsonFeature {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags: { [key: string]: string };
  bounds?: {
    minlat: number;
    minlon: number;
    maxlat: number;
    maxlon: number;
  };
  nodes?: number[];
  members?: {
    type: string;
    ref: number;
    role: string;
    geometry?: { lat: number; lon: number }[];
  }[];
  geometry?: { lat: number; lon: number }[];
}

interface OverpassApiResponse {
  version: number;
  generator: string;
  osm3s: {
    timestamp_osm_base: string;
    copyright: string;
  };
  elements: OverpassGeoJsonFeature[];
}

// Helper to convert Overpass API response to Leaflet-compatible GeoJSON
const osmtogeojson = (data: OverpassApiResponse): L.GeoJSON => {
  const features: GeoJSON.Feature[] = [];

  data.elements.forEach(element => {
    let geometry: GeoJSON.Geometry | null = null;
    let properties: GeoJSON.GeoJsonProperties = element.tags;

    if (element.type === 'node') {
      geometry = {
        type: 'Point',
        coordinates: [element.lon!, element.lat!]
      };
    } else if (element.type === 'way') {
      const coordinates: GeoJSON.Position[] = element.geometry!.map(node => [node.lon, node.lat]);
      geometry = {
        type: 'LineString',
        coordinates: coordinates
      };
      // If it's a closed way, it could be a Polygon
      if (coordinates[0][0] === coordinates[coordinates.length - 1][0] &&
          coordinates[0][1] === coordinates[coordinates.length - 1][1]) {
        geometry = {
          type: 'Polygon',
          coordinates: [coordinates]
        };
      }
    } else if (element.type === 'relation') {
      // For relations, we'll try to extract geometries from members
      const multiPolygonCoordinates: GeoJSON.Position[][][] = [];
      element.members?.forEach(member => {
        if (member.type === 'way' && member.geometry) {
          const coordinates: GeoJSON.Position[] = member.geometry.map(node => [node.lon, node.lat]);
          if (coordinates.length > 0) {
            multiPolygonCoordinates.push([coordinates]);
          }
        }
      });
      if (multiPolygonCoordinates.length > 0) {
        geometry = {
          type: 'MultiPolygon',
          coordinates: multiPolygonCoordinates
        };
      }
    }

    if (geometry) {
      features.push({
        type: 'Feature',
        properties: properties,
        geometry: geometry
      });
    }
  });

  return L.geoJSON( {
    type: 'FeatureCollection',
    features: features
  } as GeoJSON.FeatureCollection);
};

export const fetchGeoJsonFromAddr = async (addr: string): Promise<L.GeoJSON | null> => {
  // Basic parsing of addr to extract prefecture and area name
  // This is a simplified parsing and might need refinement for more complex addresses
  const parts = addr.split('県');
  let prefecture = '';
  let areaName = addr;

  if (parts.length > 1) {
    prefecture = parts[0] + '県';
    areaName = parts[1].trim();
  } else {
    // If no prefecture, assume it's a direct area name or a city
    // This part needs more robust parsing for general cases
    const cityParts = addr.split('市');
    if (cityParts.length > 1) {
      areaName = cityParts[0] + '市';
    }
  }

  // Remove "十島村" from areaName if present, as it's part of the prefecture context
  areaName = areaName.replace('十島村', '').trim();

  // Construct Overpass QL query
  let query = `[out:json][timeout:25];`;
  if (prefecture) {
    query += `area["name"="${prefecture}"]->.pref;`;
    query += `rel(area.pref)["name"="${areaName}"]["admin_level"];`;
  } else {
    query += `rel["name"="${areaName}"]["admin_level"];`;
  }
  query += `out body;>;out geom;`;

  const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(overpassUrl);
    if (!response.ok) {
      console.error(`Overpass API request failed: ${response.statusText}`);
      return null;
    }
    const data: OverpassApiResponse = await response.json();
    if (data.elements.length === 0) {
      console.warn(`No GeoJSON data found for address: ${addr}`);
      return null;
    }
    return osmtogeojson(data);
  } catch (error) {
    console.error(`Error fetching GeoJSON for ${addr}:`, error);
    return null;
  }
};
