from __future__ import annotations
from pathlib import Path
from collections import Counter
import re,json,os

# ROUTE_AUDIT_ROOT lets the offline self-check run the parser against a
# synthetic source tree; ROUTE_AUDIT_GO_OUT redirects the parsed route JSON.
DEFAULT_ROOT=Path(__file__).resolve().parents[3]
ROOT=Path(os.environ.get('ROUTE_AUDIT_ROOT') or DEFAULT_ROOT).resolve()
GO_OUT=Path(os.environ.get('ROUTE_AUDIT_GO_OUT') or '/tmp/go-routes.json')
FILES=sorted([p for base in ['backend-go/internal/api','backend-go/internal/httpserver/routes.go'] for p in ((ROOT/base).rglob('*.go') if (ROOT/base).is_dir() else [ROOT/base]) if not p.name.endswith('_test.go')])

HTTP_SELECTORS={'Get':'GET','Post':'POST','Put':'PUT','Patch':'PATCH','Delete':'DELETE','Head':'HEAD','Options':'OPTIONS','Trace':'TRACE'}
UNWIRED_HINT='cmd/gateway/dependencies.go 未构造该模块 registrar（GO_API_OWNED 无对应接线），路由当前只能走 FastAPI fallback'
REQUIRED_AGENT_MOUNT_FILE='backend-go/internal/httpserver/routes.go'
DEFAULT_AGENT_SCOPES={
'agent_monthly_reports':'monthly_reports',
}

def module_dir(path:Path):
    try: rel=path.relative_to(ROOT/'backend-go/internal/api')
    except ValueError: return 'httpserver/routes.go'
    return rel.parts[0] if len(rel.parts)>=2 else 'httpserver/routes.go'

def mask_comments(s):
    out=list(s); i=0; quote=None; esc=False; line=False; block=False
    while i<len(s):
        ch=s[i]; nxt=s[i+1] if i+1<len(s) else ''
        if line:
            if ch=='\n': line=False
            else: out[i]=' '
        elif block:
            if ch=='*' and nxt=='/': out[i]=out[i+1]=' '; block=False; i+=1
            else: out[i]=' '
        elif quote:
            if esc: esc=False
            elif ch=='\\': esc=True
            elif ch==quote: quote=None
        else:
            if ch=='/' and nxt=='/': out[i]=out[i+1]=' '; line=True; i+=1
            elif ch=='/' and nxt=='*': out[i]=out[i+1]=' '; block=True; i+=1
            elif ch in ('"','`'): quote=ch
        i+=1
    return ''.join(out)

def mask_strings(s):
    out=list(s); i=0; quote=None; esc=False
    while i<len(s):
        ch=s[i]
        if quote:
            if ch=='\n': pass
            else: out[i]=' '
            if esc: esc=False
            elif ch=='\\': esc=True
            elif ch==quote: quote=None; out[i]=' '
        else:
            if ch in ('"','`'):
                quote=ch; out[i]=' '
        i+=1
    return ''.join(out)

def find_close(s, open_pos, open_ch='{', close_ch='}'):
    depth=0; i=open_pos; quote=None; esc=False
    while i<len(s):
        ch=s[i]
        if quote:
            if esc: esc=False
            elif ch=='\\': esc=True
            elif ch==quote: quote=None
        else:
            if ch in ('"','`'): quote=ch
            elif ch==open_ch: depth+=1
            elif ch==close_ch:
                depth-=1
                if depth==0: return i
        i+=1
    return -1

def split_top(s, sep=','):
    parts=[]; start=0; depth=0; quote=None; esc=False
    for i,ch in enumerate(s):
        if quote:
            if esc: esc=False
            elif ch=='\\': esc=True
            elif ch==quote: quote=None
        else:
            if ch in ('"','`'): quote=ch
            elif ch in '([{': depth+=1
            elif ch in ')]}': depth-=1
            elif ch==sep and depth==0:
                parts.append(s[start:i].strip()); start=i+1
    parts.append(s[start:].strip())
    return parts

