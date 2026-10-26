// Reuse the reviewed Ticketline schema without legacy anonymous writes or
// the privileged admin/account-removal APIs excluded from this recovery.
export function migrationSource(file,source){
 let sql=source.replace(/\bauth\./g,'ticketline_auth.');
 if(file==='tickets_schema.sql')sql=sql.replace(/^create policy "anon manages watches".*$/gm,'');
 if(file==='20260910_per_alert_destinations.sql')sql=sql.replace(/^grant execute on function public\.tix_(?:save_destination|destination_meta)\([^;]+ to anon;$/gm,'');
 sql=sql.replace(/create or replace function public\.(?:tix_delete_my_account|tix_admin_[a-z_]+)\([\s\S]*?\$\$;/g,'');
 sql=sql.replace(/(?:revoke|grant)\s+(?:all|execute)\b[^;]*public\.(?:tix_delete_my_account|tix_admin_[a-z_]+)\([^;]*;/g,'');
 if(file==='20261021_capture_write_performance.sql')sql=sql.replace("(item->>'verified_quantity')::integer,item->'provider'","(item->>'verified_quantity')::integer,null::jsonb");
 return sql;
}
