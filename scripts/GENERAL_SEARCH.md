# General search

Apply `20261018_general_search.sql` after the catalog reliability migrations. General search reads public market data only; it does not expand access to user data or change the collector's request budgets.

Explore defaults to All events. All sports restricts the result to supported sport categories; individual league and concert filters remain explicit. Text search combines event/performer names, venue/city, full state names, and canonical source team memberships. A broad search is never automatically converted into one team. Selecting a team explicitly opens its existing schedule/chart workflow. Category, place, date, price and quantity controls continue to narrow results.

Regional associations use confirmed home-event states plus editorial region tags on canonical source team IDs. The Wisconsin launch seeds `cbbwis`, `cfbwis`, `mlbmil`, `nbamil`, `nflgnb`. These tags are geography, never proof of event membership or home status; games must be linked by the existing source-identified importer. `search_aliases` defines an explicit school-family search: Badgers matches UW Madison football and basketball, rather than the unrelated Spring Hill Badgers. Ordinary ambiguous aliases still match all their teams. Source directory updates preserve the editorial columns.

Broad searches page on the server and deduplicate games that match multiple teams. Names are searched with bound literal patterns against the original catalog fields; normalizing every catalog row was too slow on production. Only small team identity/alias sets use normalization. Exact seller-lot quantity verification remains separate from a get-in price.

If general matching is unavailable, the first page can visibly fall back to the older literal title/location search. Pagination stays in that mode. A later page failure does not silently switch matching algorithms. Missing schedules are refreshed by the existing hosted guarded worker, never by local provider calls.
