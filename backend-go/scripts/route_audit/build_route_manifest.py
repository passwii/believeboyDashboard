from __future__ import annotations
import json,re
from pathlib import Path
from collections import Counter,defaultdict
ROOT=Path(__file__).resolve().parents[3]
OPENAPI=json.load(open(ROOT/'frontend/types/api-generated/openapi.json'))
AST=json.load(open('/tmp/fastapi-routes.json'))
GO=json.load(open('/tmp/go-routes.json'))
METHODS={'get','post','put','patch','delete','head','options','trace'}

def normalize_path(path):
    path=re.sub(r'\{[^/{}]+\}','{}',path)
    if path!='/' and path.endswith('/'): path=path.rstrip('/')
    return path

def key(method,path): return (method.upper(),normalize_path(path))

def dynamic_risk(path):
    return any(x in path for x in (':path','*'))

def domain_from_source(source,path):
    if path.startswith('/api/v1/agent/'):
        return 'agent'
    if source:
        s=source.split(':')[0]
        if s.startswith('backend/app/api/v1/endpoints/'):
            rel=s[len('backend/app/api/v1/endpoints/'):]
            parts=rel.split('/')
            if parts[-1].endswith('.py'):
                name=parts[-1][:-3]
            else: name=parts[-1]
            if name=='__init__' and len(parts)>1: name=parts[-2]
            if name=='ad_data' and 'internal' in parts: return 'internal_ad_data'
            if name=='api_keys': return 'internal_api_keys'
            if name=='user_api_keys': return 'internal_user_api_keys'
            return name
    seg=[x for x in path.split('/') if x]
    return seg[2] if len(seg)>2 else 'root'

# index AST by normalized method/path.
ast_by_key=defaultdict(list)
for r in AST['routes']:
    ast_by_key[key(r['method'],r['path'])].append(r)

fast=[]
for path,item in OPENAPI.get('paths',{}).items():
    for meth,op in item.items():
        if meth.lower() not in METHODS: continue
        M=meth.upper(); k=key(M,path)
        cand=ast_by_key.get(k,[])
        visible=[x for x in cand if x.get('include_in_schema',True) and x.get('contract_eligible',True)]
        chosen=(visible or cand or [None])[0]
        source_raw_path=None
        if not chosen and path.startswith('/api/v1/internal/ad-data/projects/'):
            # 10 raw mirrors are registered in a dynamic loop, not decorators.
            base=re.split(r'_api_v1_',op.get('operationId',''))[0] or 'internal_ad_data_raw'
            chosen={'handler':base,'source':'backend/app/api/v1/endpoints/internal/ad_data.py:153','path':path,'auth':'internal_api_key','agent_domain':'internal'}
        if chosen:
            source=chosen['source']; handler=chosen.get('handler') or re.split(r'_api_v1_',op.get('operationId',''))[0]
            source_raw_path=chosen.get('path')
            auth=chosen.get('auth') or ('agent_api_key' if path.startswith('/api/v1/agent/') else 'api_key')
            agent_domain=chosen.get('agent_domain')
            domain=domain_from_source(source,path)
        else:
            source=None; handler=re.split(r'_api_v1_',op.get('operationId',''))[0]
            auth='public' if path in ('/api/v1/health/live','/api/v1/health/ready','/api/v1/auth/login') else ('agent_api_key' if path.startswith('/api/v1/agent/') else 'api_key')
            agent_domain=('shared' if path in ('/api/v1/agent/health','/api/v1/agent/projects') else None)
            domain=domain_from_source(None,path)
        rec={'method':M,'path':path,'normalized_path':normalize_path(path),'handler':handler,'source':source,'auth':auth,'agent_domain':agent_domain,'operation_id':op.get('operationId'),'summary':op.get('summary'),'domain':domain,'source_match_count':len(cand),'source_raw_path':source_raw_path}
        if path.startswith('/api/v1/agent/'):
            rec['domain']='agent:'+str(agent_domain or 'shared')
        fast.append(rec)

# Supplemental non-OpenAPI FastAPI route declarations (hidden aliases/fallbacks).
supp=[]
for r in AST['routes']:
    if not r.get('include_in_schema',True):
        supp.append({'method':r['method'],'path':r['path'],'handler':r['handler'],'source':r['source'],'reason':'include_in_schema=false','normalized_path':normalize_path(r['path']),'fallback':'path:path' in r['path']})

# Go active route index.
go_active=[r for r in GO['routes'] if r.get('active')]
go_by_key={key(r['method'],r.get('match_path',r['path'])):r for r in go_active}
go_path_methods=defaultdict(list)
for r in go_active: go_path_methods[normalize_path(r.get('match_path',r['path']))].append(r)

owned=[]; missing=[]; mismatches=[]
open_keys=set()
for r in fast:
    k=(r['method'],r['normalized_path']); open_keys.add(k)
    g=go_by_key.get(k)
    if g:
        owned.append({'fastapi':r,'go':g,'param_risks':[]})
        if ':path' in r['path'] or ':path' in (g.get('raw_path') or ''):
            owned[-1]['param_risks'].append('FastAPI :path wildcard matched to Go single-segment chi param')
    else:
        others=go_path_methods.get(r['normalized_path'],[])
        if others:
            mismatches.append({'fastapi':r,'go_methods':sorted({x['method'] for x in others}),'go_routes':others})
        else:
            missing.append(r)

