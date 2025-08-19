import React, { useState, useEffect, useContext } from 'react';
import styles from './Sidebar.module.css';
import { Activity, Clock, Moon, Sun, AlertTriangle, MapPin, Zap, Layers, Timer, Target, Navigation, Settings } from 'lucide-react'; // Import icons from lucide-react
import { ThemeContext } from '../contexts/ThemeContext';
import { EEWData } from '../types/p2pquake';
import type { WolfxJmaEew, WolfxScEew, WolfxCencEew, WolfxFjEew } from '../types/wolfx';

interface Earthquake {
  time: string;
  location: string;
  depth: number;
  magnitude: number;
  intensity: number;
  latitude: number | null;
  longitude: number | null;
  intensityText?: string;
  source?: 'JMA' | 'KMA';
}

interface SidebarProps {
  intensity: number;
  intensityText?: string;
  magnitude: number;
  depth: number;
  location: string;
  tsunamiWarning: 'none' | 'watch' | 'warning' | 'major_warning';
  freeFormComment: string | undefined;
  recentEarthquakes: Earthquake[];
  onEarthquakeClick: (earthquake: Earthquake) => void;
  isTemporaryDisplay: boolean;
  remainingTime: number;
  eewData: EEWData | null; // EEW 데이터 추가
  onEewClose: () => void; // EEW 닫기 함수 추가
  isPewsAvailable?: boolean;
  // Wolfx sources
  wolfxJma?: WolfxJmaEew | null;
  wolfxSc?: WolfxScEew | null;
  wolfxCenc?: WolfxCencEew | null;
  wolfxFj?: WolfxFjEew | null;
}

