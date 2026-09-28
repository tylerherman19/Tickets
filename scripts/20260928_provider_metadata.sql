-- Valid event metadata can arrive without the provider's listing payload.
-- Keep it distinct from an empty listing array and from a parser failure.
begin;
alter table public.tix_catalog drop constraint if exists tix_catalog_discovery_status_check;
alter table public.tix_catalog add constraint tix_catalog_discovery_status_check
  check (discovery_status in ('ok','metadata_only','parser_failure','event_unavailable','http_failure'));
alter table public.tix_scans drop constraint if exists tix_scans_outcome_check;
alter table public.tix_scans add constraint tix_scans_outcome_check
  check (outcome in ('ok','unavailable','provider_incomplete','parser_failure',
    'http_failure','event_unavailable','failed'));
commit;