go_keys={(r['method'],normalize_path(r.get('match_path',r['path'])) ) for r in go_active}
extra=[r for r in go_active if (r['method'],normalize_path(r.get('match_path',r['path']))) not in open_keys]
hidden_by_key={(r['method'],r['normalized_path']):r for r in supp}
hidden_exact=[dict(r,hidden_match=hidden_by_key[(r['method'],normalize_path(r.get('match_path',r['path'])))]) for r in extra if (r['method'],normalize_path(r.get('match_path',r['path']))) in hidden_by_key]
compat_extra=[r for r in extra if (r['method'],normalize_path(r.get('match_path',r['path']))) not in hidden_by_key]

# Detailed risks.
contract_risks=[]
for x in owned:
    f=x['fastapi']; g=x['go']
    raw=f.get('source_raw_path') or f['path']
    if ':path' in raw:
        contract_risks.append({'kind':'path_param_semantics','severity':'P1','method':f['method'],'path':f['path'],'source_raw_path':raw,'go_path':g['path'],'source':g['source'],'detail':'FastAPI :path 可跨段；chi {param} 仅单段，含斜杠 SKU 会 404'})
    if ':int' in raw:
        if not re.search(r'\{[^}]+:\[', g['path']):
            contract_risks.append({'kind':'param_validation_timing','severity':'P2','method':f['method'],'path':f['path'],'source_raw_path':raw,'go_path':g['path'],'source':g['source'],'detail':'FastAPI 路由层 int 转换 vs chi 无正则；非法值可能 404/422 差异'})
    if f['path'].startswith('/api/v1/agent/') and f.get('agent_domain') and g.get('agent_domain') and f['agent_domain'] != g['agent_domain']:
        contract_risks.append({'kind':'agent_scope_mismatch','severity':'P0','method':f['method'],'path':f['path'],'go_path':g['path'],'fastapi_scope':f['agent_domain'],'go_scope':g['agent_domain'],'source':g['source'],'detail':'Agent business_scope 不一致，可能在切换后 403 或扩大权限'})
for g in extra:
    hidden=hidden_by_key.get((g['method'],normalize_path(g.get('match_path',g['path']))))
    if hidden:
        contract_risks.append({'kind':'fastapi_hidden_alias','severity':'P2','method':g['method'],'path':g['path'],'match_path':g.get('match_path',g['path']),'hidden_path':hidden['path'],'source':g['source'],'detail':'实现的是 FastAPI include_in_schema=false 兼容别名/兜底，不计入 623 OpenAPI 基线'})
        continue
    if '*path' in g['path'] or '*' in g['path']:
        sev='P2'; detail='Go wildcard fallback 不在 OpenAPI 基线上'
    elif g['path'].startswith('/api/v1/product-costs'):
        sev='P2'; detail='FastAPI 隐藏别名（include_in_schema=false），OpenAPI 基线下仍为实际路由'
    elif g['path'].startswith('/api/v1/internal/ad-data/projects/') and g['path'].endswith('/ad-campaign-raw'):
        sev='P2'; detail='Go extra singular alias 不在 FastAPI internal ad-data 集合'
    elif g['path'].startswith('/api/v1/agent/'):
        sev='P2'; detail='Agent 兼容超集；OpenAPI 无此路由，需确认是否保留'
    elif g['path'].startswith('/api/v1/internal/user-api-keys'):
        sev='P1'; detail='凭据契约漂移：FastAPI 只保留 user_id revoke/rotate 与 GET 列表'
    elif g['path'].startswith('/api/v1/notification-settings'):
        sev='P1'; detail='通知设置路径族漂移：FastAPI 基线只暴露 /subscriptions*'
    elif g['path'].startswith('/api/v1/notifications/mark-all-read'):
        sev='P1'; detail='路径漂移：FastAPI 为 /notifications/read-all'
    elif g['path'].startswith('/api/v1/projects/') and ('/move-up' in g['path'] or '/move-down' in g['path']):
        sev='P1'; detail='路径形状变体：FastAPI 为 /projects/{project_id}/move-{direction}'
    elif g['path'].startswith('/api/v1/internal/ad-data'):
        sev='P1'; detail='基础/别名路由不在 OpenAPI，防止前端误接未约定接口'
    else:
        sev='P1'; detail='Go-only route；需确认是否为兼容超集或命名漂移'
    contract_risks.append({'kind':'go_only','severity':sev,'method':g['method'],'path':g['path'],'source':g['source'],'detail':detail})
for x in mismatches:
    contract_risks.append({'kind':'method_mismatch','severity':'P0','method':x['fastapi']['method'],'path':x['fastapi']['path'],'go_methods':x['go_methods'],'source':x['fastapi']['source'],'detail':'同路径存在 Go 路由但 HTTP method 不匹配'})

