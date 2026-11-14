# Solar Design App

A web app for designing solar PV systems from satellite imagery, similar in workflow to HelioScope but built from scratch with open-source tools. No code or assets are copied from HelioScope, Aurora, PVsyst or similar products.

- Phase 1 users: EPC contractors designing rooftop and ground-mount systems.
- Phase 2 users: developers running financial analysis and PPA offers on finished designs.
- Market: Oman and the GCC first. Default location is Muscat; metric units, kWp/kWh, OMR as the default currency (USD supported).

## Working with the owner
The owner is a solar professional (~14 years) with NO coding experience.
- Explain each step briefly in plain language. Prefer short bullet lists, screenshots and visual previews over long text.
- After each feature, give a preview link and say exactly what to test.
- Before adding a paid service or anything that needs an API key, stop and explain the cost and how to get the key.
- If something you need is missing (access, a key, a service), say exactly what and stop. Don't mock or guess.
- One branch and pull request per feature.

## Design workflow
1. Site + satellite imagery: search an address, see the roof.
2. Field segments: draw roof or ground areas with tilt, azimuth, height.
3. Keepouts + setbacks: AC units, vents, parapets, trees, each with a height.
4. Auto panel layout: fill each area with modules (portrait/landscape, row spacing from tilt, alignment).
5. Shading: 3D sun-path shading loss per module.
6. Electrical: module/inverter library, string sizing with temperature-corrected voltage checks, wiring zones.
7. Energy simulation: yearly/monthly kWh and loss breakdown.
8. Report: PDF with layout, BOM, single-line diagram, yield.
Phase 2: financial model and PPA pricing using step 7 output.

## Stack
- Frontend: React + TypeScript (Vite), MapLibre GL JS, Terra Draw, Turf.js, Three.js
- Backend: Python FastAPI + pvlib
- Database: Postgres + PostGIS
- Data: PVGIS weather (covers Oman), CEC module/inverter libraries

## Build order
- Milestone 1 (MVP): steps 1–4 in the browser; show module count and total kWp. (Built in `web/`.)
- Milestone 1b — drawing import: upload a villa roof drawing (DXF; PDF vector drawings; DWG via conversion to DXF), set its scale (two points + known distance), place and rotate it on the satellite map / set true north, pick the terrace outlines as field segments, then auto-layout panels using each roof's azimuth.
- Milestone 1c — 3D sun & shadow view: basic 3D model (Three.js) of roof, parapets, keepouts with heights and panels; sun path for any date/time using an accurate solar position algorithm (NREL SPA) at the site's real coordinates; animated shadows across the day and year; per-module shading %.
- Milestone 2: steps 6–7 (backend + pvlib).
- Milestone 3: step 8 (reports), and feed 1c shading into the energy simulation.
- Milestone 4: phase 2 financials/PPA.

## Code layout
- `web/` — React + Vite front end. `npm run dev`, `npm test`, `npm run build`.
- `web/src/layout.ts` — auto panel layout engine (pure functions, unit-tested in `layout.test.ts`).
- Drawing tools are a small custom click-to-draw in `App.tsx` (Terra Draw may replace it when vertex editing is needed).
- Preview site: the built `web/dist` is published to the `gh-pages` branch (GitHub Pages).
