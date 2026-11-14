import { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection } from 'geojson';
import {
  layoutSegment, alignToLongestEdge, DEFAULT_MODULE,
  type Segment, type Keepout, type ModuleSpec, type LngLat, type LayoutResult,
} from './layout';

type Mode = 'select' | 'segment' | 'keepout';
type Selected = { kind: 'segment' | 'keepout'; id: string } | null;
interface Project { module: ModuleSpec; segments: Segment[]; keepouts: Keepout[] }

// MapLibre's background worker is copied into public/ at build time (see package.json scripts)
maplibregl.setWorkerUrl(new URL('maplibre-gl-worker.mjs', document.baseURI).href);

const STORAGE_KEY = 'solar-design-app/project-v1';
const START: LngLat = [58.478, 23.611]; // Qurum, Muscat

const uid = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8);

function loadProject(): Project {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { module: DEFAULT_MODULE, segments: [], keepouts: [] };
}

const fc = (features: FeatureCollection['features']): FeatureCollection => ({ type: 'FeatureCollection', features });
const ringFeature = (ring: LngLat[], props: Record<string, unknown>) => ({
  type: 'Feature' as const, properties: props,
  geometry: { type: 'Polygon' as const, coordinates: [[...ring, ring[0]]] },
});

export default function App() {
  const [project, setProject] = useState<Project>(loadProject);
  const [mode, setMode] = useState<Mode>('select');
  const [draft, setDraft] = useState<LngLat[]>([]);
  const [cursor, setCursor] = useState<LngLat | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ name: string; lon: number; lat: number }[]>([]);
  const [searchMsg, setSearchMsg] = useState('');
  const [mapReady, setMapReady] = useState(false);

  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const modeRef = useRef(mode);
  const draftRef = useRef(draft);
  modeRef.current = mode;
  draftRef.current = draft;

  const { module, segments, keepouts } = project;

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(project)); } catch { /* ignore */ }
  }, [project]);

  const layouts = useMemo(() => {
    const out: Record<string, LayoutResult> = {};
    for (const s of segments) out[s.id] = layoutSegment(s, keepouts, module);
    return out;
  }, [segments, keepouts, module]);

  const totals = useMemo(() => {
    let count = 0, kwp = 0, area = 0;
    for (const s of segments) { const r = layouts[s.id]; count += r.count; kwp += r.kwp; area += r.roofAreaM2; }
    return { count, kwp, area };
  }, [segments, layouts]);

  // ---------- drawing ----------
  const finishDraft = (pts = draftRef.current) => {
    const clean = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-7);
    if (clean.length < 3) return;
    const m = modeRef.current;
    if (m === 'segment') {
      const n = project.segments.length + 1;
      const seg: Segment = {
        id: uid(), name: `Area ${n}`, ring: clean, mount: 'tilted', tilt: 10, azimuth: 180,
        orientation: 'portrait', setback: 1, rowSpacing: 'auto', rowGap: 1, moduleGap: 0.02,
      };
      setProject((p) => ({ ...p, segments: [...p.segments, seg] }));
      setSelected({ kind: 'segment', id: seg.id });
    } else if (m === 'keepout') {
      const n = project.keepouts.length + 1;
      const ko: Keepout = { id: uid(), name: `Keepout ${n}`, ring: clean, setback: 0.5, height: 1 };
      setProject((p) => ({ ...p, keepouts: [...p.keepouts, ko] }));
      setSelected({ kind: 'keepout', id: ko.id });
    }
    setDraft([]); setCursor(null); setMode('select');
  };
  const finishRef = useRef(finishDraft);
  finishRef.current = finishDraft;

  const cancelDraft = () => { setDraft([]); setCursor(null); setMode('select'); };

  const startDraw = (m: Mode) => { setDraft([]); setCursor(null); setSelected(null); setMode(m); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDraft();
      if (e.key === 'Enter' && modeRef.current !== 'select') finishRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- map setup ----------
  useEffect(() => {
    if (!mapDiv.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapDiv.current,
      center: START, zoom: 18, maxZoom: 21,
      style: {
        version: 8,
        sources: {
          sat: {
            type: 'raster', tileSize: 256, maxzoom: 19,
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
          },
        },
        layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
      },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    mapRef.current = map;

    map.on('load', () => {
      for (const id of ['segments', 'keepouts', 'panels', 'draft', 'draft-pts']) map.addSource(id, { type: 'geojson', data: fc([]) });
      map.addLayer({ id: 'segments-fill', type: 'fill', source: 'segments', paint: { 'fill-color': '#f5b700', 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'panels-fill', type: 'fill', source: 'panels', paint: { 'fill-color': '#16307a', 'fill-opacity': 0.9 } });
      map.addLayer({ id: 'panels-line', type: 'line', source: 'panels', paint: { 'line-color': '#9cc3ff', 'line-width': 0.6 } });
      map.addLayer({
        id: 'segments-line', type: 'line', source: 'segments',
        paint: { 'line-color': '#f5b700', 'line-width': ['case', ['get', 'selected'], 4, 2] },
      });
      map.addLayer({ id: 'keepouts-fill', type: 'fill', source: 'keepouts', paint: { 'fill-color': '#ff4d4f', 'fill-opacity': 0.4 } });
      map.addLayer({
        id: 'keepouts-line', type: 'line', source: 'keepouts',
        paint: { 'line-color': '#ff4d4f', 'line-width': ['case', ['get', 'selected'], 3.5, 1.5] },
      });
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1] } });
      map.addLayer({
        id: 'draft-pts', type: 'circle', source: 'draft-pts',
        paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': '#111', 'circle-stroke-width': 1.5 },
      });
      setMapReady(true);
    });

    map.on('click', (e: MapMouseEvent) => {
      const m = modeRef.current;
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (m !== 'select') {
        const d = draftRef.current;
        if (d.length >= 3) {
          const first = map.project(d[0] as [number, number]);
          if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 12) { finishRef.current(); return; }
        }
        setDraft([...d, p]);
        return;
      }
      const hits = map.queryRenderedFeatures(e.point, { layers: ['keepouts-fill', 'segments-fill', 'panels-fill'] });
      const ko = hits.find((h) => h.layer.id === 'keepouts-fill');
      const seg = hits.find((h) => h.layer.id !== 'keepouts-fill');
      if (ko) setSelected({ kind: 'keepout', id: String(ko.properties.id) });
      else if (seg) setSelected({ kind: 'segment', id: String(seg.properties.id) });
      else setSelected(null);
    });
    map.on('dblclick', (e) => {
      if (modeRef.current !== 'select') { e.preventDefault(); finishRef.current(); }
    });
    map.on('mousemove', (e) => {
      if (modeRef.current !== 'select') setCursor([e.lngLat.lng, e.lngLat.lat]);
    });
  }, []);

  // ---------- push data to map ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const isSel = (kind: string, id: string) => selected?.kind === kind && selected.id === id;
    (map.getSource('segments') as GeoJSONSource).setData(
      fc(segments.map((s) => ringFeature(s.ring, { id: s.id, selected: isSel('segment', s.id) }))),
    );
    (map.getSource('keepouts') as GeoJSONSource).setData(
      fc(keepouts.map((k) => ringFeature(k.ring, { id: k.id, selected: isSel('keepout', k.id) }))),
    );
    (map.getSource('panels') as GeoJSONSource).setData(
      fc(segments.flatMap((s) => layouts[s.id].panels.map((p) => ringFeature(p, { id: s.id })))),
    );
  }, [segments, keepouts, layouts, selected, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const line = cursor && draft.length ? [...draft, cursor] : draft;
    (map.getSource('draft') as GeoJSONSource).setData(
      fc(line.length >= 2 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } }] : []),
    );
    (map.getSource('draft-pts') as GeoJSONSource).setData(
      fc(draft.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }))),
    );
    map.doubleClickZoom[mode === 'select' ? 'enable' : 'disable']();
    map.getCanvas().style.cursor = mode === 'select' ? '' : 'crosshair';
  }, [draft, cursor, mode, mapReady]);

  // ---------- search ----------
  const search = async () => {
    const q = query.trim();
    if (!q) return;
    const coords = q.match(/^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/);
    if (coords) {
      mapRef.current?.flyTo({ center: [Number(coords[3]), Number(coords[1])], zoom: 19 });
      setResults([]); setSearchMsg('');
      return;
    }
    setSearchMsg('Searching…');
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`);
      const data: { display_name: string; lon: string; lat: string }[] = await res.json();
      setResults(data.map((d) => ({ name: d.display_name, lon: Number(d.lon), lat: Number(d.lat) })));
      setSearchMsg(data.length ? '' : 'No places found. Try a nearby landmark or paste coordinates (lat, lon).');
    } catch {
      setSearchMsg('Search is unavailable right now. Paste coordinates instead, e.g. 23.611, 58.478');
    }
  };

  // ---------- editing ----------
  const updateSeg = (id: string, patch: Partial<Segment>) =>
    setProject((p) => ({ ...p, segments: p.segments.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const updateKo = (id: string, patch: Partial<Keepout>) =>
    setProject((p) => ({ ...p, keepouts: p.keepouts.map((k) => (k.id === id ? { ...k, ...patch } : k)) }));
  const remove = (sel: NonNullable<Selected>) => {
    setProject((p) => sel.kind === 'segment'
      ? { ...p, segments: p.segments.filter((s) => s.id !== sel.id) }
      : { ...p, keepouts: p.keepouts.filter((k) => k.id !== sel.id) });
    setSelected(null);
  };
  const [confirmClear, setConfirmClear] = useState(false);

  const selSeg = selected?.kind === 'segment' ? segments.find((s) => s.id === selected.id) : undefined;
  const selKo = selected?.kind === 'keepout' ? keepouts.find((k) => k.id === selected.id) : undefined;
  const zoomTo = (ring: LngLat[]) => {
    const b = new maplibregl.LngLatBounds();
    ring.forEach((p) => b.extend(p as [number, number]));
    mapRef.current?.fitBounds(b, { padding: 80, maxZoom: 20 });
  };

  return (
    <div className="app">
      <aside className="side">
        <header>
          <h1>Solar Design App</h1>
          <span className="tag">Milestone 1 preview</span>
        </header>

        <section className="totals">
          <div><b>{totals.count.toLocaleString()}</b><span>modules</span></div>
          <div><b>{totals.kwp.toLocaleString(undefined, { maximumFractionDigits: 1 })}</b><span>kWp</span></div>
          <div><b>{Math.round(totals.area).toLocaleString()}</b><span>m² drawn</span></div>
        </section>

        <section>
          <h2>1 · Find the site</h2>
          <div className="row">
            <input value={query} placeholder="Address, place or lat, lon" onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()} />
            <button onClick={search}>Search</button>
          </div>
          {searchMsg && <p className="hint">{searchMsg}</p>}
          {results.map((r) => (
            <button key={`${r.lat},${r.lon}`} className="result" onClick={() => { mapRef.current?.flyTo({ center: [r.lon, r.lat], zoom: 19 }); setResults([]); }}>
              {r.name}
            </button>
          ))}
        </section>

        <section>
          <h2>2 · Draw</h2>
          {mode === 'select' ? (
            <div className="row">
              <button className="primary" onClick={() => startDraw('segment')}>+ Roof / ground area</button>
              <button className="danger-outline" onClick={() => startDraw('keepout')}>+ Keepout</button>
            </div>
          ) : (
            <div className="drawing">
              <p><b>Drawing {mode === 'segment' ? 'a roof / ground area' : 'a keepout'}.</b> Click each corner on the map.
                Click the first point, double-click or press Enter to finish. Esc cancels.</p>
              <div className="row">
                <button className="primary" disabled={draft.length < 3} onClick={() => finishDraft()}>Finish ({draft.length} pts)</button>
                <button onClick={cancelDraft}>Cancel</button>
              </div>
            </div>
          )}
        </section>

        {selSeg && (
          <section className="editor">
            <h2>Area settings</h2>
            <label>Name<input value={selSeg.name} onChange={(e) => updateSeg(selSeg.id, { name: e.target.value })} /></label>
            <label>Mounting
              <select value={selSeg.mount} onChange={(e) => {
                const mount = e.target.value as Segment['mount'];
                updateSeg(selSeg.id, mount === 'flush' ? { mount, tilt: 0, setback: 0.5 } : { mount, tilt: 10 });
              }}>
                <option value="tilted">Tilted racks (flat roof / ground)</option>
                <option value="flush">Flush on sloped roof</option>
              </select>
            </label>
            <div className="grid2">
              <Num label={selSeg.mount === 'flush' ? 'Roof pitch °' : 'Module tilt °'} value={selSeg.tilt} min={0} max={60} step={1} onChange={(v) => updateSeg(selSeg.id, { tilt: v })} />
              <Num label="Facing (azimuth °)" value={selSeg.azimuth} min={0} max={359} step={1} onChange={(v) => updateSeg(selSeg.id, { azimuth: v })} />
            </div>
            <button className="link" onClick={() => updateSeg(selSeg.id, { azimuth: alignToLongestEdge(selSeg.ring) })}>
              Align rows to the longest roof edge
            </button>
            <p className="hint">180° = facing south (best in Oman). 90° east, 270° west.</p>
            <label>Module orientation
              <select value={selSeg.orientation} onChange={(e) => updateSeg(selSeg.id, { orientation: e.target.value as Segment['orientation'] })}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
            <div className="grid2">
              <Num label="Edge setback (m)" value={selSeg.setback} min={0} max={10} step={0.1} onChange={(v) => updateSeg(selSeg.id, { setback: v })} />
              <Num label="Gap between modules (m)" value={selSeg.moduleGap} min={0} max={1} step={0.01} onChange={(v) => updateSeg(selSeg.id, { moduleGap: v })} />
            </div>
            <label>Row spacing
              <select value={selSeg.rowSpacing} onChange={(e) => updateSeg(selSeg.id, { rowSpacing: e.target.value as Segment['rowSpacing'] })}>
                <option value="auto">Auto (no shading 9:00–15:00 on 21 Dec)</option>
                <option value="manual">Manual gap</option>
              </select>
            </label>
            {selSeg.rowSpacing === 'manual' && (
              <Num label="Clear gap between rows (m)" value={selSeg.rowGap} min={0} max={10} step={0.05} onChange={(v) => updateSeg(selSeg.id, { rowGap: v })} />
            )}
            <div className="stats">
              <span><b>{layouts[selSeg.id].count}</b> modules</span>
              <span><b>{layouts[selSeg.id].kwp.toFixed(2)}</b> kWp</span>
              <span>Row gap <b>{layouts[selSeg.id].rowGap.toFixed(2)} m</b></span>
              <span>Area <b>{Math.round(layouts[selSeg.id].roofAreaM2)} m²</b></span>
            </div>
            <div className="row">
              <button onClick={() => zoomTo(selSeg.ring)}>Zoom to</button>
              <button className="danger" onClick={() => remove(selected!)}>Delete area</button>
            </div>
          </section>
        )}

        {selKo && (
          <section className="editor">
            <h2>Keepout settings</h2>
            <label>Name<input value={selKo.name} onChange={(e) => updateKo(selKo.id, { name: e.target.value })} /></label>
            <div className="grid2">
              <Num label="Clearance (m)" value={selKo.setback} min={0} max={10} step={0.1} onChange={(v) => updateKo(selKo.id, { setback: v })} />
              <Num label="Height (m)" value={selKo.height} min={0} max={50} step={0.1} onChange={(v) => updateKo(selKo.id, { height: v })} />
            </div>
            <p className="hint">Height will be used for shading in Milestone 3.</p>
            <div className="row">
              <button onClick={() => zoomTo(selKo.ring)}>Zoom to</button>
              <button className="danger" onClick={() => remove(selected!)}>Delete keepout</button>
            </div>
          </section>
        )}

        <section>
          <h2>3 · Module</h2>
          <label>Model<input value={module.name} onChange={(e) => setProject((p) => ({ ...p, module: { ...p.module, name: e.target.value } }))} /></label>
          <div className="grid3">
            <Num label="Power (Wp)" value={module.watts} min={100} max={800} step={5} onChange={(v) => setProject((p) => ({ ...p, module: { ...p.module, watts: v } }))} />
            <Num label="Length (m)" value={module.length} min={0.5} max={3} step={0.001} onChange={(v) => setProject((p) => ({ ...p, module: { ...p.module, length: v } }))} />
            <Num label="Width (m)" value={module.width} min={0.5} max={2} step={0.001} onChange={(v) => setProject((p) => ({ ...p, module: { ...p.module, width: v } }))} />
          </div>
        </section>

        <section>
          <h2>Design items</h2>
          {segments.length === 0 && keepouts.length === 0 && <p className="hint">Nothing drawn yet. Find your site, then draw a roof area.</p>}
          {segments.map((s) => (
            <button key={s.id} className={`item ${selected?.id === s.id ? 'on' : ''}`} onClick={() => { setSelected({ kind: 'segment', id: s.id }); zoomTo(s.ring); }}>
              <span className="dot yellow" />{s.name}<em>{layouts[s.id].count} mod · {layouts[s.id].kwp.toFixed(1)} kWp</em>
            </button>
          ))}
          {keepouts.map((k) => (
            <button key={k.id} className={`item ${selected?.id === k.id ? 'on' : ''}`} onClick={() => { setSelected({ kind: 'keepout', id: k.id }); zoomTo(k.ring); }}>
              <span className="dot red" />{k.name}<em>{k.setback} m clearance</em>
            </button>
          ))}
          {(segments.length > 0 || keepouts.length > 0) && (
            confirmClear ? (
              <div className="row">
                <button className="danger" onClick={() => { setProject((p) => ({ ...p, segments: [], keepouts: [] })); setSelected(null); setConfirmClear(false); }}>Yes, clear all</button>
                <button onClick={() => setConfirmClear(false)}>Keep</button>
              </div>
            ) : <button className="link" onClick={() => setConfirmClear(true)}>Clear design…</button>
          )}
        </section>

        <footer>Your design is saved in this browser. Imagery © Esri; search © OpenStreetMap.</footer>
      </aside>
      <div className="map" ref={mapDiv} />
    </div>
  );
}

function Num(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  return (
    <label>{props.label}
      <input type="number" value={text} min={props.min} max={props.max} step={props.step}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(v)) props.onChange(Math.max(props.min, Math.min(props.max, v)));
        }} />
    </label>
  );
}