def extract_calls(text):
    pat=re.compile(r'\.\s*(Get|Post|Put|Patch|Delete|Head|Options|Trace|Method|route)\s*\(')
    calls=[]
    for m in pat.finditer(text):
        i=m.end(); depth=1; quote=None; esc=False
        while i<len(text) and depth:
            ch=text[i]
            if quote:
                if esc: esc=False
                elif ch=='\\': esc=True
                elif ch==quote: quote=None
            else:
                if ch in ('"','`'): quote=ch
                elif ch=='(': depth+=1
                elif ch==')': depth-=1
            i+=1
        calls.append({'selector':m.group(1),'args':split_top(text[m.end():i-1]),'start':m.start(),'end':i,'line':text.count('\n',0,m.start())+1})
    return calls

def go_str(expr):
    expr=expr.strip()
    if len(expr)>=2 and expr[0]=='"' and expr[-1]=='"':
        raw=expr[1:-1].replace('\\"','"').replace('\\\\','\\')
        return raw
    if len(expr)>=2 and expr[0]=='`' and expr[-1]=='`': return expr[1:-1]
    return None

def eval_path(expr, env):
    parts=split_top(expr,'+')
    vals=[]
    for p in parts:
        p=p.strip(); lit=go_str(p)
        if lit is not None: vals.append(lit); continue
        if re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*',p):
            obj=env; ok=True
            for key in p.split('.'):
                if isinstance(obj,dict) and key in obj: obj=obj[key]
                elif key in env: obj=env[key]
                else: ok=False; break
            if ok and isinstance(obj,str): vals.append(resolve_scalar(obj,env)); continue
        return None
    return ''.join(vals)

def eval_method(expr, env):
    mm={'http.MethodGet':'GET','http.MethodPost':'POST','http.MethodPut':'PUT','http.MethodPatch':'PATCH','http.MethodDelete':'DELETE','http.MethodHead':'HEAD','http.MethodOptions':'OPTIONS','http.MethodTrace':'TRACE',
        '"GET"':'GET','"POST"':'POST','"PUT"':'PUT','"PATCH"':'PATCH','"DELETE"':'DELETE','"HEAD"':'HEAD','"OPTIONS"':'OPTIONS','"TRACE"':'TRACE',
        'GET':'GET','POST':'POST','PUT':'PUT','PATCH':'PATCH','DELETE':'DELETE','HEAD':'HEAD','OPTIONS':'OPTIONS','TRACE':'TRACE'}
    expr=expr.strip()
    if expr in mm: return mm[expr]
    if expr in env and isinstance(env[expr],str): return eval_method(resolve_scalar(env[expr],env),env)
    return None

def join_path(base,p):
    if not base: return p
    if p.startswith(base.rstrip('/')+'/'): return p
    return base.rstrip('/')+'/'+p.lstrip('/')

def parse_global_literals(text):
    env={}
    pat=r'(?m)^\s*(?:(?:const|var)\s+)?([A-Za-z_]\w*)\s*(?::=|=)\s*("(?:[^"\\]|\\.)*"|`[^`]*`)\s*$'
    for m in re.finditer(pat,text):
        v=go_str(m.group(2))
        if v is not None: env[m.group(1)]=v
    return env

def resolve_scalar(value, env):
    if not isinstance(value,str): return value
    lit=go_str(value)
    if lit is not None: return lit
    value=value.strip()
    if re.fullmatch(r'[A-Za-z_]\w*',value) and value in env:
        return resolve_scalar(env[value],env)
    return value

def find_for_body_brace(text,start):
    paren=bracket=0; quote=None; esc=False; i=start
    first_brace=None
    while i<len(text):
        ch=text[i]
        if quote:
            if esc: esc=False
            elif ch=='\\': esc=True
            elif ch==quote: quote=None
        else:
            if ch in ('"','`'): quote=ch
            elif ch=='(': paren+=1
            elif ch==')': paren=max(0,paren-1)
            elif ch=='[': bracket+=1
            elif ch==']': bracket=max(0,bracket-1)
            elif ch=='{' and paren==0 and bracket==0:
                if first_brace is None and '[]string' in text[start:i]:
                    first_brace=i
                    close=find_close(text,i)
                    if close<0: return -1
                    j=close+1
                    while j<len(text) and text[j].isspace(): j+=1
                    return j if j<len(text) and text[j]=='{' else i
                return i
        i+=1
    return -1

def parse_string_slice(expr):
    lb=expr.find('{'); rb=expr.rfind('}')
    if lb<0 or rb<0: return []
    return [go_str(x) for x in split_top(expr[lb+1:rb]) if go_str(x) is not None]

