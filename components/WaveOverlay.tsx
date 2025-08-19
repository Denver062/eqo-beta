import React, { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';

type Props = {
  center: { lat: number; lng: number } | null;
  originTimeMs: number | null;
  depthKm: number | null;
  getRadiusMeters: (elapsedSec: number, phase: 'P' | 'S') => number; // provided by caller (e.g., travel-time)
};

// Lightweight canvas overlay that draws animated P/S waves in screen space
// to avoid projection artifacts, while using physically-derived radii.
const WaveOverlay: React.FC<Props> = ({ center, originTimeMs, depthKm, getRadiusMeters }) => {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  // Resize canvas to map container
  const fitCanvasToMap = () => {
    const canvas = canvasRef.current;
    const container = map.getContainer();
    if (!canvas) return;
    const { clientWidth, clientHeight } = container;
    if (canvas.width !== clientWidth || canvas.height !== clientHeight) {
      canvas.width = clientWidth;
      canvas.height = clientHeight;
    }
  };

  const metersToPixels = (lat: number, meters: number) => {
    // East-west conversion at latitude (approx). 1 deg lon ≈ 111320*cos(lat)
    const dLon = (meters / (111320 * Math.cos((lat * Math.PI) / 180)));
    const p0 = map.latLngToContainerPoint([lat, center!.lng]);
    const p1 = map.latLngToContainerPoint([lat, center!.lng + dLon]);
    return Math.hypot(p1.x - p0.x, p1.y - p0.y);
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas || !center || !originTimeMs) return;
    fitCanvasToMap();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const now = Date.now();
    const elapsedSec = Math.max(0, (now - originTimeMs) / 1000);

    // Compute radii in meters using provided travel-time function
    const pRM = getRadiusMeters(elapsedSec, 'P');
    const sRM = getRadiusMeters(elapsedSec, 'S');
    const cx = map.latLngToContainerPoint([center.lat, center.lng]);
    const rP = metersToPixels(center.lat, pRM);
    const rS = metersToPixels(center.lat, Math.min(sRM, Math.max(0, pRM - 1000)));

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(cx.x, cx.y);

    // P-wave: radial gradient ring
    const pGrad = ctx.createRadialGradient(0, 0, Math.max(0, rP - 16), 0, 0, rP);
    pGrad.addColorStop(0.0, 'rgba(25,118,210,0.0)');
    pGrad.addColorStop(0.6, 'rgba(25,118,210,0.15)');
    pGrad.addColorStop(1.0, 'rgba(25,118,210,0.0)');
    ctx.beginPath();
    ctx.arc(0, 0, rP, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(25,118,210,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = pGrad;
    ctx.fill();

    // S-wave: sinusoidal ring to emulate shear pattern
    const amp = Math.min(12, Math.max(6, rS * 0.02)); // px amplitude bounded
    const k = 18; // lobes around circumference
    const w = 2.2; // animation speed
    ctx.beginPath();
    const steps = 720;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const mod = amp * Math.sin(k * t - w * elapsedSec);
      const rr = Math.max(0, rS + mod);
      const x = rr * Math.cos(t);
      const y = rr * Math.sin(t);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(229,57,53,0.85)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.restore();
    rafRef.current = requestAnimationFrame(draw);
  };

  useEffect(() => {
    const onChange = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
    };
    onChange();
    map.on('move zoom resize', onChange);
    return () => {
      map.off('move zoom resize', onChange);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.lat, center?.lng, originTimeMs]);

  return (
    <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 400 }} />
  );
};

export default WaveOverlay;



