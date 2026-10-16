import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {captureFromPage,validEventUrl,blockingSignals,movedEventUrl} from '../supabase/functions/_shared/provider.mjs';
for(const shape of ['camel','snake'])test('Embedded '+shape+' captures preserve all fields and exact lots',()=>{
 const capture=captureFromPage(fs.readFileSync('tests/fixtures/listing_'+shape+'.html','utf8'),'fixture');
 assert.equal(capture.state,'complete');assert.equal(capture.by_qty[2].low,15000);
 assert.equal(capture.by_qty[3],undefined);
 assert.deepEqual(capture.listings[0].provider.seats,['1','2','3','4']);
});
test('Metadata-only differs from explicit empty inventory',()=>{
 const data={redux:{data:{fullEvents:{events:{fixture:{event:{id:'fixture',minPrice:{total:1234}}}}}}}};
 const html=()=> 'window.__data='+JSON.stringify(data);
 assert.equal(captureFromPage(html(),'fixture').state,'metadata_only');
 data.redux.listings={listings:[]};assert.equal(captureFromPage(html(),'fixture').state,'empty');
 assert.throws(()=>captureFromPage(html(),'other'),/event_id_mismatch/);
});
test('Unsafe URLs and blocking signals fail closed',()=>{
 assert.equal(validEventUrl('https://gametime.co/events/abc','abc'),true);
 for(const u of ['https://evil.test/events/abc','https://gametime.co/events/abc?quantity=2','https://gametime.co@evil.test/events/abc'])assert.equal(validEventUrl(u,'abc'),false);
 assert.deepEqual(blockingSignals(429,'OK'),['HTTP_429']);
 assert.deepEqual(blockingSignals(200,'<title>Access denied</title>'),['challenge_or_denial']);
});
test('Team and artist page links are harvested as safe provider paths only',async()=>{
 const {performerPaths}=await import('../supabase/functions/_shared/provider.mjs');
 const html='<a href="https://gametime.co/minnesota-vikings-tickets/performers/nflmin">V</a>'+
  '<astro-island props="{&quot;u&quot;:&quot;https:\\/\\/gametime.co\\/nba-basketball\\/lakers-tickets\\/performers\\/nbalal&quot;}"></astro-island>'+
  '<a href="/hamilton-tickets/performers/hamilton">H</a><a href="/syracuse-orange-tickets/performers/cbbsyr">S</a>'+
  ' /a/b/c/performers/deep https://evil.test/x-tickets/performers/bad <a href="https://gametime.co/minnesota-vikings-tickets/performers/nflmin">dup</a>';
 assert.deepEqual(performerPaths(html),['/minnesota-vikings-tickets/performers/nflmin','/nba-basketball/lakers-tickets/performers/nbalal','/hamilton-tickets/performers/hamilton']);
 assert.equal(performerPaths(html,1).length,1);
});
test('Only a redirect to the same event page on the provider replaces the saved link',()=>{
 const id='a'.repeat(24),from='https://gametime.co/nfl-football/bills-at-vikings-tickets/11-9-2026-minneapolis-mn-u-s-bank-stadium/events/'+id;
 const to='https://gametime.co/nfl-football/bills-at-vikings-tickets/11-8-2026-minneapolis-mn-u-s-bank-stadium/events/'+id;
 assert.equal(movedEventUrl(to,from,id),to);
 assert.equal(movedEventUrl(new URL(to).pathname,from,id),to);
 for(const location of [null,'',from,'https://evil.test/events/'+id,'//evil.test/events/'+id,'http://gametime.co/events/'+id,
  'https://gametime.co:8443/events/'+id,'https://user@gametime.co/events/'+id,to+'?quantity=2',to+'#x',
  to.replace(id,'b'.repeat(24)),'/nfl-football/minnesota-vikings-tickets/performers/nflmin','javascript:alert(1)'])
  assert.equal(movedEventUrl(location,from,id),null,String(location));
});
