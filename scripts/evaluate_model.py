#!/usr/bin/env python3
from __future__ import annotations
import argparse,csv,json,math,random
from collections import defaultdict
from datetime import datetime
from pathlib import Path

EPS=1e-15

def dt(s):
    s=(s or '').strip()
    if not s:return None
    if s.endswith('Z'):s=s[:-1]+'+00:00'
    return datetime.fromisoformat(s)

def prob(name,s):
    p=float(s)
    if not 0<=p<=1:raise ValueError(f'{name} outside [0,1]: {p}')
    return p

def label(r):
    x=(r.get('settlement_result') or '').strip().upper()
    if x:
        if x in {'P','PUSH','DRAW','VOID'}: return None,True
        if x in {'W','WIN','1','TRUE'}: return 1,False
        if x in {'L','LOSS','0','FALSE'}: return 0,False
        raise ValueError(f'unknown settlement_result={x}')
    x=(r.get('actual_outcome') or '').strip().upper()
    if x in {'1','1.0','TRUE','WIN'}:return 1,False
    if x in {'0','0.0','FALSE','LOSS'}:return 0,False
    raise ValueError('need actual_outcome 0/1 or settlement_result WIN/LOSS/PUSH')

def brier(y,p):return sum((a-b)**2 for a,b in zip(y,p))/len(y)
def logloss(y,p):
    out=0.0
    for a,b in zip(y,p):
        b=min(max(b,EPS),1-EPS)
        out+=-(a*math.log(b)+(1-a)*math.log(1-b))
    return out/len(y)
def accuracy(y,p):return sum(int((b>=.5)==bool(a)) for a,b in zip(y,p))/len(y)
def ece(y,p,bins=10):
    groups=[[] for _ in range(bins)]
    for a,b in zip(y,p):groups[min(int(b*bins),bins-1)].append((a,b))
    n=len(y); s=0.0
    for g in groups:
        if not g:continue
        obs=sum(a for a,_ in g)/len(g); conf=sum(b for _,b in g)/len(g)
        s+=len(g)/n*abs(obs-conf)
    return s

def metrics(y,p):
    return {'brier':round(brier(y,p),8),'log_loss':round(logloss(y,p),8),'ece_10bin':round(ece(y,p),8),'accuracy_0_5':round(accuracy(y,p),8)}

def pct(xs,q):
    xs=sorted(xs); pos=(len(xs)-1)*q; lo=int(math.floor(pos)); hi=int(math.ceil(pos))
    return xs[lo] if lo==hi else xs[lo]*(hi-pos)+xs[hi]*(pos-lo)

def boot(y,c,b,fn,n,seed):
    # Per-row losses are fixed across resamples, so compute them once and sum
    # the resampled rows in draw order: same RNG stream, same summation order,
    # same numbers as re-scoring the resampled lists — at a third of the cost.
    rng=random.Random(seed); d=[]; m=len(y)
    lc=[fn([a],[p]) for a,p in zip(y,c)]; lb=[fn([a],[p]) for a,p in zip(y,b)]
    for _ in range(n):
        idx=[rng.randrange(m) for __ in range(m)]
        d.append(sum(lc[i] for i in idx)/m-sum(lb[i] for i in idx)/m)
    point=fn(y,c)-fn(y,b)
    return {'delta_candidate_minus_baseline':round(point,8),'ci95_low':round(pct(d,.025),8),'ci95_high':round(pct(d,.975),8)}