def parse_map_keys(text,var):
    m=re.search(r'\b'+re.escape(var)+r'\s*:=\s*map\[string\]string\s*\{',text)
    if not m: return []
    end=find_close(text,m.end()-1)
    return re.findall(r'"([^"]+)"\s*:',text[m.end():end])

def parse_struct_rows(text,var):
    m=re.search(r'\b'+re.escape(var)+r'\s*:=\s*\[\][A-Za-z_]\w*\s*\{',text)
    if not m: return []
    end=find_close(text,m.end()-1); body=text[m.end():end]
    rows=[]; i=0
    while i<len(body):
        if body[i]=='{':
            e=find_close(body,i); parts=split_top(body[i+1:e])
            rows.append([go_str(x) if go_str(x) is not None else x.strip() for x in parts]); i=e+1
        else: i+=1
    return rows

def struct_fields(text,typename):
    m=re.search(r'type\s+'+re.escape(typename)+r'\s+struct\s*\{',text)
    if not m: return []
    end=find_close(text,m.end()-1); fields=[]
    for line in text[m.end():end].splitlines():
        fm=re.match(r'\s*([A-Za-z_]\w*)\s+',line)
        if fm: fields.append(fm.group(1))
    return fields

def group_ranges(text):
    groups=[]
    for m in re.finditer(r'\.Route\s*\(\s*("(?:[^"\\]|\\.)*")\s*,\s*func\s*\(',text):
        prefix=go_str(m.group(1)); brace=text.find('{',m.end()); end=find_close(text,brace)
        groups.append((m.start(),end,prefix))
    return groups

def group_for_pos(groups,pos):
    candidates=[g for g in groups if g[0]<=pos<=g[1]]
    return max(candidates,key=lambda g:g[0])[2] if candidates else ''

def pos_in_ranges(ranges,pos): return any(a<=pos<=b for a,b in ranges)

# ---------------------------------------------------------------------------
# Wiring gate: a module is "active" only when cmd/gateway/dependencies.go
# actually constructs its registrar (or httpserver/routes.go wires it as a
# built-in), never because its directory merely contains routes. This keeps
# route parity honest: a registrar that is never constructed is reported as
# source-only instead of silently counting as wired.
# ---------------------------------------------------------------------------
MODULE_CONST_RE=re.compile(r'(?m)^\s*(Module[A-Za-z0-9_]+)\s*=\s*"([^"]+)"')
OWNED_KEY_RE=re.compile(r'OwnedModules\s*\[\s*(?:"([^"]+)"|([A-Za-z_][\w.]*))\s*\]')
REGISTRAR_RE=re.compile(r'\b([a-z][a-z0-9_]*)\.NewRegistrar\w*\s*\(')
AGENT_MOUNT_RE=re.compile(r'\.(?:Route|Mount)\s*\(\s*"([^"]*)"')
AGENT_REGISTRAR_METHOD_RE=re.compile(r'func\s*\([^)]*\)\s*RegisterAgentRoutes\s*\(')
VALIDATE_FUNC_RE=re.compile(r'func\s+validate\w*\s*\(')

def _read_text(path):
    try: return path.read_text(encoding='utf-8')
    except OSError: return ''

def _module_constants():
    return dict(MODULE_CONST_RE.findall(_read_text(ROOT/'backend-go/internal/config/config.go')))

def _owned_keys(text,constants):
    keys=[]
    for m in OWNED_KEY_RE.finditer(text):
        if m.group(1): keys.append(m.group(1)); continue
        name=m.group(2).split('.')[-1]
        if name in constants: keys.append(constants[name])
    return keys

def _module_dirs():
    base=ROOT/'backend-go/internal/api'
    return sorted({p.name for p in base.iterdir() if p.is_dir()}) if base.is_dir() else []

def _runtime_gated_modules(constants):
    """Owned-module keys rejected by validate* startup guards (e.g. P1-2 gate)."""
    text=mask_comments(_read_text(ROOT/'backend-go/cmd/gateway/dependencies.go'))
    gated=set()
    for m in VALIDATE_FUNC_RE.finditer(text):
        brace=text.find('{',m.end())
        if brace<0: continue
        end=find_close(text,brace)
        if end<0: continue
        gated.update(_owned_keys(text[m.end():end+1],constants))
    return sorted(gated)

