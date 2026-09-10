/* shared chrome + data for the ticket watch pages */
const SB_URL = "https://aahqagqztanltejsqjom.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhaHFhZ3F6dGFubHRlanNxam9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4OTU3MjIsImV4cCI6MjEwNDQ3MTcyMn0.GWQZZ0Sp45Q6mW8Fz3DYF2Gj-LEURBMa7HoWvBgXmaE";
const H = {apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json"};

async function sbGet(path){
  const r = await fetch(SB_URL + "/rest/v1/" + path, {headers: H});
  if(!r.ok) throw new Error("read failed " + r.status);
  return r.json();
}
async function sbWrite(method, path, body, prefer){
  const r = await fetch(SB_URL + "/rest/v1/" + path, {
    method, headers: Object.assign({}, H, {Prefer: prefer || "return=minimal"}),
    body: body == null ? undefined : JSON.stringify(body)
  });
  if(!r.ok){ const t = await r.text(); throw new Error(t.slice(0,200) || ("write failed " + r.status)); }
  if((prefer||"").includes("return=representation")) return r.json();
  return [];
}
const money = c => "$" + (c/100).toLocaleString("en-US", {maximumFractionDigits:0});
const todayISO = () => new Date().toISOString().slice(0,10);
function ago(ts){
  const s = Math.max(0, (Date.now() - new Date(ts).getTime())/1000);
  if(s < 90) return "just now";
  if(s < 3600) return Math.round(s/60) + " min ago";
  if(s < 86400) return (Math.round(s/360)/10) + " hr ago";
  return Math.round(s/86400) + " d ago";
}
function whenShort(iso){
  if(!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
}
const cap = s => s.split("-").map(w => w ? w[0].toUpperCase()+w.slice(1) : "").join(" ");

function chrome(active, sub){
  document.getElementById("chrome").innerHTML = `
  <header class="mast">
    <span class="lamp"></span><span class="wordmark">The Stub Wall</span>
    <span class="pagelabel disp">${sub}</span>
  </header>
  <nav class="pagenav">
    <a href="./index.html" class="${active==="wall"?"on":""}">Watches</a>
    <a href="./new.html" class="${active==="new"?"on":""}">New Watch</a>
    <a href="./ledger.html" class="${active==="ledger"?"on":""}">Ledger</a>
  </nav>`;
}
