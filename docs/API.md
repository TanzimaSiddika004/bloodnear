# BloodNear Connect API

All endpoints are same-origin under `/api`. Authenticated endpoints use the signed `bn_session` HttpOnly cookie.

## System

- `GET /api/health`
- `GET /api/stats`
- `GET /api/events` — authenticated SSE stream

## Authentication

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

## Blood requests

- `GET /api/requests`
  - query: `bloodGroup`, `lat`, `lng`, `radius`, `urgency`, `status`, `mine`, `limit`
- `POST /api/requests`
- `GET /api/requests/:id`
- `PATCH /api/requests/:id`
- `POST /api/requests/:id/respond`
- `GET /api/requests/:id/responses` — owner/admin
- `GET /api/requests/:id/matches` — owner/admin suggested active donors

## Responses

- `PATCH /api/responses/:id`
  - requester: `ACCEPTED` or `DECLINED`
  - donor: `CANCELLED`

## Donor availability

- `GET /api/donors`
  - query: `bloodGroup`, `lat`, `lng`, `radius`
- `PUT /api/donor-availability`
- `DELETE /api/donor-availability`

## Notifications

- `GET /api/notifications`
- `POST /api/notifications/:id/read`
- `POST /api/notifications/read-all`

## Reports

- `POST /api/reports`

## Admin

- `GET /api/admin/overview`
- `GET /api/admin/users`
- `PATCH /api/admin/users/:id/status`
- `GET /api/admin/reports`
- `PATCH /api/admin/reports/:id`

## Safety behavior enforced by backend

- A user cannot respond to their own request.
- A donor response is accepted only when the user's registered blood group exactly equals the requested group.
- Exact-group matching is not a medical eligibility assertion.
- Closed/expired requests cannot accept new responses.
- Private email/phone is not included in normal request or donor discovery output.
- Accepted response participants can retrieve each other's stored contact details through the request detail endpoint.