def main(argv=None):
    ap=argparse.ArgumentParser()
    ap.add_argument('--input',default='data/evaluation/predictions_eval.csv')
    ap.add_argument('--output',default='reports/latest_evaluation.json')
    ap.add_argument('--bootstrap-samples',type=int,default=2000)
    ap.add_argument('--min-gate-samples',type=int,default=200)
    ap.add_argument('--seed',type=int,default=42)
    a=ap.parse_args(argv); inp=Path(a.input); out=Path(a.output); out.parent.mkdir(parents=True,exist_ok=True)
    rep={'schema_version':'1.0','input':str(inp),'status':'UNKNOWN','gate':{'passed':False,'reasons':[]},'counts':{},'data_integrity':{},'overall':{},'segments':{}}
    if not inp.exists():
        rep['status']='NOT_RUN';rep['gate']['reasons']=[f'evaluation input not found: {inp}'];out.write_text(json.dumps(rep,indent=2),encoding='utf-8');return 2
    with inp.open(encoding='utf-8-sig',newline='') as f: rows=list(csv.DictReader(f))
    scored=[];errors=[];push=0;leaks=[];dups=[];seen=set();naive=0
    for i,r in enumerate(rows,2):
        try:
            y,is_push=label(r)
            if is_push:push+=1;continue
            c=prob('candidate_prob',r.get('candidate_prob',''))
            br=(r.get('baseline_prob') or '').strip(); b=prob('baseline_prob',br) if br else None
            pr=dt(r.get('prediction_timestamp','')); st=dt(r.get('event_start_time',''))
            naive+=int(pr is not None and pr.tzinfo is None)+int(st is not None and st.tzinfo is None)
            if pr and st:
                try:
                    if pr>=st:leaks.append(i)
                except TypeError:errors.append(f'row {i}: incompatible timezone formats')
            eid=(r.get('event_id') or '').strip(); mid=(r.get('market_id') or '').strip()
            if eid:
                key=eid+'|'+mid
                if key in seen:dups.append(key)
                seen.add(key)
            scored.append({'y':y,'candidate':c,'baseline':b,'sport':r.get('sport') or 'UNKNOWN','league':r.get('league') or 'UNKNOWN'})
        except Exception as e:errors.append(f'row {i}: {e}')
    rep['counts']={'raw_rows':len(rows),'scored_rows':len(scored),'push_rows_excluded':push,'invalid_rows':len(errors)}
    rep['data_integrity']={'errors':errors[:100],'prediction_at_or_after_start_rows':leaks[:100],'duplicate_event_market_keys':sorted(set(dups))[:100],'naive_timestamp_fields':naive}
    if errors or leaks or dups or not scored:
        if errors:rep['gate']['reasons'].append(f'{len(errors)} invalid rows')
        if leaks:rep['gate']['reasons'].append(f'{len(leaks)} rows predicted at/after event start')
        if dups:rep['gate']['reasons'].append(f'{len(set(dups))} duplicate event/market keys')
        if not scored:rep['gate']['reasons'].append('no scoreable rows')
        rep['status']='INVALID';out.write_text(json.dumps(rep,indent=2),encoding='utf-8');return 2
    y=[r['y'] for r in scored]; c=[r['candidate'] for r in scored]; rep['overall']['candidate']=metrics(y,c)
    all_b=all(r['baseline'] is not None for r in scored); some_b=any(r['baseline'] is not None for r in scored); regress=False
    if some_b and not all_b:rep['data_integrity']['warning']='partial baseline_prob; comparison skipped'
    if all_b:
        b=[r['baseline'] for r in scored]; rep['overall']['baseline']=metrics(y,b)
        comp={'brier':boot(y,c,b,brier,a.bootstrap_samples,a.seed),'log_loss':boot(y,c,b,logloss,a.bootstrap_samples,a.seed+1),'gate_min_samples':a.min_gate_samples};rep['overall']['comparison']=comp
        if len(y)>=a.min_gate_samples:
            for m in ('brier','log_loss'):
                if comp[m]['ci95_low']>0:
                    regress=True;rep['gate']['reasons'].append(f'candidate {m} statistically worse than baseline (paired-bootstrap 95% CI > 0)')
        else:rep['gate']['reasons'].append(f'baseline comparison descriptive only: n={len(y)} < {a.min_gate_samples}')
    for field in ('sport','league'):
        groups=defaultdict(list)
        for r in scored:groups[r[field]].append(r)
        rep['segments'][field]={}
        for k,g in groups.items():
            yy=[r['y'] for r in g];cc=[r['candidate'] for r in g];x={'n':len(g),'candidate':metrics(yy,cc)}
            if all(r['baseline'] is not None for r in g):x['baseline']=metrics(yy,[r['baseline'] for r in g])
            rep['segments'][field][k]=x
    rep['gate']['passed']=not regress;rep['status']='REGRESSION' if regress else 'PASS'
    if not rep['gate']['reasons']:rep['gate']['reasons']=['data integrity passed; no gated regression found']
    out.write_text(json.dumps(rep,indent=2),encoding='utf-8');print(json.dumps(rep,indent=2));return 3 if regress else 0

if __name__=='__main__': raise SystemExit(main())