def parse_wiring():
    dirs=set(_module_dirs()); constants=_module_constants()
    deps=mask_comments(_read_text(ROOT/'backend-go/cmd/gateway/dependencies.go'))
    routes=mask_comments(_read_text(ROOT/'backend-go/internal/httpserver/routes.go'))
    gateway_wired={alias for alias in REGISTRAR_RE.findall(deps) if alias in dirs}
    if re.search(r'\bnewWorkflowRegistrar\s*\(',deps): gateway_wired.add('workflows')
    builtin_wired={key for key in _owned_keys(routes,constants) if key in dirs}
    mounts=[]
    for path in sorted((ROOT/'backend-go').rglob('*.go')):
        if path.name.endswith('_test.go'): continue
        text=mask_comments(_read_text(path))
        for m in AGENT_MOUNT_RE.finditer(text):
            if m.group(1).rstrip('/')!='/api/v1/agent': continue
            mounts.append({'file':str(path.relative_to(ROOT)),'line':text.count('\n',0,m.start())+1})
    central_mounts=[m for m in mounts if m['file']==REQUIRED_AGENT_MOUNT_FILE]
    unsafe_mounts=[m for m in mounts if m['file']!=REQUIRED_AGENT_MOUNT_FILE]
    return {
      'gateway_wired_modules':sorted(gateway_wired),
      'builtin_wired_modules':sorted(builtin_wired),
      'wired_modules':sorted(gateway_wired|builtin_wired),
      'runtime_gated_modules':_runtime_gated_modules(constants),
      'agent_subrouter_central_mounts':central_mounts,
      'agent_subrouter_standalone_mounts':unsafe_mounts,
      'duplicate_agent_subrouter_mounts':central_mounts[1:]+unsafe_mounts,
    }

WIRING=parse_wiring()
WIRED_MODULES=set(WIRING['wired_modules'])
# Agent modules expose RegisterAgentRoutes; the central httpserver mount adds
# the /api/v1/agent prefix, so their relative registrations must be prefixed.
AGENT_MODULE_DIRS={module_dir(path) for path in FILES if AGENT_REGISTRAR_METHOD_RE.search(mask_comments(_read_text(path)))}
RECORDS=[]; UNRESOLVED=[]

def route_guards(text, abs_pos):
    prefix=text[max(0,abs_pos-900):abs_pos]
    w=prefix.rfind('.With(')
    chain=prefix[w:] if w>=0 else prefix
    scopes=re.findall(r'RequireBusinessScope\s*\(\s*"([^"]+)"\s*\)',chain)
    project_scope='RequireProjectScope' in chain
    return (scopes[-1] if scopes else None), project_scope
def emit_call(call, offset, env, path, groups, diagnostic=False, source_line=None):
    selector=call['selector']; method=None
    explicit_scope=None
    if selector in HTTP_SELECTORS: method=HTTP_SELECTORS[selector]; path_expr=call['args'][0] if call['args'] else ''; handler=call['args'][1] if len(call['args'])>1 else ''
    elif selector=='Method': method=eval_method(call['args'][0],env) if call['args'] else None; path_expr=call['args'][1] if len(call['args'])>1 else ''; handler=call['args'][2] if len(call['args'])>2 else ''
    elif selector=='route':
        method=eval_method(call['args'][1],env) if len(call['args'])>1 else None
        path_expr=call['args'][2] if len(call['args'])>2 else ''
        explicit_scope=go_str(call['args'][3]) if len(call['args'])>3 else None
        handler=call['args'][-1] if call['args'] else ''
    else: return
    p=eval_path(path_expr,env)
    if p is None:
        if diagnostic and ('/' in path_expr or '+' in path_expr):
            UNRESOLVED.append({'file':str(path.relative_to(ROOT)),'line':call['line'],'selector':selector,'expr':path_expr,'reason':'unresolved path expression'})
        return
    if method is None:
        if diagnostic: unresolved.append({'file':str(path.relative_to(ROOT)),'line':call['line'],'selector':selector,'expr':path_expr,'reason':'unresolved method'})
        return
    prefix=env.get('__group_prefix', group_for_pos(groups,offset+call['start']))
    full=join_path(prefix,p)
    if not full.startswith('/api/v1'): return
    mod=module_dir(path)
    active=mod in ACTIVE_DIRS or mod=='httpserver/routes.go'
    handler_value=handler.strip()
    if re.fullmatch(r'[A-Za-z_]\w*',handler_value) and handler_value in env:
        handler_value=resolve_scalar(env[handler_value],env)
    actual_line=source_line if source_line is not None else (text.count('\n',0,offset+call['start'])+1 if offset else call['line'])
    seq, project_guard=route_guards(text,offset+call['start'])
    if explicit_scope is not None:
        seq=explicit_scope
    if full.startswith('/api/v1/agent/'):
        auth='agent_api_key'
        agent_domain=seq or DEFAULT_AGENT_SCOPES.get(mod) or ('shared' if full in ('/api/v1/agent/health','/api/v1/agent/projects') else 'unscoped')
    elif full in ('/api/v1/health/live','/api/v1/health/ready','/api/v1/auth/login'):
        auth='public'; agent_domain=None
    else:
        auth='api_key'; agent_domain=None
    records.append({'method':method,'path':full,'handler':handler_value,'file':str(path.relative_to(ROOT)),'line':actual_line,'module':mod,'active':active,'auth':auth,'agent_domain':agent_domain,'project_scope_guard':project_guard})