go_unwired=[r for r in GO['routes'] if not r.get('active')]

summary={
 'fastapi_openapi_paths':len(OPENAPI.get('paths',{})),
 'fastapi_openapi_operations':len(fast),
 'fastapi_agent_operations':sum(1 for r in fast if r['path'].startswith('/api/v1/agent/')),
 'fastapi_supplemental_hidden_operations':len(supp),
 'fastapi_ast_mounted_declarations':AST['mounted_route_count'],
 'go_static_source_operations':len(GO['routes']),
 'go_active_operations':len(go_active),
 'go_active_agent_operations':sum(1 for r in go_active if r['path'].startswith('/api/v1/agent/')),
 'go_source_only_unwired_operations':len(go_unwired),
 'go_source_only_unwired_by_module':dict(Counter(r['module'] for r in go_unwired)),
 'exact_owned_operations':len(owned),
 'missing_operations':len(missing),
 'method_mismatch_paths':len(mismatches),
 'method_mismatch_missing_operations':len(mismatches),
 'go_only_operations':len(extra),
 'go_only_compatibility_extras':len(compat_extra),
 'fastapi_supplemental_hidden_exact_operations':len(hidden_exact),
 'contract_risk_items':len(contract_risks),
 'coverage_percent':round(100*len(owned)/len(fast),3),
 'missing_by_domain':dict(Counter(r['domain'] for r in missing)),
 'owned_by_domain':dict(Counter(r['fastapi']['domain'] for r in owned)),
 'agent_exact_owned':sum(1 for r in owned if r['fastapi']['path'].startswith('/api/v1/agent/')),
 'agent_missing':sum(1 for r in missing if r['path'].startswith('/api/v1/agent/')),
 'agent_method_mismatch':sum(1 for x in mismatches if x['fastapi']['path'].startswith('/api/v1/agent/')),
 'agent_missing_by_scope':dict(Counter(str(r['agent_domain']) for r in missing if r['path'].startswith('/api/v1/agent/'))),
}


p0_domains={'ai_chat','ai_chat_v2','ai_file_upload','ai_chat_usage','ai_insight','insight_runs','insight_domains','insight_observation','uploads','internal_api_keys'}
p0_missing=[r for r in missing if r['path'].startswith('/api/v1/agent/') or r['domain'] in p0_domains]
p0_contract=[r for r in contract_risks if r.get('kind')!='contract_family_drift' and (r.get('severity')=='P0' or r.get('kind') in ('path_param_semantics',))]
summary['p0_missing_operations']=len(p0_missing)
summary['p0_contract_items']=len(p0_contract)
summary['p0_gap_total_operations_or_items']=len(p0_missing)+len(p0_contract)
summary['p0_missing_by_domain']=dict(Counter(('agent' if r['path'].startswith('/api/v1/agent/') else r['domain']) for r in p0_missing))
summary['p0_contract_by_kind']=dict(Counter(r['kind'] for r in p0_contract))

result={
 'metadata':{
   'base_revision':__import__('subprocess').check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
   'openapi_file':'frontend/types/api-generated/openapi.json',
   'openapi_last_commit':__import__('subprocess').check_output(['git','log','-1','--format=%H', '--','frontend/types/api-generated/openapi.json'],cwd=ROOT,text=True).strip(),
   'openapi_last_commit_date':__import__('subprocess').check_output(['git','log','-1','--format=%cI', '--','frontend/types/api-generated/openapi.json'],cwd=ROOT,text=True).strip(),
   'route_sources_changed_since_openapi':int(__import__('subprocess').check_output(['git','rev-list','--count',__import__('subprocess').check_output(['git','log','-1','--format=%H','--','frontend/types/api-generated/openapi.json'],cwd=ROOT,text=True).strip()+'..HEAD','--','backend/app/api/v1','backend/app/main.py'],cwd=ROOT,text=True).strip()),
   'fastapi_authority':'openapi.json',
   'go_authority':'static source parse of internal/api + httpserver/routes.go, active wiring only for ownership',
   'dynamic_param_normalization':'all {name}, {name:int}, {name:path}, {name:[regex]} normalized to {param}',
 },
 'counts':summary,
 'fastapi_routes':fast,
 'go_active_routes':go_active,
 'go_source_only_routes':go_unwired,
 'owned':owned,
 'missing':missing,
 'method_mismatch':mismatches,
 'go_only':extra,
 'go_only_compatibility_extras':compat_extra,
 'fastapi_supplemental_hidden_exact':hidden_exact,
 'contract_risks':contract_risks,
 'p0_missing':p0_missing,
 'p0_contract':p0_contract,
 'supplemental_hidden_fastapi_routes':supp,
}
Path('/tmp/route-manifest-raw.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(summary,ensure_ascii=False,indent=2))
print('unmatched source count',sum(1 for r in fast if not r['source']))
for r in fast:
 if not r['source']: print('NOSOURCE',r['method'],r['path'],r['operation_id'])
print('source match distribution',Counter(r['source_match_count'] for r in fast))
print('duplicate ast source keys',[(k,len(v)) for k,v in ast_by_key.items() if len(v)>1][:20])
