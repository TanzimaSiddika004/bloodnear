# BloodNear Connect — Product & Engineering Roadmap

## Current delivered version: V2 Full-stack MVP

The hospital-inventory concept has been replaced by a community request/donor coordination model while preserving the strongest reusable ideas from the old project: location detection, distance calculation, search radius, mapping, transparent ranking, and responsive presentation.

### Phase 0 — Migration from old prototype — DONE

- Preserve old website under `legacy/`
- Remove hospital inventory as the live product core
- Replace center recommendation with community request discovery
- Retain location, Haversine distance, and map concepts

### Phase 1 — Identity & authentication — DONE

- Registration/login/logout
- scrypt password hashing
- signed HttpOnly sessions
- profile blood group and general area
- account status and admin role

### Phase 2 — Blood request lifecycle — DONE

- Create structured request
- blood group / units / hospital / area / urgency / needed time / description
- edit-capable backend
- fulfil/cancel
- automatic expiry

### Phase 3 — Location-aware discovery — DONE

- browser geolocation
- manual demo areas
- radius search
- exact blood group filtering
- urgency filtering
- freshness + urgency + distance discovery ranking
- Leaflet map

### Phase 4 — Donor network — DONE

- temporary donor availability
- exact registered blood-group constraint
- nearby donor listing
- suggested donors for request owner

### Phase 5 — Structured connection workflow — DONE

- `I can donate`
- interested/accepted/declined/cancelled/completed states
- requester controls acceptance
- private contact unlock after acceptance

### Phase 6 — Real-time experience — DONE

- persisted notifications
- Server-Sent Event push channel
- matching request notification to active nearby donors
- response/accept/cancel/fulfilled notifications

### Phase 7 — Trust, safety & moderation — DONE (MVP)

- no clinical compatibility engine
- exact-group-only donor response rule
- report request/user data model and request-report UI
- admin report review
- user suspension/activation
- request expiry
- private contact model

### Phase 8 — Analytics foundation — DONE (data capture)

- search history
- request/donor/fulfilment counts
- blood-group demand aggregation
- admin overview

## Recommended next production phases

### Phase 9 — Strong identity verification

- verified email
- phone OTP
- optional organization/hospital verification
- abuse/rate-risk signals
- device/session management

### Phase 10 — Production geospatial data layer

Move SQLite to PostgreSQL + PostGIS:

- indexed radius queries
- efficient nearest-neighbor search
- area boundaries
- privacy-preserving coordinate precision
- scalable analytics

### Phase 11 — Communication upgrade

- in-platform direct messaging after an accepted response
- message audit/abuse controls
- optional call relay or contact masking
- attachment policy with strict privacy controls

### Phase 12 — Notification channels

- email notifications
- push notifications/PWA
- optional SMS for critical verified workflows
- notification preference controls

### Phase 13 — Trust scoring without medical inference

Trust signals may include:

- verified account
- account age
- successful closed coordination events
- report history
- response cancellation rate

Do **not** convert these signals into medical donor eligibility.

### Phase 14 — Advanced request integrity

- duplicate request detection
- suspicious-post heuristics
- rate limits per identity/device
- hospital/facility reference normalization
- admin audit log

### Phase 15 — AI assistance (controlled layer)

Only after the structured system is stable:

- Bangla/English/code-mixed request parsing
- natural-language search -> validated structured filters
- form prefill with explicit user confirmation
- duplicate/spam assistance
- grounded summaries of database results

AI must never invent donors, availability, compatibility, hospital confirmation, or medical suitability.

### Phase 16 — Research/analytics dashboard

- regional demand heatmaps
- request response-time distribution
- zero-response areas
- exact-group demand trends
- donor/request ratio
- fulfilment funnel

### Phase 17 — Production hardening

- PostgreSQL backups and migrations
- centralized logs and monitoring
- CSRF strategy if cross-origin clients are added
- formal penetration/security review
- data retention/deletion controls
- privacy policy and consent records
- accessibility audit
- automated unit/integration/e2e test suite
- CI/CD