for path in FILES:
    raw=path.read_text(); text=mask_comments(raw); code=mask_strings(text); env0=parse_global_literals(text); groups=group_ranges(text)
    calls=extract_calls(text); non_direct=[]
    # loops
    for lm in re.finditer(r'\bfor\b',code):
        brace=find_for_body_brace(code,lm.end())
        if brace<0: continue
        header=text[lm.end():brace].strip(); end=find_close(text,brace); body=text[brace+1:end]
        non_direct.append((lm.start(),end))
        m_prefix=re.match(r'_\s*,\s*([A-Za-z_]\w*)\s*:=\s*range\s+\[\]string\s*\{',header)
        if m_prefix:
            vals=parse_string_slice(header)
            for val in vals:
                env=dict(env0); env[m_prefix.group(1)]=val
                for c in extract_calls(body): emit_call(c,brace+1,env,path,groups,True)
        m_method=re.match(r'_\s*,\s*([A-Za-z_]\w*)\s*:=\s*range\s+\[\]string\s*\{(.*)\}\s*$',header,re.S)
        if m_method:
            lb=header.find('{'); rb=header.rfind('}')
            vals=split_top(header[lb+1:rb]) if lb>=0 and rb>=0 else []
            for val in vals:
                method=eval_method(val,{})
                if method:
                    env=dict(env0); env[m_method.group(1)]=method
                    for c in extract_calls(body): emit_call(c,brace+1,env,path,groups,True)
        m_map=re.match(r'([A-Za-z_]\w*)\s*:=\s*range\s+([A-Za-z_]\w*)',header)
        if m_map and 'endpoints' in header:
            keys=parse_map_keys(text,m_map.group(2))
            for key in keys:
                env=dict(env0); env[m_map.group(1)]=key
                for c in extract_calls(body): emit_call(c,brace+1,env,path,groups,True)
        m_struct=re.match(r'_\s*,\s*([A-Za-z_]\w*)\s*:=\s*range\s+([A-Za-z_]\w*)',header)
        if m_struct and m_struct.group(2)!='endpoints':
            rows=parse_struct_rows(text,m_struct.group(2)); fields=struct_fields(text,'adRoute') if rows and len(rows[0])==4 else []
            cond=re.search(r'if\s+'+re.escape(m_struct.group(1))+r'\.rawSingular\s*!=\s*""',body)
            cond_range=None
            if cond:
                bb=body.find('{',cond.start()); ee=find_close(body,bb); cond_range=(bb+1,ee)
            for row in rows:
                rv={f:v for f,v in zip(fields,row)} if fields and len(fields)==len(row) else {'__row':row}
                env=dict(env0); env[m_struct.group(1)]=rv
                if path.name=='registrar.go' and 'internal/api/agent/' in str(path):
                    env['__group_prefix']='/api/v1/agent'
                for c in extract_calls(body):
                    if cond_range and cond_range[0]<=c['start']<=cond_range[1] and not rv.get('rawSingular',''):
                        continue
                    emit_call(c,brace+1,env,path,groups,True)
    # closure definitions and calls
    closures={}
    for cm in re.finditer(r'([A-Za-z_]\w*)\s*:=\s*func\s*\(([^)]*)\)',code):
        name=cm.group(1); params=[x.strip().split()[0] for x in split_top(cm.group(2)) if x.strip()]
        brace=text.find('{',cm.end()); end=find_close(text,brace)
        closures[name]={'params':params,'body':text[brace+1:end],'body_start':brace+1,'start':cm.start(),'end':end}
        non_direct.append((cm.start(),end))
    for name,cl in closures.items():
        for m in re.finditer(r'\b'+re.escape(name)+r'\s*\(',code):
            if cl['start']<=m.start()<=cl['end']: continue
            i=m.end(); depth=1; quote=None; esc=False
            while i<len(text) and depth:
                ch=text[i]
                if quote:
                    if esc: esc=False
                    elif ch=='\\': esc=True
                    elif ch==quote: quote=None
                else:
                    if ch in ('"','`'): quote=ch
                    elif ch=='(': depth+=1
                    elif ch==')': depth-=1
                i+=1
            args=split_top(text[m.end():i-1]); env=dict(env0)
            for idx,pname in enumerate(cl['params']):
                env[pname]=args[idx] if idx<len(args) else ''
            env['__group_prefix']=group_for_pos(groups,m.start())
            switch_ranges=[]
            sw=re.search(r'switch\s+([A-Za-z_]\w*)\s*\{',cl['body'])
            if sw and sw.group(1) in env:
                switch_method=eval_method(env[sw.group(1)],env)
                sw_open=sw.end()-1; sw_end=find_close(cl['body'],sw_open)
                case_matches=list(re.finditer(r'case\s+(http\.Method[A-Za-z]+|"[A-Z]+")\s*:',cl['body'][sw_open+1:sw_end]))
                for idx,cmatch in enumerate(case_matches):
                    case_start=sw_open+1+cmatch.end()
                    case_end=(sw_open+1+case_matches[idx+1].start()) if idx+1<len(case_matches) else sw_end
                    case_method=eval_method(cmatch.group(1),{})
                    switch_ranges.append((case_start,case_end,case_method))
            for c in extract_calls(cl['body']):
                if switch_ranges:
                    containing=[x for x in switch_ranges if x[0]<=c['start']<=x[1]]
                    if containing and containing[0][2]!=switch_method: continue
                emit_call(c,cl['body_start'],env,path,groups,True,text.count('\n',0,m.start())+1)
    # base direct calls
    for c in calls:
        if pos_in_ranges(non_direct,c['start']): continue
        emit_call(c,0,dict(env0),path,groups,True)

