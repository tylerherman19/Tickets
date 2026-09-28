const CACHE='ticketline-shell-20260928e';
const SHELL=['./index.html','./tickets.css?v=20260928e','./tickets.js?v=20260928e',
  './auth.js?v=20260928e','./dev-fixtures.js?v=20260928e','./app.js?v=20260928e'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const req=event.request,url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==self.location.origin)return;
 if(req.mode==='navigate'){
   event.respondWith(fetch(req).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(c=>c.put(req,copy));}return response;})
     .catch(()=>caches.match(req).then(hit=>hit||caches.match('./index.html'))));
 }else{
   event.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(response=>{
     if(response.ok&&/\.(?:js|css|svg)(?:\?|$)/.test(url.pathname+url.search)){
       const copy=response.clone();caches.open(CACHE).then(c=>c.put(req,copy));
     }return response;
   })));
 }
});
