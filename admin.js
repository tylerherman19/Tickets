'use strict';
chrome('admin');
const adminState={dataset:'watches',search:'',offset:0,snapshot:null,rows:[],total:0,busy:false,generation:0};
const ADMIN_DATASETS={searches:'Search activity',watches:'Alerts',users:'Users',deliveries:'Notifications',confirmations:'Save confirmations',destinations:'Text destinations',scans:'Latest alert checks',prices:'Alert price history',tracking:'Personal event follows',watch_audit:'Alert change log',admin_audit:'Admin access log',catalog:'Event catalog',teams:'Team coverage',jobs:'Price check queue',observations:'Market observations',listings:'Listing details',provider_requests:'Provider request log',team_events:'Team event mappings',team_demand:'Team refresh demand',discovery_interest:'Event refresh demand',search_limits:'Current search request limits',venue_clubs:'Venue sections',event_changes:'Event schedule changes',health:'Collector and notification health'};
async function adminRpc(name,body={}) {
 if(IS_DEV)return adminPreview(name,body);
 return sbRpc(name,body);
}
function adminPreview(name,body){
 if(name==='tix_is_admin')return true;
 if(name==='tix_admin_update_alert')throw new Error('Preview only. No live records were changed.');
 if(name==='tix_admin_search_activity')return {searches:0,distinct_terms:0,no_results:0,failed:0,signed_in:0,anonymous:0,daily:[],popular:[],unmatched:[],recent:[]};
 if(name==='tix_admin_overview')return {users:24,signed_in_users:16,users_with_alerts:19,active_alerts:43,paused_alerts:5,archived_alerts:7,email_alerts:41,sms_alerts:2,deliveries:86,failed_deliveries:2,history_follows:120,provider_requests_24h:780,days:body.p_days,generated_at:new Date().toISOString(),daily:Array.from({length:body.p_days},(_,i)=>({day:new Date(Date.now()-(body.p_days-1-i)*86400000).toISOString().slice(0,10),signups:i%4,alerts_created:i%6,alert_changes:i%3,sent:i%9,failed:i%13===0?1:0})),popular_alerts:[{label:'Wisconsin Basketball',alerts:9,users:6},{label:'Syracuse Football',alerts:7,users:5}]};
 const rows=body.p_dataset==='users'?[{id:'demo-user',email:'alex@example.com',created_at:'2026-10-01',last_sign_in_at:'2026-10-17',alerts:3,active_alerts:2,admin:false}]:body.p_dataset==='watches'?[{id:'demo-alert',owner_email:'alex@example.com',owner_id:'demo-user',label:'Wisconsin Basketball',kind:'team',match:{team_id:'cbbwis',home_away:'home'},qty:2,threshold_cents:4500,active:true,email_enabled:true,sms_enabled:false,clubs:[],alert_style:'first',created_at:'2026-10-12',last_check:new Date().toISOString(),last_notification:'2026-10-16'}]:[];
 return {rows:rows.filter(x=>JSON.stringify(x).toLowerCase().includes((body.p_search||'').toLowerCase())),total:rows.filter(x=>JSON.stringify(x).toLowerCase().includes((body.p_search||'').toLowerCase())).length,offset:0,limit:50,snapshot:new Date().toISOString()};
}
function adminStatus(w){return w.purchased_at?'Purchased':w.match?.archived_at?'Archived':w.active?'Active':'Paused';}
function adminChart(daily,keys,title){
 const peak=Math.max(1,...daily.map(d=>keys.reduce((n,k)=>n+Number(d[k]||0),0)));
 return `<section class="admin-panel"><h2>${esc(title)}</h2><p class="muted">Daily counts · UTC</p><p class="admin-legend">${keys.map((k,i)=>`<span><i class="admin-series-${i}"></i>${esc(k.replaceAll('_',' '))}</span>`).join('')}</p><div class="admin-chart" role="img" aria-label="${esc(title)}. Exact daily values in the table below.">${daily.map(d=>`<div class="admin-day" title="${esc(d.day+': '+keys.map(k=>k+' '+d[k]).join(', '))}">${keys.map((k,i)=>`<i class="admin-series-${i}" style="height:${Number(d[k]||0)/peak*100}%"></i>`).join('')}</div>`).join('')}</div><p class="muted">${esc(daily[0]?.day||'')} — ${esc(daily.at(-1)?.day||'')}</p><details><summary>Daily values (${keys.map(esc).join(', ')})</summary><div class="admin-table-scroll"><table><thead><tr><th>Day</th>${keys.map(k=>`<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${daily.map(d=>`<tr><td>${esc(d.day)}</td>${keys.map(k=>`<td>${Number(d[k]||0)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details></section>`;
}
function adminOverview(data){
 const metrics=[['Accounts',data.users],['Signed in in range',data.signed_in_users],['Users with alerts',data.users_with_alerts],['Active alerts',data.active_alerts],['Paused alerts',data.paused_alerts],['Archived alerts',data.archived_alerts],['Email alerts active',data.email_alerts],['Text alerts active',data.sms_alerts],['Notifications sent',data.deliveries],['Notifications failed',data.failed_deliveries],['Event follows',data.history_follows],['Provider requests · 24h',data.provider_requests_24h]];
 return `<div class="admin-metrics">${metrics.map(([label,value])=>`<article><span>${esc(label)}</span><strong>${Number(value||0).toLocaleString()}</strong></article>`).join('')}</div><p class="field-help">Account, alert and follow counts are current totals. Sign-ins and notifications use the selected range. Sent means accepted by the mail server; inbox delivery is not confirmed. Page views and anonymous sessions are not collected. Logs follow existing retention and may not cover the entire range.</p><div class="admin-chart-grid">${adminChart(data.daily,['signups','alerts_created'],'Account and alert growth')}${adminChart(data.daily,['sent','failed'],'Notification activity')}</div><section class="admin-panel"><h2>Most watched</h2>${(data.popular_alerts||[]).map(d=>`<p>${esc(d.label)} <strong>${Number(d.alerts)} alerts · ${Number(d.users)} users</strong></p>`).join('')||'<p>No active alerts.</p>'}</section><details class="admin-panel"><summary>Operational status</summary><pre>${esc(JSON.stringify({generated_at:data.generated_at,latest_check:data.latest_check,failed_latest_checks:data.failed_latest_checks,provider_guard:data.provider_guard},null,2))}</pre></details>`;
}
function adminTable(rows){
 if(!rows.length)return '<p class="notice">No records match this view.</p>';
 const cols=adminState.dataset==='watches'?['owner_email','label','status','qty','threshold_cents','email_enabled','sms_enabled','last_check','last_notification']:adminState.dataset==='searches'?['searched_at','query','owner_email','outcome','visible_results','has_more','filters']:adminState.dataset==='users'?['email','created_at','last_sign_in_at','alerts','active_alerts','admin']:Object.keys(rows[0]).slice(0,8);
 const cell=(r,c)=>c==='status'?adminStatus(r):c==='threshold_cents'?money(r[c]):typeof r[c]==='object'?JSON.stringify(r[c]):r[c]==null?'—':String(r[c]);
 return `<div class="admin-table-scroll"><table><thead><tr>${cols.map(c=>`<th>${esc(c.replaceAll('_',' '))}</th>`).join('')}<th>Full record</th></tr></thead><tbody>${rows.map((r,i)=>`<tr>${cols.map(c=>`<td>${esc(cell(r,c))}</td>`).join('')}<td><button class="text-button" data-admin-record="${i}">View${adminState.dataset==='watches'?' / edit':''}</button>${adminState.dataset==='users'?`<button class="text-button" data-admin-user="${i}">View alerts</button>`:''}</td></tr>`).join('')}</tbody></table></div>`;
}
async function loadAdminData(reset=false){
 const generation=++adminState.generation;
 if(reset){adminState.offset=0;adminState.snapshot=null;}
 const holder=$('#admin-records');holder.innerHTML=loadingRows(2);$('#admin-data-status').textContent='Loading records…';
 try{
 const data=await adminRpc('tix_admin_data',{p_dataset:adminState.dataset,p_search:adminState.search,p_offset:adminState.offset,p_limit:50,p_snapshot:adminState.snapshot});
 if(generation!==adminState.generation)return;
 adminState.rows=data.rows;adminState.total=data.total;adminState.snapshot=data.snapshot;
 holder.innerHTML=adminTable(data.rows);
 $('#admin-data-status').textContent=`${data.total.toLocaleString()} records · showing ${data.rows.length?adminState.offset+1:0}–${adminState.offset+data.rows.length}`;
 $('#admin-prev').disabled=adminState.offset===0;$('#admin-next').disabled=adminState.offset+data.rows.length>=data.total;
 holder.querySelectorAll('[data-admin-record]').forEach(b=>b.onclick=()=>adminRecord(adminState.rows[Number(b.dataset.adminRecord)]));
 holder.querySelectorAll('[data-admin-user]').forEach(b=>b.onclick=()=>{const u=adminState.rows[Number(b.dataset.adminUser)];adminState.dataset='watches';adminState.search=u.id;$('#admin-dataset').value='watches';$('#admin-search').value=u.id;loadAdminData(true);});
 }catch(e){if(generation!==adminState.generation)return;holder.innerHTML=errorBox(e.message,'admin-retry');$('#admin-data-status').textContent='Records unavailable';$('#admin-retry').onclick=()=>loadAdminData();}
}
function adminRecord(row){
 const editable=adminState.dataset==='watches';
 const fields=['active','label','kind','match','clubs','qty','threshold_cents','alert_style','email_enabled','sms_enabled','purchased_at','purchase_price_cents'];
 const patch=Object.fromEntries(fields.filter(k=>k in row).map(k=>[k,row[k]]));
 showDialog(editable?'Manage alert':'Full record',`<pre class="admin-json">${esc(JSON.stringify(row,null,2))}</pre>${editable?`<label class="field-label" for="admin-patch">Edit alert fields (JSON)</label><p class="field-help">Changes apply to this user’s alert immediately and are recorded in the audit log. Turning off a channel stops future messages.</p><textarea id="admin-patch" class="admin-editor" spellcheck="false">${esc(JSON.stringify(patch,null,2))}</textarea><label><input type="checkbox" id="admin-confirm"> I reviewed these changes for ${esc(row.owner_email||'this user')}.</label><p id="admin-save-status" role="status"></p><button class="button primary" id="admin-save">Save alert changes</button>`:''}`);
 if(editable)$('#admin-save').onclick=async()=>{
 const status=$('#admin-save-status');if(!$('#admin-confirm').checked){status.textContent='Review and confirm the changes first.';return;}
 const button=$('#admin-save');button.disabled=true;
 try{const parsed=JSON.parse($('#admin-patch').value);await adminRpc('tix_admin_update_alert',{p_id:row.id,p_patch:parsed});$('#dialog').close();toast('Alert updated. Changes recorded in the audit log.');await loadAdminData(true);await loadAdminOverview();}catch(e){status.textContent=e.message;}finally{button.disabled=false;}
 };
}
async function loadAdminOverview(){
 const holder=$('#admin-overview');holder.textContent='Loading usage…';
 const days=Number($('#admin-days').value);
 try{const data=await adminRpc('tix_admin_overview',{p_days:days});if(days!==Number($('#admin-days').value))return;holder.innerHTML=adminOverview(data);}
 catch(e){holder.innerHTML=errorBox(e.message,'admin-overview-retry');$('#admin-overview-retry').onclick=loadAdminOverview;}
}
function searchTermsTable(rows){
 return rows?.length?`<div class="admin-table-scroll"><table><thead><tr><th>Search term</th><th>Searches</th><th>No visible results</th><th>Last searched</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.query)}</td><td>${Number(r.searches)}</td><td>${Number(r.no_results)}</td><td>${esc(r.last_searched)}</td></tr>`).join('')}</tbody></table></div>`:'<p>No searches in this range yet.</p>';
}
let searchActivityGeneration=0;
async function loadAdminSearchActivity(){
 const generation=++searchActivityGeneration,holder=$('#admin-search-activity'),days=Number($('#admin-days').value);
 holder.textContent='Loading search activity…';
 try{
 const data=await adminRpc('tix_admin_search_activity',{p_days:days});if(generation!==searchActivityGeneration)return;
 const metrics=[['Searches',data.searches],['Different terms',data.distinct_terms],['No visible results',data.no_results],['Failed searches',data.failed],['Signed in',data.signed_in],['Anonymous',data.anonymous]];
 holder.innerHTML=`<section class="admin-panel"><h2>What people are looking for</h2><p>Submitted searches and opened search links, starting October 18, 2026. Counts are client-reported searches, not unique people. Refreshes, filter changes and additional pages are excluded. Anonymous searches have no visitor identifier. Retained for 90 days; earlier searches are unavailable.</p><div class="admin-metrics">${metrics.map(([label,n])=>`<article><span>${esc(label)}</span><strong>${Number(n||0).toLocaleString()}</strong></article>`).join('')}</div>${adminChart(data.daily||[],['results','no_results','failed'],'Daily searches')}<h3>Popular searches</h3>${searchTermsTable(data.popular)}<h3>Searches with no visible results</h3><p class="field-help">No visible first-page matches under the chosen filters; this does not confirm that tickets are unavailable.</p>${searchTermsTable(data.unmatched)}<h3>Recent searches</h3><div class="admin-table-scroll"><table><thead><tr><th>When · UTC</th><th>Query</th><th>Account</th><th>Outcome</th><th>Visible on first page</th><th>Filters</th></tr></thead><tbody>${(data.recent||[]).map(r=>`<tr><td>${esc(r.searched_at)}</td><td>${esc(r.query)}</td><td>${esc(r.owner_email||'Anonymous')}</td><td>${esc(r.outcome)}</td><td>${Number(r.visible_results)}${r.has_more?' · more pages':''}</td><td>${esc(JSON.stringify(r.filters))}</td></tr>`).join('')||'<tr><td colspan="6">No searches recorded yet.</td></tr>'}</tbody></table></div><button id="admin-all-searches" class="button secondary">View / export all search records</button></section>`;
 $('#admin-all-searches').onclick=()=>{adminState.dataset='searches';adminState.search='';$('#admin-dataset').value='searches';$('#admin-search').value='';loadAdminData(true);$('#admin-dataset').focus();};
 }catch(e){if(generation!==searchActivityGeneration)return;holder.innerHTML=errorBox(e.message,'admin-search-activity-retry');$('#admin-search-activity-retry').onclick=loadAdminSearchActivity;}
}
async function adminExport(){
 const b=$('#admin-export'),status=$('#admin-export-status');b.disabled=true;let offset=0,records=[],snapshot=null;
 const dataset=adminState.dataset,search=adminState.search;
 try{
 do{const d=await adminRpc('tix_admin_data',{p_dataset:dataset,p_search:search,p_offset:offset,p_limit:200,p_snapshot:snapshot});snapshot=d.snapshot;records.push(...d.rows);offset+=d.rows.length;status.textContent=`Preparing ${records.length} of ${d.total} records…`;if(offset>=d.total)break;if(!d.rows.length)throw new Error('Data changed during export. Try again.');if(records.length>=100000)throw new Error('Export exceeds 100,000 records. Narrow the search and retry.');}while(true);
 const blob=new Blob([JSON.stringify({dataset,search,snapshot,records},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`ticketline-${dataset}-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent=`Exported ${records.length} records. This file contains private data; store it securely.`;
 }catch(e){status.textContent=e.message;}finally{b.disabled=false;}
}
async function initAdmin(){
 if(!await requireSession())return;
 try{
 if(!await adminRpc('tix_is_admin')){$('#main').innerHTML='<div class="container page"><h1>Admin access required.</h1><p>This account does not have access to Ticketline administration.</p><a href="./index.html">Return to events</a></div>';return;}
 $('#main').innerHTML=`<div class="container page admin-page"><div class="page-heading"><div><h1>Ticketline admin.</h1><p>Users, alerts, delivery and data operations.</p></div><button id="admin-refresh" class="button secondary">Refresh dashboard</button></div>${IS_DEV?'<p class="notice">Simulated admin preview. Synthetic users only. No live permissions, records or emails are changed.</p>':''}<label class="field-label" for="admin-days">Usage range</label><select id="admin-days"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select><div id="admin-overview"></div><div id="admin-search-activity"></div><section class="admin-panel"><h2>Data directory</h2><p>Search by email, user ID, alert label or any record value. Open a row for every stored business field. Profiles exclude credentials and authentication tokens.</p><form id="admin-filter" class="admin-tools"><label>Dataset<select id="admin-dataset">${Object.entries(ADMIN_DATASETS).map(([v,l])=>`<option value="${v}">${esc(l)}</option>`).join('')}</select></label><label>Search<input id="admin-search" type="search" maxlength="150" placeholder="Email, team, event or user ID"></label><button class="button secondary" type="submit">Search</button><button class="text-button" type="button" id="admin-export">Export matching JSON</button></form><p id="admin-export-status" role="status"></p><p id="admin-data-status" role="status"></p><div id="admin-records"></div><div class="admin-tools"><button id="admin-prev" class="button secondary" disabled>Previous</button><button id="admin-next" class="button secondary" disabled>Next 50</button></div></section><p class="muted">Admin reads and changes are audited. Historical logs may expire under existing retention. Refresh before comparing live counts. Exported data is a snapshot cutoff, not a transaction snapshot; concurrent edits can change records.</p></div>`;
 $('#admin-filter').onsubmit=e=>{e.preventDefault();adminState.dataset=$('#admin-dataset').value;adminState.search=$('#admin-search').value;loadAdminData(true);};
 $('#admin-dataset').onchange=()=>{$('#admin-filter').requestSubmit();};
 $('#admin-days').onchange=()=>{loadAdminOverview();loadAdminSearchActivity();};
 $('#admin-refresh').onclick=()=>{loadAdminOverview();loadAdminSearchActivity();loadAdminData(true);};
 $('#admin-prev').onclick=()=>{adminState.offset=Math.max(0,adminState.offset-50);loadAdminData();};
 $('#admin-next').onclick=()=>{adminState.offset+=50;loadAdminData();};
 $('#admin-export').onclick=adminExport;
 await Promise.all([loadAdminOverview(),loadAdminSearchActivity(),loadAdminData(true)]);
 }catch(e){$('#main').innerHTML=`<div class="container page"><h1>Administration unavailable.</h1>${errorBox(e.message,'admin-start-retry')}</div>`;$('#admin-start-retry').onclick=initAdmin;}
}
initAdmin();