# registerAdRoutes executes only under /api/v1/agent group.
for r in records:
    if r['file'].endswith('backend-go/internal/api/agent/registrar.go') and r['line']>150 and not r['path'].startswith('/api/v1/agent/'):
        r['path']='/api/v1/agent'+r['path']

# Deduplicate exact static expansions.
seen=set(); final=[]
for r in records:
    key=(r['method'],r['path'],r['handler'],r['file'],r['line'])
    if key in seen: continue
    seen.add(key); final.append(r)

# Add source status and risk notes.
for r in final:
    r['source']=f"{r['file']}:{r['line']}"
    if r['path'].endswith('/*'):
        if r['path'].startswith('/api/v1/shipping-plan/skus/'):
            r['match_path']='/api/v1/shipping-plan/skus/{sku}/growth-factor'
        else:
            r['match_path']=r['path'][:-1]+'{}'
    r['registration_status']='active' if r['active'] else 'source_only_unwired'
    if not r['active']: r['risk']=UNWIRED_HINTS.get(r['module'],'未接入 cmd/gateway/dependencies.go')

active=[r for r in final if r['active']]
source_only=[r for r in final if not r['active']]
result={
 'go_total_static_routes':len(final),
 'go_active_route_count':len(active),
 'go_source_only_unwired_route_count':len(source_only),
 'go_agent_active_route_count':sum(1 for r in active if r['path'].startswith('/api/v1/agent/')),
 'active_by_module':dict(Counter(r['module'] for r in active)),
 'source_only_by_module':dict(Counter(r['module'] for r in source_only)),
 'routes':final,
 'unresolved_route_like_calls':unresolved,
}
Path('/tmp/go-routes.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({k:result[k] for k in ('go_total_static_routes','go_active_route_count','go_source_only_unwired_route_count','go_agent_active_route_count','active_by_module','source_only_by_module')},ensure_ascii=False,indent=2))
print('unresolved',len(unresolved))
for u in unresolved[:50]: print(u)
