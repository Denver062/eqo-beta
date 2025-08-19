import '../styles/globals.css';
import 'leaflet/dist/leaflet.css'; // Add this line for Leaflet CSS
import type { AppProps } from 'next/app';
import dynamic from 'next/dynamic';
import { useState, useEffect } from 'react';
import { ThemeProvider } from '../contexts/ThemeContext';
import { LoadingProvider, useLoading } from '../contexts/LoadingContext';
import loadingStyles from '../styles/LoadingIndicator.module.css';
import statusStyles from '../styles/WolfxStatus.module.css';
import { useWebSocket } from '../contexts/WebSocketContext';

const WebSocketProvider = dynamic(() => import('../contexts/WebSocketContext').then(mod => mod.WebSocketProvider), {
  ssr: false,
});

const LoadingIndicator = () => {
  const { isLoading } = useLoading();
  if (!isLoading) return null;

  return (
    <div className={loadingStyles.loadingIndicator}>
      読み込み中...
    </div>
  );
};

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <ThemeProvider>
      <LoadingProvider>
        <WebSocketProvider>
          <Component {...pageProps} />
          <WolfxStatusWidget />
          <AudioTtsUnlocker />
        </WebSocketProvider>
        <LoadingIndicator />
      </LoadingProvider>
    </ThemeProvider>
  );
}

export default MyApp;

const WolfxStatusWidget = () => {
  const ws = useWebSocket();
  if (!ws) return null;
  const { wolfxStatus, wolfxJma, wolfxSc, wolfxFj, wolfxCenc } = ws as any;
  const [showRaw, setShowRaw] = useState(false);
  const ago = (ts: number | null) => (ts ? Math.max(0, Math.floor((Date.now() - ts) / 1000)) : null);
  const jAgo = ago(wolfxStatus.jmaLast);
  const sAgo = ago(wolfxStatus.scLast);
  const fAgo = ago(wolfxStatus.fjLast);
  const cAgo = ago(wolfxStatus.cencLast);
  const fmtMag = (m?: number) => (typeof m === 'number' && isFinite(m) ? m.toFixed(1) : '-');
  return (
    <div className={statusStyles.statusBox}>
      <div className={statusStyles.rawToggle}>
        <label>
          <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} /> RAW
        </label>
      </div>
      <div className={statusStyles.row}>
        <span className={`${statusStyles.dot} ${wolfxStatus.jmaConnected ? statusStyles.ok : statusStyles.ng}`} />
        <span>JMA</span>
        <span className={statusStyles.dim}>{jAgo !== null ? `${jAgo}s` : '-'}</span>
      </div>
      {wolfxJma && (
        <div className={statusStyles.detail}>
          {`${wolfxJma.Hypocenter}  M${fmtMag(wolfxJma.Magunitude)}  深さ${wolfxJma.Depth ?? '-'}  震度${wolfxJma.MaxIntensity}${wolfxJma.isWarn ? ' 警報' : ''}`}
        </div>
      )}
      {showRaw && wolfxJma && (
        <pre className={statusStyles.json}>{JSON.stringify(wolfxJma, null, 2)}</pre>
      )}
      {showRaw && !wolfxJma && (
        <pre className={statusStyles.json}>{JSON.stringify({ status: wolfxStatus.jmaConnected ? 'connected' : 'disconnected', last: wolfxStatus.jmaLast }, null, 2)}</pre>
      )}
      <div className={statusStyles.row}>
        <span className={`${statusStyles.dot} ${wolfxStatus.scConnected ? statusStyles.ok : statusStyles.ng}`} />
        <span>SC</span>
        <span className={statusStyles.dim}>{sAgo !== null ? `${sAgo}s` : '-'}</span>
      </div>
      {wolfxSc && (
        <div className={statusStyles.detail}>
          {`${wolfxSc.HypoCenter}  M${fmtMag(wolfxSc.Magunitude)}  震度${wolfxSc.MaxIntensity ?? '-'}`}
        </div>
      )}
      {showRaw && wolfxSc && (
        <pre className={statusStyles.json}>{JSON.stringify(wolfxSc, null, 2)}</pre>
      )}
      {showRaw && !wolfxSc && (
        <pre className={statusStyles.json}>{JSON.stringify({ status: wolfxStatus.scConnected ? 'connected' : 'disconnected', last: wolfxStatus.scLast }, null, 2)}</pre>
      )}
      <div className={statusStyles.row}>
        <span className={`${statusStyles.dot} ${wolfxStatus.fjConnected ? statusStyles.ok : statusStyles.ng}`} />
        <span>FJ</span>
        <span className={statusStyles.dim}>{fAgo !== null ? `${fAgo}s` : '-'}</span>
      </div>
      {wolfxFj && (
        <div className={statusStyles.detail}>
          {`${wolfxFj.HypoCenter}  M${fmtMag(wolfxFj.Magunitude)}  ${wolfxFj.isFinal ? '最終' : ''}`}
        </div>
      )}
      {showRaw && wolfxFj && (
        <pre className={statusStyles.json}>{JSON.stringify(wolfxFj, null, 2)}</pre>
      )}
      {showRaw && !wolfxFj && (
        <pre className={statusStyles.json}>{JSON.stringify({ status: wolfxStatus.fjConnected ? 'connected' : 'disconnected', last: wolfxStatus.fjLast }, null, 2)}</pre>
      )}
      <div className={statusStyles.row}>
        <span className={`${statusStyles.dot} ${statusStyles.ok}`} />
        <span>CENC</span>
        <span className={statusStyles.dim}>{cAgo !== null ? `${cAgo}s` : '-'}</span>
      </div>
      {wolfxCenc && (
        <div className={statusStyles.detail}>
          {`${wolfxCenc.HypoCenter}  M${fmtMag(wolfxCenc.Magunitude)}  震度${wolfxCenc.MaxIntensity ?? '-'}`}
        </div>
      )}
      {showRaw && wolfxCenc && (
        <pre className={statusStyles.json}>{JSON.stringify(wolfxCenc, null, 2)}</pre>
      )}
      {showRaw && !wolfxCenc && (
        <pre className={statusStyles.json}>{JSON.stringify({ status: 'polling', last: wolfxStatus.cencLast }, null, 2)}</pre>
      )}
    </div>
  );
};

const AudioTtsUnlocker = () => {
  useEffect(() => {
    let unlocked = false;
    const unlock = () => {
      if (unlocked) return;
      unlocked = true;
      try {
        const audio = new Audio('/notification.mp3');
        audio.volume = 0.001;
        audio.play().then(() => {
          setTimeout(() => {
            try { audio.pause(); audio.currentTime = 0; } catch {}
          }, 60);
        }).catch(() => {});
      } catch {}
      try {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(' ');
          u.volume = 0;
          u.lang = 'ja-JP';
          window.speechSynthesis.speak(u);
        }
      } catch {}
      window.removeEventListener('click', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
    window.addEventListener('click', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);
    return () => {
      window.removeEventListener('click', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
  }, []);
  return null;
};