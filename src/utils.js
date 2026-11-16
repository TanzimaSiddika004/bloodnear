const crypto = require('node:crypto');

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

function uid(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function addHoursIso(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function toRad(v) {
  return (v * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLon = toRad(Number(lon2) - Number(lon1));
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2))) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function requestMatchScore(request, distanceKm) {
  const ageMinutes = Math.max(0, (Date.now() - new Date(request.created_at).getTime()) / 60000);
  const distanceScore = clamp(100 - distanceKm * 5.5, 0, 100);
  const freshnessScore = clamp(100 - ageMinutes * 0.12, 25, 100);
  const urgencyScore = request.urgency === 'EMERGENCY' ? 100 : 65;
  return Math.round(distanceScore * 0.55 + freshnessScore * 0.25 + urgencyScore * 0.20);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    bloodGroup: user.blood_group,
    area: user.area,
    isVerified: Boolean(user.is_verified),
    role: user.role,
    createdAt: user.created_at
  };
}

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

module.exports = {
  BLOOD_GROUPS,
  uid,
  nowIso,
  addHoursIso,
  haversineKm,
  requestMatchScore,
  publicUser,
  safeJsonParse,
  clamp
};
