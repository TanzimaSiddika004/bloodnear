const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const tempDb = path.join(root, 'data', `smoke-${process.pid}.sqlite`);
const port = 3199;
const base = `http://127.0.0.1:${port}`;
let server;

function assert(ok, message) { if (!ok) throw new Error(message); }
function cookieFrom(res) { const raw = res.headers.get('set-cookie'); return raw ? raw.split(';')[0] : ''; }
async function req(url, options={}) {
  const res = await fetch(base+url, options); let data={}; try{data=await res.json();}catch{}
  if(!res.ok) throw new Error(`${url}: ${res.status} ${data.error||''}`); return {res,data};
}
async function waitForServer() { for(let i=0;i<40;i++){try{const r=await fetch(base+'/api/health');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Server did not start'); }

(async()=>{
  try{
    server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DB_PATH:tempDb,SESSION_SECRET:'smoke-test-secret'},stdio:['ignore','pipe','pipe']});
    server.stderr.on('data',d=>process.stderr.write(d)); await waitForServer();
    const health=(await req('/api/health')).data; assert(health.ok,'Health failed');
    const login=await req('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'nabila@example.com',password:'Demo123!'})}); const ownerCookie=cookieFrom(login.res); assert(ownerCookie,'Owner cookie missing');
    const create=await req('/api/requests',{method:'POST',headers:{'Content-Type':'application/json',Cookie:ownerCookie},body:JSON.stringify({bloodGroup:'B+',requiredUnits:1,hospitalName:'Smoke Test Hospital',area:'Kandirpar, Cumilla',lat:23.4607,lng:91.1809,urgency:'NORMAL',neededBy:new Date(Date.now()+8*3600000).toISOString(),description:'Automated smoke test',contactPreference:'AFTER_ACCEPT'})}); const requestId=create.data.request.id;
    const register=await req('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Smoke Donor',email:`smoke-${process.pid}@example.com`,password:'Password123!',bloodGroup:'B+',area:'Race Course, Cumilla',lat:23.4682,lng:91.1762})}); const donorCookie=cookieFrom(register.res);
    await req(`/api/requests/${requestId}/respond`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:donorCookie},body:JSON.stringify({message:'Available'})});
    const responses=await req(`/api/requests/${requestId}/responses`,{headers:{Cookie:ownerCookie}}); assert(responses.data.responses.length===1,'Response not persisted'); const responseId=responses.data.responses[0].id;
    await req(`/api/responses/${responseId}`,{method:'PATCH',headers:{'Content-Type':'application/json',Cookie:ownerCookie},body:JSON.stringify({status:'ACCEPTED'})});
    const donorView=await req(`/api/requests/${requestId}`,{headers:{Cookie:donorCookie}}); assert(donorView.data.request.connection?.email==='nabila@example.com','Accepted contact was not unlocked');
    const adminLogin=await req('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@bloodnear.local',password:'Admin123!'})}); const adminCookie=cookieFrom(adminLogin.res); const overview=await req('/api/admin/overview',{headers:{Cookie:adminCookie}}); assert(overview.data.overview.users>=6,'Admin overview failed');
    console.log('Smoke test passed: health, auth, request, response, accept, private contact, admin.');
  } finally {
    if(server){server.kill('SIGTERM');await new Promise(r=>setTimeout(r,150));}
    for(const f of [tempDb,`${tempDb}-shm`,`${tempDb}-wal`]){try{fs.unlinkSync(f);}catch{}}
  }
})().catch(err=>{console.error(err);process.exitCode=1;});
