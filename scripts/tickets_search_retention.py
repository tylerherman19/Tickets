"""Scheduled search-log retention only; never contacts ticket providers."""
import json
import os
import urllib.request


def main():
    url = os.environ['SUPABASE_URL'].rstrip('/')
    key = os.environ['SUPABASE_SERVICE_KEY']
    request = urllib.request.Request(
        url + '/rest/v1/rpc/tix_prune_search_activity',
        data=b'{}', method='POST',
        headers={'apikey': key, 'Authorization': 'Bearer ' + key,
                 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        count = json.load(response)
    print('Expired search records:', int(count))


if __name__ == '__main__':
    main()
