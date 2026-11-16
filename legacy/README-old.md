# BloodNear — Location-Aware Blood Availability Recommendation Prototype

A professional single-page university project prototype for testing a blood availability recommendation workflow in Cumilla, Bangladesh.

## Important disclaimer

All center names, contact values, blood inventory, freshness values, and reliability values in this project are **synthetic/dummy data**. The app does **not** provide real-time medical availability and must not be used for clinical decisions.

## Folder structure

```text
bloodnear-project/
├── index.html
├── README.md
└── assets/
    ├── css/
    │   └── styles.css
    ├── data/
    │   └── hospitals.js
    └── js/
        └── app.js
```

## Features

- Professional landing page + scroll-to-use finder
- 12 fictional Cumilla-area medical/blood centers
- All 8 major ABO/Rh blood groups
- Required quantity filtering
- Browser Geolocation API
- Manual Cumilla demo location selector
- Search-radius selection
- Haversine straight-line distance calculation
- Explainable multi-factor recommendation score
- Emergency-priority weighting mode
- Top result + alternative center ranking
- Leaflet + OpenStreetMap interactive map
- Search result map markers
- Demo inventory table with group filter
- Inventory freshness and reliability concepts
- Responsive mobile/desktop UI

## Recommendation logic

Centers are first filtered by:

1. Center is marked open
2. Requested blood group stock is at least the requested quantity
3. Center falls within the selected radius

Eligible centers are then ranked by a weighted score using:

- Distance
- Available stock relative to required quantity
- Simulated inventory freshness
- Demo reliability score

Emergency mode increases the importance of distance and sufficient stock.

> This is a deterministic recommendation engine. It is not presented as an ML model or medical AI.

## Run the project

### Easiest option

Open `index.html` in a modern browser.

For browser geolocation, some browsers require HTTPS or localhost. If location permission does not work when opening the file directly, use the manual Cumilla demo-area selector.

### Recommended local server

If Python is installed:

```bash
python -m http.server 5500
```

Then open:

```text
http://localhost:5500
```

If Node.js is installed, you can also use any static server (for example VS Code Live Server).

## Internet dependency

The core filtering/ranking logic works locally. The interactive map and map tiles use Leaflet/OpenStreetMap CDN resources and therefore require internet access. The website shows a fallback message if Leaflet cannot load.

## Future real-world implementation

A production version could add:

- Verified provider/hospital accounts
- Secure real-time inventory APIs
- Audit logs and data freshness enforcement
- Actual road distance and ETA using routing services
- Blood request/reservation workflow
- Provider notifications
- Demand/shortage analytics
- Role-based admin/provider dashboards

Medical compatibility and transfusion decisions must remain under qualified healthcare professionals.
