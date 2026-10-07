const V='20261007a',CACHE='ticketline-shell-'+V;
const SHELL=['./index.html','./privacy.html','./tickets.css?v='+V,'./tickets.js?v='+V,
  './auth.js?v='+V,'./dev-fixtures.js?v='+V,'./app.js?v='+V];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
// Only same-origin static files are cached. Supabase API responses (private alert data)
// are cross-origin and never touch this cache.
self.addEventListener('fetch',event=>{
 const req=event.request,url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==self.location.origin)return;
 if(req.mode==='navigate'){
   event.respondWith(fetch(req).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(c=>c.put(req,copy));}return response;})
     .catch(()=>caches.match(req,{ignoreSearch:true}).then(hit=>hit||caches.match('./index.html'))));
 }else{
   event.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(response=>{
     if(response.ok&&/\.(?:js|css|svg|png)(?:\?|$)/.test(url.pathname+url.search)){
       const copy=response.clone();caches.open(CACHE).then(c=>c.put(req,copy));
     }return response;
   })));
 }
});