const Sidebar: React.FC<SidebarProps> = ({
  intensity,
  intensityText,
  magnitude,
  depth,
  location,
  tsunamiWarning,
  freeFormComment,
  recentEarthquakes,
  onEarthquakeClick,
  isTemporaryDisplay,
  remainingTime,
  eewData,
  onEewClose,
  isPewsAvailable = true,
  wolfxJma,
  wolfxSc,
  wolfxCenc,
  wolfxFj,
}) => {
  const { theme, toggleTheme } = useContext(ThemeContext);
  const [time, setTime] = useState<Date | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  useEffect(() => {
    setTime(new Date()); // Set initial time on client
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const getTsunamiInfo = () => {
    switch (tsunamiWarning) {
      case 'major_warning':
        return { text: '大津波警報', className: styles.tsunamiWarning_major_warning };
      case 'warning':
        return { text: '津波警報', className: styles.tsunamiWarning_warning };
      case 'watch':
        return { text: '津波注意報', className: styles.tsunamiWarning_watch };
      default:
        return { text: '津波の心配なし', className: styles.tsunamiWarning_none };
    }
  };

  const getIntensityClassName = (intensityValue: number) => {
    if (intensityValue >= 70) return styles.intensity70;
    if (intensityValue >= 65) return styles.intensity65;
    if (intensityValue >= 60) return styles.intensity60;
    if (intensityValue >= 55) return styles.intensity55;
    if (intensityValue >= 50) return styles.intensity50;
    if (intensityValue >= 40) return styles.intensity40;
    if (intensityValue >= 30) return styles.intensity30;
    if (intensityValue >= 20) return styles.intensity20;
    if (intensityValue >= 10) return styles.intensity10;
    return '';
  };

  const convertIntensityToString = (intensityValue: number, isRecent: boolean = false): string => {
    if (intensityValue < 0) {
      return isRecent ? '?' : '情報なし';
    }
    switch (intensityValue) {
      case 10: return '1';
      case 20: return '2';
      case 30: return '3';
      case 40: return '4';
      case 45: return '5-';
      case 50: return '5+';
      case 55: return '6-';
      case 60: return '6+';
      case 70: return '7';
      default: return '?';
    }
  };

  const convertWolfxIntensityToDisplay = (maxIntensity: string): { display: string; classValue: number } => {
    switch (maxIntensity) {
      case '1': return { display: '1', classValue: 10 };
      case '2': return { display: '2', classValue: 20 };
      case '3': return { display: '3', classValue: 30 };
      case '4': return { display: '4', classValue: 40 };
      case '5弱': case '5-': return { display: '5弱', classValue: 45 };
      case '5強': case '5+': return { display: '5強', classValue: 50 };
      case '6弱': case '6-': return { display: '6弱', classValue: 55 };
      case '6強': case '6+': return { display: '6強', classValue: 60 };
      case '7': return { display: '7', classValue: 70 };
      default: return { display: maxIntensity, classValue: 20 }; // default to 2
    }
  };

  const getMagnitudeClassName = (magnitudeValue: number) => {
    if (magnitudeValue >= 7.0) return styles.magnitude_major;
    if (magnitudeValue >= 5.0) return styles.magnitude_moderate;
    if (magnitudeValue >= 3.0) return styles.magnitude_light;
    return styles.magnitude_minor;
  };

  const getDepthClassName = (depthValue: number) => {
    if (depthValue > 0 && depthValue <= 10) return styles.depth_very_shallow;
    if (depthValue > 10 && depthValue <= 20) return styles.depth_shallow_mid;
    if (depthValue > 20 && depthValue < 30) return styles.depth_shallow;
    if (depthValue >= 30 && depthValue < 100) return styles.depth_intermediate;
    if (depthValue >= 100) return styles.depth_deep;
    return styles.depth_shallow; // Default or fallback
  };

  

  const isNormal = !location && tsunamiWarning === 'none' && !eewData;

  const normalizeRoman = (text: string): string => {
    const map: Record<string, string> = {
      'Ⅰ': 'I', 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV', 'Ⅴ': 'V', 'Ⅵ': 'VI', 'Ⅶ': 'VII', 'Ⅷ': 'VIII', 'Ⅸ': 'IX', 'Ⅹ': 'X', 'Ⅺ': 'XI', 'Ⅻ': 'XII'
    };
    let s = (text || '').trim().toUpperCase();
    Object.entries(map).forEach(([u, a]) => { s = s.split(u).join(a); });
    // Keep only roman letters I,V,X plus optional '+'
    const m = s.match(/(XII|XI|IX|IV|VIII|VII|VI|V|IV|III|II|I|X)(\+)?/);
    if (!m) return s;
    return (m[1] + (m[2] || '')).trim();
  };

  const getRomanClassName = (roman: string): string => {
    const r = normalizeRoman(roman);
    if (r === 'I') return styles.romanI;
    if (r === 'II') return styles.romanII;
    if (r === 'III') return styles.romanIII;
    if (r === 'IV') return styles.romanIV;
    if (r === 'V') return styles.romanV;
    if (r === 'VI') return styles.romanVI;
    if (r === 'VII') return styles.romanVII;
    if (r === 'IX') return styles.romanIX;
    if (r === 'X+' || r === 'XPLUS') return styles.romanXPlus;
    return '';
  };

  return (
    <aside className={styles.sidebar}>
      <div className={`${styles.header} ${isSettingsOpen ? styles.headerRounded : ''}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button onClick={toggleTheme} className={styles.themeToggleButton}>
            {theme === 'light' ? <Moon size={20} color="black" /> : <Sun size={20} color="white" />}
          </button>
          <span /* style={{ color: isPewsAvailable ? undefined : 'red' }} */>UTC+9</span>
        </div>
        <div className={styles.headerRight}>
          {time && (
            <span /* style={{ color: isPewsAvailable ? undefined : 'red' }} */>
              {time.getFullYear()}/{String(time.getMonth() + 1).padStart(2, '0')}/{String(time.getDate()).padStart(2, '0')} {time.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
      </div>

      {!isSettingsOpen && (eewData ? (
        <div className={styles.infoBlock}> {/* Reusing infoBlock style for EEW */} 
          <h3 className={styles.eewTitle}>
            <AlertTriangle size={20} color="red" /> 緊急地震速報
          </h3>
          <div className={styles.eewDetails}>
            <p><strong>発生時刻:</strong> {new Date(eewData.time).toLocaleString()}</p>
            <p><strong>震源地:</strong> {eewData.region_name}</p>
            <p><strong>マグニチュード:</strong> {eewData.magnitude}</p>
            <p><strong>予想最大震度:</strong> <span className={getIntensityClassName(parseInt(eewData.forecast_max_intensity) * 10)}>{convertIntensityToString(parseInt(eewData.forecast_max_intensity) * 10)}</span></p>
            {eewData.is_training && <p className={styles.trainingMessage}>※これは訓練です</p>}
          </div>
          
          {eewData.regions && eewData.regions.length > 0 && (
            <div className={styles.eewRegionsSection}>
              <h4>主要観測点</h4>
              <ul className={styles.eewRegionsList}>
                {eewData.regions.map((region, index) => (
                  <li key={index} className={styles.eewRegionItem}>
                    <span>{region.name}</span>
                    <span className={getIntensityClassName(parseInt(region.forecast_intensity) * 10)}>{convertIntensityToString(parseInt(region.forecast_intensity) * 10)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button onClick={onEewClose} className={styles.eewCloseButton}>閉じる</button>
        </div>
      ) : wolfxJma ? (
        <div className={`${styles.infoBlock} ${wolfxJma.isCancel ? styles.eewCancelled : ''} ${wolfxJma.isWarn ? styles.eewWarningPulse : ''}`}>
          <h3 className={`${styles.eewTitle} ${styles.titleRow}`}>
            <AlertTriangle size={20} color="red" /> 緊急地震速報
            {wolfxJma.WarnArea && wolfxJma.WarnArea[0]?.Type === 'Warning' && <span className={styles.typeChip}>警報</span>}
            {wolfxJma.isWarn && <span className={styles.alarmChip}>アラーム</span>}
            {wolfxJma.isFinal && <span className={styles.eewTitleBadge}>最終報</span>}
            {wolfxJma.isTraining && <span className={styles.trainingBadge}>訓練</span>}
          </h3>
          <div className={styles.timestamp}>
            <Clock size={16} />
            {wolfxJma.AnnouncedTime}
          </div>
          <div className={styles.location}>{wolfxJma.Hypocenter}</div>

          <div className={styles.mainDetails}>
            {(() => {
              const intensityInfo = convertWolfxIntensityToDisplay(wolfxJma.MaxIntensity);
              return (
                <div className={`${styles.intensity} ${getIntensityClassName(intensityInfo.classValue)}`}>
                  <div className={styles.intensityTitle}>最大震度</div>
                  <div className={styles.intensityValue}>{intensityInfo.display}</div>
                </div>
              );
            })()}
            <div className={`${styles.magnitude} ${getMagnitudeClassName(wolfxJma.Magunitude)}`}>
              <div className={styles.magnitudeTitle}>規模</div>
              <div>M {wolfxJma.Magunitude}</div>
            </div>
            <div className={`${styles.depth} ${getDepthClassName(wolfxJma.Depth)}`}>
              <div className={styles.depthTitle}>深さ</div>
              <div className={styles.depthValue}>{wolfxJma.Depth}km</div>
            </div>
          </div>

          {(() => {
            const tokyoAliases = ['東京都', '東京', '東京地方', '関東', '関東地方'];
            const tokyoWarn = (wolfxJma.WarnArea || []).find(a => tokyoAliases.some(alias => a.Chiiki.includes(alias)));
            if (!tokyoWarn) return null;
            return (
              <div className={styles.eewDetails}>
                <p>
                  <Target size={16} /> <strong>東京都 到達:</strong> {tokyoWarn.Arrive ? '到達' : '未到達'}{tokyoWarn.Time ? `（${tokyoWarn.Time}）` : ''}
                </p>
              </div>
            );
          })()}

          {wolfxJma.isTraining && (
            <div className={styles.trainingMessage}>※これは訓練/テストです。</div>
          )}
          {wolfxJma.isCancel && (
            <div className={styles.cancelledText}>取消報です。</div>
          )}
          
          <div className={`${styles.tsunamiRibbon} ${wolfxJma.isWarn ? styles.tsunamiRibbonWarning : ''}`}>
            津波の心配なし
          </div>
        </div>
      ) : wolfxSc ? (
        <div className={styles.infoBlock}>
          <h3 className={styles.eewTitle}><AlertTriangle size={20} color="orange" /> 四川 预警</h3>
          <div className={styles.eewDetails}>
            <p><strong>发报:</strong> {wolfxSc.ReportTime}</p>
            <p><strong>震中:</strong> {wolfxSc.HypoCenter}</p>
            <p><strong>规模:</strong> {wolfxSc.Magunitude}</p>
            <p><strong>最大烈度:</strong> {wolfxSc.MaxIntensity}</p>
          </div>
        </div>
      ) : wolfxFj ? (
        <div className={styles.infoBlock}>
          <h3 className={styles.eewTitle}><AlertTriangle size={20} color="orange" /> 福建 预警</h3>
          <div className={styles.eewDetails}>
            <p><strong>发报:</strong> {wolfxFj.ReportTime}</p>
            <p><strong>震中:</strong> {wolfxFj.HypoCenter}</p>
            <p><strong>规模:</strong> {wolfxFj.Magunitude}</p>
            <p><strong>终报:</strong> {wolfxFj.isFinal ? '是' : '否'}</p>
          </div>
        </div>
      ) : wolfxCenc ? (
        <div className={styles.infoBlock}>
          <h3 className={styles.eewTitle}><AlertTriangle size={20} color="orange" /> CENC 预警</h3>
          <div className={styles.eewDetails}>
            <p><strong>发报:</strong> {wolfxCenc.ReportTime}</p>
            <p><strong>震中:</strong> {wolfxCenc.HypoCenter}</p>
            <p><strong>规模:</strong> {wolfxCenc.Magunitude}</p>
            <p><strong>最大烈度:</strong> {wolfxCenc.MaxIntensity}</p>
          </div>
        </div>
      ) : isNormal ? (
        <div className={styles.normalState}>
          <div>現在特にお知らせはありません</div>
        </div>
      ) : (
        <div className={styles.infoBlock}>
          <h3>
            <Activity size={20} /> {/* Earthquake Icon */}
            地震情報
          </h3>
          <div className={styles.timestamp}>
            <Clock size={16} /> {/* Time Icon */}
            {isTemporaryDisplay && (
              <span className={styles.temporaryMessage}>
                (임시 표시: {remainingTime}초 후 복구)
              </span>
            )}
            {(function(){
              // Prefer timestamp of current displayed event when available
              const t = recentEarthquakes && recentEarthquakes.length > 0 ? recentEarthquakes.find(eq => eq.location === location)?.time : undefined;
              const base = t || (recentEarthquakes[0]?.time);
              return base ? `${new Date(base).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })} ${new Date(base).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'N/A';
            })()}
          </div>
          <div className={styles.location}>{location}</div>

          <div className={styles.mainDetails}>
            {(() => {
              const hasRoman = !!intensityText && intensityText.trim().length > 0;
              const roman = hasRoman ? normalizeRoman(intensityText as string) : '';
              const romanCls = hasRoman ? getRomanClassName(roman) : '';
              const boxClass = hasRoman
                ? `${styles.intensity} ${romanCls}`
                : `${styles.intensity} ${intensity < 0 ? styles.noInfoBox : getIntensityClassName(intensity)}`;
              const valueClass = hasRoman ? styles.intensityValue : `${styles.intensityValue} ${intensity < 0 ? styles.noInfoText : ''}`;
              const value = hasRoman ? roman : (intensity < 0 ? '情報なし' : convertIntensityToString(intensity));
              return (
                <div className={boxClass}>
                  <div className={styles.intensityTitle}>最大震度</div>
                  <div className={valueClass}>{value}</div>
                </div>
              );
            })()}
            <div className={`${styles.magnitude} ${magnitude < 0 ? styles.noInfoBox : getMagnitudeClassName(magnitude)}`}>
              <div className={styles.magnitudeTitle}>規模</div>
              <div className={magnitude < 0 ? styles.noInfoText : ''}>{magnitude < 0 ? '情報なし' : `M ${magnitude.toFixed(1)}`}</div>
            </div>
            <div className={`${styles.depth} ${depth < 0 ? styles.noInfoBox : getDepthClassName(depth)}`}>
              <div className={styles.depthTitle}>深さ</div>
              <div className={`${styles.depthValue} ${depth < 0 ? styles.noInfoText : ''}`}>{depth < 0 ? '情報なし' : `${depth}km`}</div>
            </div>
          </div>

          {(() => {
            // Show tsunami ribbon only when current displayed data is JMA
            const isJapan = !intensityText && intensity >= 0; // heuristic: JMA entries use numeric intensity; KMA uses intensityText
            if (!isJapan) return null;
            return (
              <div className={`${styles.tsunamiInfo} ${getTsunamiInfo().className}`}>
                {getTsunamiInfo().text}
              </div>
            );
          })()}
          {freeFormComment && (
            <div className={styles.freeFormComment}>
              <strong>特異事項および伝達事項</strong>
              <p>{freeFormComment}</p>
            </div>
          )}
        </div>
      ))}

      {eewData && (
        <div className={styles.simplifiedEarthquakeInfo}> {/* New style for simplified info */} 
          <h4>現在の地震情報 (簡略)</h4>
          <p>震源: {location}</p>
          <p>規模: M{magnitude.toFixed(1)}</p>
          <p>最大震度: <span className={getIntensityClassName(intensity)}>{convertIntensityToString(intensity)}</span></p>
        </div>
      )}

      {!isSettingsOpen && (
      <div className={styles.recentEarthquakesSection}>
        <h3 className={styles.recentEarthquakesTitle}>
          <Activity size={20} /> {/* Recent Earthquakes Icon */}
          最近の地震
        </h3>
        <div className={styles.earthquakeList}>
          {recentEarthquakes.map((eq, index) => (
            <div key={index} className={styles.earthquakeItem} onClick={() => onEarthquakeClick(eq)}>
              <div className={styles.itemLeft}>
                <div className={styles.itemLocation}>{eq.location}</div>
                <div className={styles.itemDetails}>
                  {new Date(eq.time).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })} {new Date(eq.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}・M{eq.magnitude.toFixed(1)}・{eq.depth}km
                </div>
              </div>
              {(() => {
                if (eq.intensityText) {
                  const raw = normalizeRoman(eq.intensityText);
                  const cls = getRomanClassName(raw);
                  return (
                    <div className={`${styles.itemRight} ${cls}`}>{raw}</div>
                  );
                }
                return (
                  <div className={`${styles.itemRight} ${getIntensityClassName(eq.intensity)}`}>{convertIntensityToString(eq.intensity, true)}</div>
                );
              })()}
            </div>
          ))}
        </div>
      </div>
      )}

      {isSettingsOpen && (
        <div />
      )}
      {/* Floating settings fab at bottom-right */}
      <button
        className={styles.settingsFab}
        aria-label="Settings"
        onClick={() => setIsSettingsOpen(prev => !prev)}
        title="설정"
      >
        <Settings size={16} />
      </button>
    </aside>
  );
};

export default Sidebar;
