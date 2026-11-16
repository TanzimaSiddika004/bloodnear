(() => {
  'use strict';

  const LOCATIONS = {
    kandirpar:{name:'Kandirpar, Cumilla',lat:23.4607,lng:91.1809},racecourse:{name:'Race Course, Cumilla',lat:23.4682,lng:91.1762},
    jhautola:{name:'Jhautola, Cumilla',lat:23.4664,lng:91.1885},tomsom:{name:'Tomsom Bridge, Cumilla',lat:23.4459,lng:91.1776},
    shashongacha:{name:'Shashongacha, Cumilla',lat:23.4552,lng:91.1665},kotbari:{name:'Kotbari, Cumilla',lat:23.4254,lng:91.1367},
    medicalcollege:{name:'Medical College Area, Cumilla',lat:23.4374,lng:91.1855}
  };
  const BLOOD = ['A+','A-','B+','B-','AB+','AB-','O+','O-'];
  const state = { user:null, location:{...LOCATIONS.kandirpar}, feedGroup:'ALL', requests:[], donors:[], map:null, mapLayer:null, sse:null, drawerTab:'requests' };
  const $ = id => document.getElementById(id);
  const $$ = sel => [...document.querySelectorAll(sel)];

  function escapeHtml(value='') {
    return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }
  function displayBlood(v='') { return escapeHtml(v).replace('-', '−'); }
  function initials(name='U') { return name.split(/\s+/).filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase(); }
  function relativeTime(iso) {
    const s = Math.max(0, (Date.now()-new Date(iso).getTime())/1000);
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s/60)} min ago`; if (s < 86400) return `${Math.floor(s/3600)} hr ago`; return `${Math.floor(s/86400)} day${s>=172800?'s':''} ago`;
  }
  function dateTime(iso) { return new Intl.DateTimeFormat('en-BD',{dateStyle:'medium',timeStyle:'short'}).format(new Date(iso)); }
  function toLocalInput(date) { const d=new Date(date.getTime()-date.getTimezoneOffset()*60000); return d.toISOString().slice(0,16); }

  async function api(url, options={}) {
    const opts = { credentials:'same-origin', ...options, headers:{ ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers||{}) } };
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(message, type='') {
    const el=$('toast'); el.textContent=message; el.className=`toast show ${type}`;
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.className='toast',3200);
  }
  function openModal(id) { $(id).classList.remove('hidden'); document.body.style.overflow='hidden'; }
  function closeModal(id) { $(id).classList.add('hidden'); if (!$$('.modal-backdrop:not(.hidden)').length) document.body.style.overflow=''; }
  function requireLogin(next) { if (state.user) return true; openModal('auth-modal'); toast(next || 'Sign in to continue.'); return false; }

  async function init() {
    bindEvents();
    $('needed-by').value = toLocalInput(new Date(Date.now()+6*3600000));
    $('available-until').value = toLocalInput(new Date(Date.now()+24*3600000));
    await Promise.allSettled([loadMe(), loadStats()]);
    await Promise.allSettled([loadFeed(), loadDonors()]);
    handleHashRequest();
  }

  function bindEvents() {
    $$('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));
    $$('.modal-backdrop').forEach(m=>m.addEventListener('click',e=>{ if(e.target===m) closeModal(m.id); }));
    document.addEventListener('keydown',e=>{ if(e.key==='Escape') $$('.modal-backdrop:not(.hidden)').forEach(m=>closeModal(m.id)); });

    $('auth-btn').onclick=()=>openModal('auth-modal');
    $('create-request-btn').onclick=$('hero-post-btn').onclick=()=>{ if(requireLogin('Create an account or sign in before posting a request.')) openModal('request-modal'); };
    $('availability-btn').onclick=()=>{ if(requireLogin('Sign in before publishing donor availability.')) prepareAvailabilityModal(); };
    $('notification-btn').onclick=()=>openDashboard('notifications');
    $('profile-btn').onclick=()=>openDashboard('requests');
    $('dashboard-close').onclick=closeDashboard; $('dashboard-backdrop').onclick=closeDashboard;
    $('logout-btn').onclick=logout;
    $('refresh-feed-btn').onclick=$('apply-filters-btn').onclick=loadFeed;
    $('load-donors-btn').onclick=loadDonors;
    $('feed-radius').oninput=e=>$('radius-value').textContent=`${e.target.value} km`;
    $('feed-area').onchange=e=>{ state.location={...LOCATIONS[e.target.value]}; $('feed-location-label').textContent=`${state.location.name} demo location`; };
    $('feed-current-location').onclick=()=>useCurrentLocation(loc=>{ state.location=loc; $('feed-location-label').textContent='Current browser location'; loadFeed(); loadDonors(); });
    $('register-location-btn').onclick=()=>useCurrentLocation(loc=>{ $('register-area').value='Current browser area'; $('register-lat').value=loc.lat; $('register-lng').value=loc.lng; toast('Registration location updated.'); });
    $('request-current-location').onclick=()=>useCurrentLocation(loc=>setRequestLocation('Current browser location',loc.lat,loc.lng));
    $('availability-current-location').onclick=()=>useCurrentLocation(loc=>{ $('availability-area').value='Current browser area'; $('availability-lat').value=loc.lat; $('availability-lng').value=loc.lng; toast('Availability location updated.'); });
    $('request-location-select').onchange=e=>{ const l=LOCATIONS[e.target.value]; setRequestLocation(l.name,l.lat,l.lng); };

    $$('#feed-blood-grid button').forEach(btn=>btn.onclick=()=>{ $$('#feed-blood-grid button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); state.feedGroup=btn.dataset.group; });
    $$('.view-switch button').forEach(btn=>btn.onclick=()=>switchFeedView(btn.dataset.view));
    $$('[data-auth-tab]').forEach(btn=>btn.onclick=()=>switchAuthTab(btn.dataset.authTab));
    $$('[data-drawer-tab]').forEach(btn=>btn.onclick=()=>{ state.drawerTab=btn.dataset.drawerTab; renderDrawer(); });

    $('login-form').onsubmit=login;
    $('register-form').onsubmit=register;
    $('request-form').onsubmit=createRequest;
    $('availability-form').onsubmit=saveAvailability;
    $('pause-availability-btn').onclick=pauseAvailability;
    $('demo-login-btn').onclick=()=>{ $('login-form').elements.email.value='nabila@example.com'; $('login-form').elements.password.value='Demo123!'; $('login-form').requestSubmit(); };
    window.addEventListener('hashchange', handleHashRequest);
  }

  function switchAuthTab(tab) {
    $$('[data-auth-tab]').forEach(b=>b.classList.toggle('active',b.dataset.authTab===tab));
    $('login-form').classList.toggle('hidden',tab!=='login'); $('register-form').classList.toggle('hidden',tab!=='register');
  }

  async function loadMe() {
    const {user}=await api('/api/auth/me'); state.user=user; updateAuthUi(); if(user) connectSse();
  }
  function updateAuthUi() {
    const logged=Boolean(state.user);
    $('auth-btn').classList.toggle('hidden',logged); $('profile-btn').classList.toggle('hidden',!logged); $('notification-btn').classList.toggle('hidden',!logged);
    if(logged){ $('profile-name').textContent=state.user.name; $('profile-initial').textContent=initials(state.user.name); $('drawer-avatar').textContent=initials(state.user.name); $('drawer-name').textContent=state.user.name; $('drawer-meta').textContent=`${displayBlood(state.user.bloodGroup)} · ${state.user.area}`; $('admin-tab').classList.toggle('hidden',state.user.role!=='ADMIN'); updateNotificationBadge(state.user.unreadNotifications||0); }
  }
  function updateNotificationBadge(count) { const b=$('notification-badge'); b.textContent=count>99?'99+':count; b.classList.toggle('hidden',!count); }

  async function login(e) {
    e.preventDefault(); const form=new FormData(e.currentTarget);
    try{ const {user}=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:form.get('email'),password:form.get('password')})}); state.user=user; closeModal('auth-modal'); await loadMe(); toast(`Welcome back, ${user.name}.`); await Promise.all([loadFeed(),loadDonors()]); }
    catch(err){toast(err.message,'error');}
  }
  async function register(e) {
    e.preventDefault(); const form=new FormData(e.currentTarget);
    const payload=Object.fromEntries(form.entries()); payload.lat=Number(payload.lat); payload.lng=Number(payload.lng);
    try{ const {user}=await api('/api/auth/register',{method:'POST',body:JSON.stringify(payload)}); state.user=user; closeModal('auth-modal'); await loadMe(); toast('Account created successfully.'); }
    catch(err){toast(err.message,'error');}
  }
  async function logout() { await api('/api/auth/logout',{method:'POST'}); state.user=null; state.sse?.close(); state.sse=null; closeDashboard(); updateAuthUi(); toast('Signed out.'); await loadFeed(); }

  function useCurrentLocation(onSuccess) {
    if(!navigator.geolocation){toast('Geolocation is not supported by this browser.','error');return;}
    toast('Detecting your location…'); navigator.geolocation.getCurrentPosition(pos=>{const loc={name:'Current location',lat:pos.coords.latitude,lng:pos.coords.longitude};onSuccess(loc);toast(`Location detected · accuracy ±${Math.round(pos.coords.accuracy)} m`);},()=>toast('Location permission failed. You can use a demo area instead.','error'),{enableHighAccuracy:true,timeout:9000,maximumAge:30000});
  }
  function setRequestLocation(name,lat,lng){$('request-area').value=name;$('request-lat').value=lat;$('request-lng').value=lng;}

  async function loadStats() {
    try{const s=await api('/api/stats');$('stat-requests').textContent=s.activeRequests;$('stat-donors').textContent=s.activeDonors;$('stat-emergency').textContent=s.emergencyRequests;$('stat-fulfilled').textContent=s.fulfilledRequests;}catch{}
  }

  async function loadFeed() {
    const wrap=$('request-feed'); wrap.innerHTML='<div class="loading-card"></div><div class="loading-card"></div><div class="loading-card"></div>';
    const params=new URLSearchParams({lat:state.location.lat,lng:state.location.lng,radius:$('feed-radius').value,limit:'60'});
    if(state.feedGroup!=='ALL')params.set('bloodGroup',state.feedGroup);if($('feed-urgency').value!=='ALL')params.set('urgency',$('feed-urgency').value);
    try{const data=await api(`/api/requests?${params}`);state.requests=data.requests;$('feed-count').textContent=data.count;renderFeed();if(!$('request-map-wrap').classList.contains('hidden'))renderMap();}
    catch(err){wrap.innerHTML=`<div class="empty-state"><span>!</span><h3>Could not load requests</h3><p>${escapeHtml(err.message)}</p></div>`;}
  }
  function renderFeed() {
    const wrap=$('request-feed');
    if(!state.requests.length){wrap.innerHTML='<div class="empty-state"><span>⌖</span><h3>No matching active requests</h3><p>Try another blood group, increase the radius, or refresh later.</p></div>';return;}
    wrap.innerHTML=state.requests.map(r=>`<article class="request-card ${r.urgency==='EMERGENCY'?'emergency':''}" data-request-id="${r.id}">
      <div class="request-blood">${displayBlood(r.bloodGroup)}</div><div class="request-main"><h3>${escapeHtml(r.requiredUnits)} unit${r.requiredUnits>1?'s':''} needed ${r.hospitalName?`· ${escapeHtml(r.hospitalName)}`:''}</h3><p>⌖ ${escapeHtml(r.area)} · posted ${relativeTime(r.createdAt)}</p><div class="request-tags"><span class="tag ${r.urgency==='EMERGENCY'?'emergency':''}">${r.urgency==='EMERGENCY'?'Emergency':'Normal'}</span><span class="tag">Needed ${escapeHtml(dateTime(r.neededBy))}</span><span class="tag">${r.responseCount} response${r.responseCount===1?'':'s'}</span>${r.requester.isVerified?'<span class="tag verified">✓ Verified account</span>':''}</div></div>
      <div class="request-side">${r.matchScore!=null?`<div class="match-score">${r.matchScore}% discovery match</div>`:''}<div class="request-distance">${r.distanceKm!=null?`${r.distanceKm.toFixed(1)} km`:'—'}</div><div class="request-time">straight-line distance</div><button class="btn btn-outline" data-open-request="${r.id}">View request</button></div></article>`).join('');
    $$('[data-open-request]').forEach(b=>b.onclick=e=>{e.stopPropagation();openRequest(b.dataset.openRequest);});
    $$('.request-card').forEach(c=>c.onclick=()=>openRequest(c.dataset.requestId));
  }
  function switchFeedView(view){$$('.view-switch button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));$('request-feed').classList.toggle('hidden',view!=='cards');$('request-map-wrap').classList.toggle('hidden',view!=='map');if(view==='map')setTimeout(renderMap,30);}
  function renderMap(){
    const el=$('request-map');if(!window.L){el.innerHTML='<div class="map-fallback">Map tiles require internet access. Request discovery still works without the map.</div>';return;}
    if(!state.map){state.map=L.map('request-map',{scrollWheelZoom:false}).setView([state.location.lat,state.location.lng],12);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap contributors'}).addTo(state.map);state.mapLayer=L.layerGroup().addTo(state.map);}state.mapLayer.clearLayers();
    const userIcon=L.divIcon({className:'',html:'<div style="width:16px;height:16px;border-radius:50%;background:#222;border:4px solid white;box-shadow:0 2px 8px #555"></div>',iconSize:[16,16]});L.marker([state.location.lat,state.location.lng],{icon:userIcon}).bindPopup('Search location').addTo(state.mapLayer);
    const bounds=[[state.location.lat,state.location.lng]];
    for(const r of state.requests){const icon=L.divIcon({className:'',html:`<div style="min-width:38px;height:38px;padding:0 7px;border-radius:12px;background:${r.urgency==='EMERGENCY'?'#b51f38':'#871a2d'};color:white;border:3px solid white;box-shadow:0 5px 15px rgba(60,20,30,.25);display:grid;place-items:center;font:800 11px sans-serif">${displayBlood(r.bloodGroup)}</div>`,iconSize:[38,38]});const m=L.marker([r.lat,r.lng],{icon}).bindPopup(`<b>${escapeHtml(r.requiredUnits)} unit ${displayBlood(r.bloodGroup)}</b><br>${escapeHtml(r.area)}<br><button onclick="window.BloodNearOpenRequest('${r.id}')" style="margin-top:6px">View request</button>`).addTo(state.mapLayer);bounds.push([r.lat,r.lng]);}
    if(bounds.length>1)state.map.fitBounds(bounds,{padding:[35,35],maxZoom:14});else state.map.setView([state.location.lat,state.location.lng],12);setTimeout(()=>state.map.invalidateSize(),10);
  }
  window.BloodNearOpenRequest=id=>openRequest(id);

  async function createRequest(e){
    e.preventDefault();const form=new FormData(e.currentTarget);const payload=Object.fromEntries(form.entries());payload.requiredUnits=Number(payload.requiredUnits);payload.lat=Number(payload.lat);payload.lng=Number(payload.lng);payload.neededBy=new Date(payload.neededBy).toISOString();
    try{const {request}=await api('/api/requests',{method:'POST',body:JSON.stringify(payload)});closeModal('request-modal');e.currentTarget.reset();$('needed-by').value=toLocalInput(new Date(Date.now()+6*3600000));setRequestLocation(LOCATIONS.kandirpar.name,LOCATIONS.kandirpar.lat,LOCATIONS.kandirpar.lng);toast('Blood request published.');await Promise.all([loadStats(),loadFeed()]);openRequest(request.id);}catch(err){toast(err.message,'error');}
  }

  async function openRequest(id){
    try{const {request:r}=await api(`/api/requests/${encodeURIComponent(id)}`);renderRequestDetail(r);openModal('request-detail-modal');history.replaceState(null,'',`#request=${encodeURIComponent(id)}`);}catch(err){toast(err.message,'error');}
  }
  function renderRequestDetail(r){
    const c=$('request-detail-content');
    c.innerHTML=`<div class="detail-head"><div class="detail-blood">${displayBlood(r.bloodGroup)}</div><div><span class="section-kicker">${r.urgency==='EMERGENCY'?'EMERGENCY REQUEST':'BLOOD REQUEST'}</span><h2>${r.requiredUnits} unit${r.requiredUnits>1?'s':''} needed</h2><p>${escapeHtml(r.hospitalName||r.area)} · ${relativeTime(r.createdAt)}</p></div></div>
      <div class="detail-grid"><div class="detail-metric"><span>Location</span><b>${escapeHtml(r.area)}</b></div><div class="detail-metric"><span>Needed by</span><b>${escapeHtml(dateTime(r.neededBy))}</b></div><div class="detail-metric"><span>Status</span><b>${escapeHtml(r.status)}</b></div><div class="detail-metric"><span>Requester</span><b>${escapeHtml(r.requester.name)}</b></div><div class="detail-metric"><span>Trust</span><b>${r.requester.isVerified?'Verified account':'Standard account'}</b></div><div class="detail-metric"><span>Responses</span><b>${r.responseCount}</b></div></div>
      <div class="detail-description">${r.description?escapeHtml(r.description):'No additional description was provided.'}</div>
      ${r.connection?`<div class="connection-card"><b>Accepted connection</b><br>Requester: ${escapeHtml(r.connection.requesterName)}<br>Email: ${escapeHtml(r.connection.email||'Not provided')}<br>Phone: ${escapeHtml(r.connection.phone||'Not provided')}</div>`:''}
      ${r.acceptedConnections?.length?`<div class="connection-card"><b>Accepted donor contact</b><br>${r.acceptedConnections.map(x=>`${escapeHtml(x.name)} · ${escapeHtml(x.email||'No email')} · ${escapeHtml(x.phone||'No phone')}`).join('<br>')}</div>`:''}
      <div class="detail-actions" id="detail-actions"></div><div id="detail-extra"></div>`;
    const actions=$('detail-actions');
    if(r.isOwner){
      if(['OPEN','MATCHED'].includes(r.status)){actions.innerHTML=`<button class="btn btn-primary" data-status="FULFILLED">✓ Mark fulfilled</button><button class="btn btn-danger-soft" data-status="CANCELLED">Cancel request</button><button class="btn btn-outline" id="view-responses-btn">View responses</button><button class="btn btn-outline" id="view-matches-btn">Suggested donors</button>`;$$('[data-status]').forEach(b=>b.onclick=()=>updateRequestStatus(r.id,b.dataset.status));$('view-responses-btn').onclick=()=>loadResponses(r.id);$('view-matches-btn').onclick=()=>loadSuggestedDonors(r.id);}
      else actions.innerHTML='<span class="tag">This request is closed.</span>';
    } else {
      if(['OPEN','MATCHED'].includes(r.status)){
        if(!state.user)actions.innerHTML='<button class="btn btn-primary" id="detail-login-btn">Sign in to respond</button>';
        else if(state.user.bloodGroup!==r.bloodGroup)actions.innerHTML=`<span class="tag">Exact ${displayBlood(r.bloodGroup)} registered blood group required to respond in this prototype.</span><button class="btn btn-outline" id="report-request-btn">Report</button>`;
        else if(r.myResponseStatus && !['CANCELLED','DECLINED'].includes(r.myResponseStatus))actions.innerHTML=`<span class="tag verified">Response status: ${escapeHtml(r.myResponseStatus)}</span><button class="btn btn-outline" id="report-request-btn">Report</button>`;
        else actions.innerHTML='<button class="btn btn-primary" id="respond-btn">♥ I can donate</button><button class="btn btn-outline" id="report-request-btn">Report</button>';
        $('detail-login-btn')?.addEventListener('click',()=>{closeModal('request-detail-modal');openModal('auth-modal');});$('respond-btn')?.addEventListener('click',()=>respondToRequest(r.id));$('report-request-btn')?.addEventListener('click',()=>reportRequest(r.id));
      }
    }
  }
  async function respondToRequest(id){try{await api(`/api/requests/${id}/respond`,{method:'POST',body:JSON.stringify({message:'Available to coordinate. Hospital screening and final eligibility confirmation required.'})});toast('Your donor response was sent.');await openRequest(id);await loadMe();}catch(err){toast(err.message,'error');}}
  async function updateRequestStatus(id,status){try{await api(`/api/requests/${id}`,{method:'PATCH',body:JSON.stringify({status})});toast(`Request marked ${status.toLowerCase()}.`);await Promise.all([loadFeed(),loadStats()]);await openRequest(id);}catch(err){toast(err.message,'error');}}
  async function loadResponses(id){try{const {responses}=await api(`/api/requests/${id}/responses`);$('detail-extra').innerHTML=`<div class="responses-box"><h3>Donor responses</h3>${responses.length?responses.map(x=>`<div class="response-row"><span class="response-avatar">${initials(x.donor.name)}</span><div><b>${escapeHtml(x.donor.name)} · ${displayBlood(x.donor.bloodGroup)} ${x.donor.isVerified?'✓':''}</b><small>${escapeHtml(x.donor.area)} · ${escapeHtml(x.status)}${x.message?` · ${escapeHtml(x.message)}`:''}</small>${x.donor.email?`<small>${escapeHtml(x.donor.email)} · ${escapeHtml(x.donor.phone||'No phone')}</small>`:''}</div>${x.status==='INTERESTED'?`<div class="response-actions"><button class="btn btn-primary" data-response="${x.id}" data-response-status="ACCEPTED">Accept</button><button class="btn btn-outline" data-response="${x.id}" data-response-status="DECLINED">Decline</button></div>`:''}</div>`).join(''):'<p class="modal-lead">No donor responses yet.</p>'}</div>`;$$('[data-response-status]').forEach(b=>b.onclick=()=>updateResponse(b.dataset.response,b.dataset.responseStatus,id));}catch(err){toast(err.message,'error');}}
  async function updateResponse(responseId,status,requestId){try{await api(`/api/responses/${responseId}`,{method:'PATCH',body:JSON.stringify({status})});toast(`Response ${status.toLowerCase()}.`);await openRequest(requestId);await loadResponses(requestId);}catch(err){toast(err.message,'error');}}
  async function loadSuggestedDonors(id){try{const {donors}=await api(`/api/requests/${id}/matches`);$('detail-extra').innerHTML=`<div class="responses-box"><h3>Suggested exact-group donors</h3>${donors.length?donors.map(d=>`<div class="response-row"><span class="response-avatar">${initials(d.name)}</span><div><b>${escapeHtml(d.name)} · ${displayBlood(d.bloodGroup)} ${d.isVerified?'✓':''}</b><small>${escapeHtml(d.area)} · ${d.distanceKm.toFixed(1)} km away · available until ${escapeHtml(dateTime(d.availableUntil))}</small></div></div>`).join(''):'<p class="modal-lead">No active exact-group donors found.</p>'}</div>`;}catch(err){toast(err.message,'error');}}
  async function reportRequest(id){if(!requireLogin())return;const reason=prompt('Why are you reporting this request?');if(!reason)return;try{await api('/api/reports',{method:'POST',body:JSON.stringify({targetType:'REQUEST',targetId:id,reason})});toast('Report submitted for admin review.');}catch(err){toast(err.message,'error');}}

  async function loadDonors(){const group=$('donor-group').value;const q=new URLSearchParams({lat:state.location.lat,lng:state.location.lng,radius:'50'});if(group!=='ALL')q.set('bloodGroup',group);try{const {donors}=await api(`/api/donors?${q}`);state.donors=donors;renderDonors();}catch(err){$('donor-grid').innerHTML=`<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;}}
  function renderDonors(){const wrap=$('donor-grid');if(!state.donors.length){wrap.innerHTML='<div class="empty-state"><span>♡</span><h3>No active donors in this filter</h3><p>Registered users can publish temporary availability.</p></div>';return;}wrap.innerHTML=state.donors.slice(0,9).map(d=>`<article class="donor-card"><div class="donor-top"><span class="donor-avatar">${initials(d.name)}</span><span class="donor-blood">${displayBlood(d.bloodGroup)}</span></div><h3>${escapeHtml(d.name)} ${d.isVerified?'✓':''}</h3><p>⌖ ${escapeHtml(d.area)}</p><p class="donor-note">${escapeHtml(d.note||'Available for structured blood donation coordination.')}</p><div class="donor-meta"><span>${d.distanceKm!=null?`${d.distanceKm.toFixed(1)} km away`:'Active donor'}</span><span>until ${escapeHtml(dateTime(d.availableUntil))}</span></div></article>`).join('');}
  function prepareAvailabilityModal(){if(!state.user)return;$('availability-group').value=state.user.bloodGroup;$('availability-area').value=state.user.availability?.area||state.user.area;$('availability-lat').value=state.user.availability?.lat??LOCATIONS.kandirpar.lat;$('availability-lng').value=state.user.availability?.lng??LOCATIONS.kandirpar.lng;if(state.user.availability?.available_until)$('available-until').value=toLocalInput(new Date(state.user.availability.available_until));openModal('availability-modal');}
  async function saveAvailability(e){e.preventDefault();const f=new FormData(e.currentTarget);const p=Object.fromEntries(f.entries());p.bloodGroup=state.user.bloodGroup;p.lat=Number(p.lat);p.lng=Number(p.lng);p.availableUntil=new Date(p.availableUntil).toISOString();try{await api('/api/donor-availability',{method:'PUT',body:JSON.stringify(p)});closeModal('availability-modal');toast('Donor availability is active.');await Promise.all([loadMe(),loadDonors(),loadStats()]);}catch(err){toast(err.message,'error');}}
  async function pauseAvailability(){if(!state.user)return;try{await api('/api/donor-availability',{method:'DELETE'});closeModal('availability-modal');toast('Donor availability paused.');await Promise.all([loadMe(),loadDonors(),loadStats()]);}catch(err){toast(err.message,'error');}}

  function openDashboard(tab='requests'){if(!requireLogin())return;state.drawerTab=tab;$('dashboard-backdrop').classList.remove('hidden');$('dashboard-drawer').classList.add('open');renderDrawer();}
  function closeDashboard(){$('dashboard-backdrop').classList.add('hidden');$('dashboard-drawer').classList.remove('open');}
  async function renderDrawer(){if(!state.user)return;$$('[data-drawer-tab]').forEach(b=>b.classList.toggle('active',b.dataset.drawerTab===state.drawerTab));const wrap=$('drawer-content');wrap.innerHTML='<div class="loading-card"></div>';if(state.drawerTab==='requests')return renderMyRequests(wrap);if(state.drawerTab==='notifications')return renderNotifications(wrap);if(state.drawerTab==='admin')return renderAdmin(wrap);}
  async function renderMyRequests(wrap){try{const {requests}=await api('/api/requests?mine=1&status=ALL&limit=100');wrap.innerHTML=`<button class="btn btn-primary full" id="drawer-create">+ Create new blood request</button><div style="height:12px"></div>${requests.length?requests.map(r=>`<div class="my-request" data-open-my="${r.id}"><div class="my-request-head"><h3>${displayBlood(r.bloodGroup)} · ${r.requiredUnits} unit${r.requiredUnits>1?'s':''}</h3><span class="status-pill ${r.status.toLowerCase()}">${escapeHtml(r.status)}</span></div><p>${escapeHtml(r.hospitalName||r.area)} · ${relativeTime(r.createdAt)} · ${r.responseCount} response${r.responseCount===1?'':'s'}</p></div>`).join(''):'<div class="empty-state"><h3>No requests yet</h3><p>Your blood requests will appear here.</p></div>'}`;$('drawer-create').onclick=()=>{closeDashboard();openModal('request-modal');};$$('[data-open-my]').forEach(x=>x.onclick=()=>{closeDashboard();openRequest(x.dataset.openMy);});}catch(err){wrap.innerHTML=`<p>${escapeHtml(err.message)}</p>`;}}
  async function renderNotifications(wrap){try{const {notifications}=await api('/api/notifications');wrap.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="font-size:12px">Recent notifications</h3><button class="btn btn-outline" id="read-all-btn" style="font-size:9px;padding:6px 8px">Mark all read</button></div>${notifications.length?notifications.map(n=>`<div class="notification-row ${n.isRead?'':'unread'}" data-notification="${n.id}" data-link="${escapeHtml(n.link||'')}"><span class="notification-dot"></span><div><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.message)}</p><small>${relativeTime(n.createdAt)}</small></div></div>`).join(''):'<div class="empty-state"><h3>No notifications</h3><p>Matching and response updates will appear here.</p></div>'}`;$('read-all-btn').onclick=async()=>{await api('/api/notifications/read-all',{method:'POST'});updateNotificationBadge(0);renderNotifications(wrap);};$$('[data-notification]').forEach(n=>n.onclick=async()=>{await api(`/api/notifications/${n.dataset.notification}/read`,{method:'POST'});if(n.dataset.link?.startsWith('#request=')){const id=n.dataset.link.split('=')[1];closeDashboard();openRequest(id);}else renderNotifications(wrap);});}catch(err){wrap.innerHTML=`<p>${escapeHtml(err.message)}</p>`;}}
  async function renderAdmin(wrap){if(state.user.role!=='ADMIN'){wrap.innerHTML='Admin access required.';return;}try{const [{overview},{reports},{users}]=await Promise.all([api('/api/admin/overview'),api('/api/admin/reports'),api('/api/admin/users')]);wrap.innerHTML=`<div class="admin-stat-grid"><div class="admin-mini-stat"><span>Users</span><b>${overview.users}</b></div><div class="admin-mini-stat"><span>Active requests</span><b>${overview.activeRequests}</b></div><div class="admin-mini-stat"><span>Active donors</span><b>${overview.activeDonors}</b></div><div class="admin-mini-stat"><span>Open reports</span><b>${overview.openReports}</b></div></div><div class="admin-section"><h3>Open reports</h3>${reports.filter(r=>r.status==='OPEN').slice(0,8).map(r=>`<div class="admin-list-row"><span>${escapeHtml(r.targetType)} · ${escapeHtml(r.reason)}</span><button class="btn btn-outline" data-resolve-report="${r.id}" style="font-size:8px;padding:5px">Resolve</button></div>`).join('')||'<p class="modal-lead">No open reports.</p>'}</div><div class="admin-section"><h3>Users</h3>${users.slice(0,12).map(u=>`<div class="admin-list-row"><span>${escapeHtml(u.name)} · ${displayBlood(u.bloodGroup)} · ${escapeHtml(u.status)}</span>${u.role!=='ADMIN'?`<button class="btn btn-outline" data-user-status-id="${u.id}" data-user-current="${u.status}" style="font-size:8px;padding:5px">${u.status==='ACTIVE'?'Suspend':'Activate'}</button>`:''}</div>`).join('')}</div>`;$$('[data-resolve-report]').forEach(b=>b.onclick=async()=>{await api(`/api/admin/reports/${b.dataset.resolveReport}`,{method:'PATCH',body:JSON.stringify({status:'RESOLVED'})});toast('Report resolved.');renderAdmin(wrap);});$$('[data-user-status-id]').forEach(b=>b.onclick=async()=>{const next=b.dataset.userCurrent==='ACTIVE'?'SUSPENDED':'ACTIVE';await api(`/api/admin/users/${b.dataset.userStatusId}/status`,{method:'PATCH',body:JSON.stringify({status:next})});toast(`User ${next.toLowerCase()}.`);renderAdmin(wrap);});}catch(err){wrap.innerHTML=`<p>${escapeHtml(err.message)}</p>`;}}

  function connectSse(){if(!state.user||state.sse)return;const source=new EventSource('/api/events');state.sse=source;source.addEventListener('notification',async e=>{try{const n=JSON.parse(e.data);toast(n.title);await loadMe();if(state.drawerTab==='notifications'&&$('dashboard-drawer').classList.contains('open'))renderDrawer();}catch{}});source.onerror=()=>{source.close();state.sse=null;if(state.user)setTimeout(connectSse,5000);};}
  function handleHashRequest(){const m=location.hash.match(/^#request=(.+)$/);if(m)setTimeout(()=>openRequest(decodeURIComponent(m[1])),100);}

  init();
})();
