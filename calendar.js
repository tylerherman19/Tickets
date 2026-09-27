/* Date-only calendar entry: catalog times lack an explicit venue timezone. */
const icsEscape = s => String(s||'').replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
function calendarDates(event){
 const start=event.event_date.replace(/-/g,'');
 const next=new Date(event.event_date+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);
 return [start,next.toISOString().slice(0,10).replace(/-/g,'')];
}
function makeICS(event,alertUrl){
 const [start,end]=calendarDates(event);
 const description=`Ticketline alert: ${alertUrl}\nConfirm event time and tickets with the provider.`;
 return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Ticketline//Event calendar//EN','BEGIN:VEVENT',
   `UID:${icsEscape(event.event_id)}@ticketline`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')}`,
   `DTSTART;VALUE=DATE:${start}`,`DTEND;VALUE=DATE:${end}`,`SUMMARY:${icsEscape(event.name)}`,
   `LOCATION:${icsEscape([event.venue,event.city,event.state].filter(Boolean).join(', '))}`,
   `DESCRIPTION:${icsEscape(description)}`,'END:VEVENT','END:VCALENDAR'].join('\r\n');
}
function downloadICS(event,alertUrl){
 const blob=new Blob([makeICS(event,alertUrl)],{type:'text/calendar;charset=utf-8'});
 const link=document.createElement('a');link.href=URL.createObjectURL(blob);
 link.download='ticketline-'+event.event_id+'.ics';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}
function googleCalendarUrl(event,alertUrl){
 const [start,end]=calendarDates(event);
 const p=new URLSearchParams({action:'TEMPLATE',text:event.name,dates:`${start}/${end}`,
   details:`Ticketline alert: ${alertUrl}\nConfirm event time and tickets with the provider.`,
   location:[event.venue,event.city,event.state].filter(Boolean).join(', ')});
 return 'https://calendar.google.com/calendar/render?'+p.toString();
}
