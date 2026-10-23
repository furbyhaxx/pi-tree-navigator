import gzip, json, sys, hashlib
p=sys.argv[1]
reqs=[]; streams={}
with gzip.open(p,'rt') as f:
    for line in f:
        try: rec=json.loads(line)
        except: continue
        if rec.get('type')=='request': reqs.append(rec)
        elif rec.get('type')=='stream':
            d=rec.get('data') or {}
            if d.get('type')=='response.output_item.done':
                it=d.get('item') or {}
                streams.setdefault(rec['request'],[]).append((it.get('type'),it.get('name'),(it.get('arguments') or '')[:120]))
print("requests",len(reqs))
for rec in reqs:
    pay=rec['payload']; inp=pay.get('input') or []
    idx=[i for i,it in enumerate(inp) if isinstance(it.get('content'),list) and any('Summarize only messages' in (b.get('text') or '') for b in it['content'] if isinstance(b,dict))]
    h=hashlib.sha256(json.dumps(inp,sort_keys=True).encode()).hexdigest()[:12]
    tails=[ (it.get('type') or it.get('role')) for it in inp[-3:]]
    print(f"req{rec['request']:>3} {rec['at']} len={len(inp):>3} instrIdx={idx} hash={h} tail={tails} tc={pay.get('tool_choice')} tools={[t.get('name') for t in pay.get('tools') or []]} calls={(streams.get(rec['request']) or [])[:4]}")
