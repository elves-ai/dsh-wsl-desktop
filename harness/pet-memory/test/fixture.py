import json, sys
payload = json.load(sys.stdin)
request = payload['request']
if request['action'] == 'ingest':
    print(json.dumps({'processed': True}))
elif request.get('query') == 'fail':
    sys.exit(1)
elif request.get('query') == 'disable':
    print(json.dumps({'enabled': False, 'text': '', 'bytes': 0}))
else:
    text = json.dumps({'name': request.get('query', ''), 'memories': []}, ensure_ascii=False)
    print(json.dumps({'enabled': True, 'text': text, 'bytes': len(text.encode())}, ensure_ascii=False))
