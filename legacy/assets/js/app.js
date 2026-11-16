(() => {
  'use strict';

  const { hospitals, locations } = window.BLOODNEAR_DATA;
  const state = {
    selectedBlood: 'O+',
    userLocation: null,
    userLocationName: '',
    results: [],
    map: null,
    markersLayer: null,
    bestCenter: null
  };

  const $ = (id) => document.getElementById(id);
  const form = $('blood-search-form');
  const chips = [...document.querySelectorAll('.blood-chip')];

  // ------------------------------
  // Utility and recommendation logic
  // ------------------------------
  function toRad(value) { return value * Math.PI / 180; }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  function freshnessLabel(minutes) {
    if (minutes <= 15) return { text: 'Very fresh', className: 'freshness-good' };
    if (minutes <= 60) return { text: `${minutes} min ago`, className: 'freshness-mid' };
    return { text: `${Math.round(minutes / 60)} hr ago`, className: 'freshness-old' };
  }

  function calculateScore(center, distance, requestedQty, emergency) {
    // Normalized explainable factors, each 0..100.
    const distanceScore = clamp(100 - distance * 7.2, 0, 100);
    const stockRatio = center.stock / requestedQty;
    const stockScore = clamp(55 + Math.min(stockRatio - 1, 3) * 15, 0, 100);
    const freshnessScore = clamp(100 - center.freshnessMinutes * 0.45, 25, 100);
    const reliabilityScore = center.reliability;

    // Emergency mode puts extra weight on sufficient stock + proximity.
    const weights = emergency
      ? { distance: .43, stock: .37, freshness: .12, reliability: .08 }
      : { distance: .40, stock: .28, freshness: .20, reliability: .12 };

    return Math.round(
      distanceScore * weights.distance +
      stockScore * weights.stock +
      freshnessScore * weights.freshness +
      reliabilityScore * weights.reliability
    );
  }

  function recommend({ bloodGroup, quantity, radius, location, emergency }) {
    return hospitals
      .map(center => {
        const distance = haversineKm(location.lat, location.lng, center.lat, center.lng);
        const stock = center.inventory[bloodGroup] || 0;
        return { ...center, distance, stock };
      })
      .filter(center => center.open && center.stock >= quantity && center.distance <= radius)
      .map(center => ({ ...center, score: calculateScore(center, center.distance, quantity, emergency) }))
      .sort((a, b) => b.score - a.score || a.distance - b.distance || b.stock - a.stock);
  }

  // ------------------------------
  // Search form
  // ------------------------------
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.selectedBlood = chip.dataset.group;
      $('bloodGroup').value = state.selectedBlood;
    });
  });

  $('manual-location').addEventListener('change', (event) => {
    const key = event.target.value;
    if (!key) return;
    const loc = locations[key];
    state.userLocation = { lat: loc.lat, lng: loc.lng };
    state.userLocationName = loc.name;
    $('location-status').textContent = `Demo area selected: ${loc.name}`;
  });

  $('use-location-btn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('Geolocation is not supported in this browser.');
      return;
    }
    $('location-status').textContent = 'Detecting location…';
    navigator.geolocation.getCurrentPosition(
      pos => {
        state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        state.userLocationName = 'Current browser location';
        $('manual-location').value = '';
        $('location-status').textContent = `Location detected · accuracy ±${Math.round(pos.coords.accuracy)} m`;
        showToast('Current location detected.');
        renderMap();
      },
      () => {
        $('location-status').textContent = 'Permission denied — choose a demo area below';
        showToast('Could not access location. Use a demo Cumilla area.');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  });

  $('demo-search-btn').addEventListener('click', () => {
    selectBlood('O-');
    $('quantity').value = 2;
    $('radius').value = 5;
    $('manual-location').value = 'kandirpar';
    const loc = locations.kandirpar;
    state.userLocation = { lat: loc.lat, lng: loc.lng };
    state.userLocationName = loc.name;
    $('location-status').textContent = `Demo area selected: ${loc.name}`;
    runSearch();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch();
  });

  function selectBlood(group) {
    state.selectedBlood = group;
    $('bloodGroup').value = group;
    chips.forEach(c => c.classList.toggle('active', c.dataset.group === group));
  }

  function runSearch() {
    const quantity = Number($('quantity').value);
    const radius = Number($('radius').value);
    const emergency = $('emergencyMode').checked;

    if (!state.userLocation) {
      showToast('Please use your current location or select a Cumilla demo area.');
      $('manual-location').focus();
      return;
    }
    if (!quantity || quantity < 1) {
      showToast('Enter a valid required quantity.');
      return;
    }

    state.results = recommend({
      bloodGroup: state.selectedBlood,
      quantity,
      radius,
      location: state.userLocation,
      emergency
    });

    renderResults(quantity, radius);
    renderMap();
  }

  // ------------------------------
  // Results
  // ------------------------------
  function renderResults(quantity, radius) {
    $('results-placeholder').classList.add('hidden');
    $('results-content').classList.remove('hidden');

    if (!state.results.length) {
      state.bestCenter = null;
      $('results-content').innerHTML = `
        <div class="no-result">
          <span class="result-overline">NO ELIGIBLE MATCH</span>
          <h3>No open demo center can supply ${quantity} bag(s) of ${displayGroup(state.selectedBlood)} within ${radius} km.</h3>
          <p>Increase the search radius, reduce the requested quantity for testing, or choose another demo area. This is synthetic prototype data.</p>
        </div>`;
      return;
    }

    // Restore default result template if a previous search showed no-results.
    if (!$('best-center-name')) restoreResultTemplate();

    const best = state.results[0];
    state.bestCenter = best;
    const fresh = freshnessLabel(best.freshnessMinutes);

    $('best-center-name').textContent = best.name;
    $('best-center-address').textContent = `${best.type} · ${best.address}`;
    $('best-score').textContent = `${best.score}%`;
    $('score-ring').style.setProperty('--score', `${best.score}%`);
    $('best-distance').textContent = `${best.distance.toFixed(1)} km`;
    $('best-stock').textContent = `${best.stock} bags`;
    $('best-group-label').textContent = `${displayGroup(state.selectedBlood)} demo stock`;
    $('best-freshness').textContent = best.freshnessMinutes < 60 ? `${best.freshnessMinutes} min` : `${Math.round(best.freshnessMinutes / 60)} hr`;
    $('best-reason').textContent = buildReason(best, quantity);
    $('result-count').textContent = `${state.results.length} eligible`;

    const list = $('alternatives-list');
    const alternatives = state.results.slice(1, 5);
    list.innerHTML = alternatives.length
      ? alternatives.map((center, index) => `
        <button class="alt-card" data-center-id="${center.id}" type="button">
          <span class="alt-rank">${index + 2}</span>
          <span><b>${center.name}</b><small>${center.area} · ${center.stock} bag(s) of ${displayGroup(state.selectedBlood)}</small></span>
          <span class="alt-meta"><strong>${center.distance.toFixed(1)} km</strong><span>${center.score}% match</span></span>
        </button>`).join('')
      : `<div class="alt-card"><span class="alt-rank">✓</span><span><b>Only one eligible result</b><small>Try a larger radius to discover more demo centers.</small></span><span class="alt-meta"><strong>—</strong></span></div>`;

    list.querySelectorAll('[data-center-id]').forEach(btn => {
      btn.addEventListener('click', () => focusCenter(btn.dataset.centerId));
    });

    $('focus-map-btn').onclick = () => {
      document.querySelector('.map-shell').scrollIntoView({ behavior: 'smooth', block: 'center' });
      focusCenter(best.id);
    };
    $('show-details-btn').onclick = () => showCenterDetails(best);
  }

  function restoreResultTemplate() {
    $('results-content').innerHTML = `
      <div class="result-head">
        <div><span class="result-overline">BEST MATCH</span><h3 id="best-center-name">—</h3><p id="best-center-address">—</p></div>
        <div class="score-ring" id="score-ring"><strong id="best-score">0</strong><span>match</span></div>
      </div>
      <div class="metric-grid">
        <div class="metric"><span>Distance</span><strong id="best-distance">—</strong><small>straight-line estimate</small></div>
        <div class="metric"><span>Available</span><strong id="best-stock">—</strong><small id="best-group-label">requested group</small></div>
        <div class="metric"><span>Freshness</span><strong id="best-freshness">—</strong><small>simulated inventory age</small></div>
      </div>
      <div class="why-card"><span class="why-icon">✦</span><div><b>Why this center?</b><p id="best-reason">—</p></div></div>
      <div class="result-actions"><button class="btn btn-primary" id="focus-map-btn">View on map</button><button class="btn btn-secondary dark" id="show-details-btn">Center details</button></div>
      <div class="alternatives-head"><h4>Other eligible options</h4><span id="result-count">0 found</span></div>
      <div id="alternatives-list" class="alternatives-list"></div>`;
  }

  function buildReason(center, quantity) {
    const surplus = center.stock - quantity;
    const freshness = center.freshnessMinutes <= 15 ? 'very fresh simulated inventory' : 'recent simulated inventory';
    return `${center.name} can satisfy the full ${quantity}-bag request, is about ${center.distance.toFixed(1)} km from ${state.userLocationName}, has ${surplus} extra unit${surplus === 1 ? '' : 's'} in the demo stock, and has ${freshness}.`;
  }

  function displayGroup(group) { return group.replace('-', '−'); }

  // ------------------------------
  // Map
  // ------------------------------
  function initMap() {
    if (!window.L) {
      $('map').innerHTML = '<div class="map-fallback">Interactive map could not load. Internet access is required for Leaflet/OpenStreetMap tiles; the recommendation engine still works offline.</div>';
      return;
    }
    state.map = L.map('map', { zoomControl: true, scrollWheelZoom: false }).setView([23.4607, 91.1809], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(state.map);
    state.markersLayer = L.layerGroup().addTo(state.map);
    renderMap();
  }

  function markerIcon(kind) {
    const cls = kind === 'user' ? 'pin-user' : kind === 'recommended' ? 'pin-recommended' : 'pin-other';
    const glyph = kind === 'user' ? '●' : '♥';
    return L.divIcon({ className: 'custom-map-icon', html: `<div class="pin-bubble ${cls}"><span>${glyph}</span></div>`, iconSize: [38, 38], iconAnchor: [19, 34], popupAnchor: [0, -34] });
  }

  function renderMap() {
    if (!state.map || !state.markersLayer) return;
    state.markersLayer.clearLayers();
    const bounds = [];

    if (state.userLocation) {
      L.marker([state.userLocation.lat, state.userLocation.lng], { icon: markerIcon('user') })
        .bindPopup(`<div class="map-popup"><b>Your location</b><span>${state.userLocationName}</span></div>`)
        .addTo(state.markersLayer);
      bounds.push([state.userLocation.lat, state.userLocation.lng]);
    }

    const resultIds = new Set(state.results.map(r => r.id));
    const centersToShow = state.results.length ? hospitals.filter(h => resultIds.has(h.id)) : hospitals;

    centersToShow.forEach(center => {
      const result = state.results.find(r => r.id === center.id);
      const isBest = state.bestCenter && state.bestCenter.id === center.id;
      const stockLine = result ? `${result.stock} bag(s) ${displayGroup(state.selectedBlood)} · ${result.distance.toFixed(1)} km` : `${center.type} · synthetic inventory`;
      L.marker([center.lat, center.lng], { icon: markerIcon(isBest ? 'recommended' : 'other') })
        .bindPopup(`<div class="map-popup"><b>${center.name}</b><span>${center.area}</span><span>${stockLine}</span></div>`)
        .addTo(state.markersLayer);
      bounds.push([center.lat, center.lng]);
    });

    if (bounds.length > 1) state.map.fitBounds(bounds, { padding: [45, 45], maxZoom: 14 });
    else if (bounds.length === 1) state.map.setView(bounds[0], 14);
  }

  function focusCenter(centerId) {
    const center = hospitals.find(h => h.id === centerId);
    if (!center || !state.map) return;
    state.map.setView([center.lat, center.lng], 15, { animate: true });
    state.markersLayer.eachLayer(layer => {
      const ll = layer.getLatLng && layer.getLatLng();
      if (ll && Math.abs(ll.lat - center.lat) < .00001 && Math.abs(ll.lng - center.lng) < .00001) layer.openPopup();
    });
  }

  // ------------------------------
  // Dataset table
  // ------------------------------
  function totalInventory(center) { return Object.values(center.inventory).reduce((sum, n) => sum + n, 0); }

  function renderNetworkTable(filter = 'ALL') {
    const body = $('network-table-body');
    $('stock-heading').textContent = filter === 'ALL' ? 'Total stock' : `${displayGroup(filter)} stock`;
    body.innerHTML = hospitals.map(center => {
      const fresh = freshnessLabel(center.freshnessMinutes);
      const stock = filter === 'ALL' ? totalInventory(center) : center.inventory[filter];
      return `<tr>
        <td class="center-cell"><b>${center.name}</b><small>${center.id} · synthetic data</small></td>
        <td>${center.area}</td><td>${center.type}</td><td><b>${stock}</b> bag(s)</td>
        <td class="${fresh.className}">${fresh.text}</td>
        <td><span class="status-pill ${center.open ? 'open' : 'closed'}">${center.open ? '● Open' : '● Closed'}</span></td>
      </tr>`;
    }).join('');
  }

  $('network-blood-filter').addEventListener('change', e => renderNetworkTable(e.target.value));

  function renderStats() {
    $('total-units').textContent = hospitals.reduce((sum, center) => sum + totalInventory(center), 0);
    $('open-centers').textContent = hospitals.filter(h => h.open).length;
  }

  // ------------------------------
  // Details modal
  // ------------------------------
  function showCenterDetails(center) {
    $('modal-title').textContent = center.name;
    $('modal-body').innerHTML = `
      <div class="detail-grid">
        <div class="detail-item"><span>TYPE</span><b>${center.type}</b></div>
        <div class="detail-item"><span>AREA</span><b>${center.area}</b></div>
        <div class="detail-item"><span>DEMO RELIABILITY</span><b>${center.reliability}%</b></div>
        <div class="detail-item"><span>SIMULATED UPDATE AGE</span><b>${center.freshnessMinutes} min</b></div>
        <div class="detail-item"><span>STATUS</span><b>${center.open ? 'Open' : 'Closed'}</b></div>
        <div class="detail-item"><span>PHONE PLACEHOLDER</span><b>${center.phone}</b></div>
      </div>
      <h4 class="inventory-title">Synthetic blood inventory</h4>
      <div class="inventory-grid">${Object.entries(center.inventory).map(([g, n]) => `<div class="inventory-box"><b>${displayGroup(g)}</b><span>${n} bag(s)</span></div>`).join('')}</div>
      <p style="color:#7b8582;font-size:10px;margin-top:18px">This center and its inventory values are fictional and intended only for university prototype testing.</p>`;
    $('details-modal').classList.remove('hidden');
  }

  $('modal-close').addEventListener('click', () => $('details-modal').classList.add('hidden'));
  $('details-modal').addEventListener('click', e => { if (e.target.id === 'details-modal') $('details-modal').classList.add('hidden'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('details-modal').classList.add('hidden'); });

  // ------------------------------
  // UX helpers
  // ------------------------------
  let toastTimer;
  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function setupReveal() {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) entry.target.classList.add('visible'); });
    }, { threshold: .1 });
    document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
  }

  renderStats();
  renderNetworkTable();
  setupReveal();
  initMap();
})();
