# BloodNear Connect

**A location-aware community blood request and donor matching platform.**

BloodNear Connect is the full-stack evolution of the original BloodNear hospital-inventory prototype. Instead of pretending to know live hospital blood stock, the new platform structures the real-world workflow people already use: publish a blood request, discover exact-group needs nearby, respond as a donor, accept a response, coordinate privately, and close the request.


## Main features

- Full user registration, login, logout, and persistent signed sessions
- Password hashing with Node.js `crypto.scrypt`
- SQLite persistence with automatic schema creation and demo seeding
- Structured blood-request posting
- Request lifecycle: `OPEN -> MATCHED -> FULFILLED`, plus `CANCELLED` and automatic `EXPIRED`
- Exact registered blood-group matching for donor responses
- Browser geolocation and demo-area location fallback
- Haversine straight-line distance calculation
- Location/radius/urgency/blood-group filtering
- Explainable discovery score based on distance, freshness, and urgency
- Interactive Leaflet + OpenStreetMap request map
- Temporary donor availability publishing
- Nearby donor discovery
- `I can donate` response workflow
- Requester accept/decline workflow
- Contact details remain private until a response is accepted
- Real-time Server-Sent Event (SSE) notifications
- In-app notification center
- Requester dashboard with own request history
- Suggested exact-group donors for request owners
- Reporting and moderation workflow
- Admin overview, reports, user suspension/activation
- Search history storage for future analytics
- Responsive desktop/mobile UI
- Legacy static project retained in `legacy/`

## Medical and privacy boundary

BloodNear Connect is a **coordination platform, not a medical service**.

The application does not determine:

- donor medical eligibility
- blood transfusion compatibility
- crossmatch suitability
- diagnosis or treatment
- whether a donation/transfusion should proceed

The prototype only permits exact registered blood-group responses and explicitly leaves final screening and transfusion decisions to qualified healthcare professionals.

Public donor discovery intentionally does not expose email or phone. Contact information is returned only after the requester accepts that donor's response.

## Tech stack

The project intentionally has **zero npm package dependencies** so it can run directly after extraction.

- Frontend: HTML5, modern CSS, vanilla JavaScript SPA-style interaction
- Backend: Node.js 22 native HTTP server
- Database: Node.js built-in SQLite (`node:sqlite`)
- Authentication: signed HttpOnly cookie session + HMAC-SHA256
- Password storage: `crypto.scrypt`
- Real-time events: Server-Sent Events (SSE)
- Maps: Leaflet 1.9.4 + OpenStreetMap tiles
- Geolocation: Browser Geolocation API

> Node.js 22.5+ is required because the project uses the built-in `node:sqlite` module.

## Run locally

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

For development with automatic server restart:

```bash
npm run dev
```

No `npm install` is required because there are no external server dependencies.

## Demo accounts

### Standard user

```text
Email: nabila@example.com
Password: Demo123!
Blood group: B+
```

Other seeded users:

```text
arif@example.com   / Demo123!  / O-
sadia@example.com  / Demo123!  / A+
tanvir@example.com / Demo123!  / AB-
```

### Admin

```text
Email: admin@bloodnear.local
Password: Admin123!
```

Change/remove demo credentials before any public deployment.

## Production environment

Set a strong session secret:

Linux/macOS:

```bash
SESSION_SECRET="replace-with-a-long-random-secret" NODE_ENV=production npm start
```

PowerShell:

```powershell
$env:SESSION_SECRET="replace-with-a-long-random-secret"
$env:NODE_ENV="production"
npm start
```

The production flag adds the `Secure` attribute to the session cookie, so production should be served through HTTPS.

## Project structure

```text
bloodnear-project/
├── api/
│   └── index.js              # Vercel Serverless Function entrypoint
├── vercel.json               # Vercel deployment configuration
├── server.js                 # Native Node HTTP server + API routes
├── package.json
├── README.md
├── public/
│   ├── index.html            # New BloodNear Connect UI
│   ├── styles.css
│   └── app.js
├── src/
│   ├── auth.js               # scrypt + signed session cookie
│   ├── db.js                 # SQLite schema, seed, notifications
│   └── utils.js              # distance, scoring, helpers
├── scripts/
│   ├── reset-db.js
│   └── smoke-test.js
├── docs/
│   ├── ROADMAP.md
│   └── API.md
├── data/                     # Local runtime SQLite database lives here
└── legacy/                   # Original uploaded static website
```

## Vercel Deployment

BloodNear Connect is configured for 1-click zero-configuration deployment to [Vercel](https://vercel.com):

1. **Import the repository** into Vercel from GitHub (`TanzimaSiddika004/bloodnear`).
2. Leave Framework Preset as **Other** (default).
3. Ensure the Node.js version is **22.x** in project settings (handled automatically via `engines` in `package.json`).
4. (Optional) In **Environment Variables**, set:
   - `SESSION_SECRET`: a long random string for production session signing.
5. Click **Deploy**.

The preconfigured `vercel.json` routes static requests (`/`, `/styles.css`, `/app.js`) from `public/` and serverless API endpoints through `api/index.js`. On serverless environments, SQLite data is stored in `/tmp/bloodnear.sqlite` and automatically seeded on container boot.

## Database entities

- `users`
- `blood_requests`
- `donor_availability`
- `responses`
- `notifications`
- `reports`
- `search_history`

## Reset demo database

Stop the server first, then run:

```bash
npm run reset-db
npm start
```

The server will recreate the schema and seed clean demo data.

## Test

```bash
npm test
```

The smoke test starts an isolated server/database, validates the health endpoint, authentication, request creation, donor response, response acceptance, private-contact unlock, and admin access, then removes its temporary database.

## Deployment notes

This build is ideal for a university demonstration and a single Node server. For a public multi-instance deployment, the next infrastructure migration should be:

1. PostgreSQL + PostGIS (or another production geospatial DB)
2. Redis/pub-sub or a managed real-time channel for cross-instance events
3. Email/OTP/phone verification provider
4. Managed object storage if profile photos/documents are introduced
5. Centralized audit/error monitoring
6. Formal privacy/security review and healthcare stakeholder review

See `docs/ROADMAP.md` for the development roadmap and `docs/API.md` for the implemented API surface.
