from __future__ import annotations
import ast, json, os, re
from pathlib import Path
from collections import defaultdict, deque
from dataclasses import dataclass, field

ROOT = Path(__file__).resolve().parents[3]
PKG_ROOT = ROOT / 'backend'
ENDPOINTS = PKG_ROOT / 'app/api/v1/endpoints'
ROUTER_PY = PKG_ROOT / 'app/api/v1/router.py'
GROUPS = PKG_ROOT / 'app/api/v1/router_groups'
MAIN = PKG_ROOT / 'app/main.py'

HTTP_METHODS = {'get','post','put','patch','delete','head','options','trace'}

def module_name(path: Path) -> str:
    rel = path.relative_to(PKG_ROOT).with_suffix('')
    parts = list(rel.parts)
    if parts[-1] == '__init__': parts = parts[:-1]
    return '.'.join(parts)

def const_str(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str): return node.value
    return None

def call_name(call: ast.Call):
    f=call.func
    if isinstance(f, ast.Name): return f.id
    if isinstance(f, ast.Attribute): return f.attr
    return None

def kw(call, name, default=None):
    for x in call.keywords:
        if x.arg == name: return x.value
    return default

def dep_names(node):
    names=[]
    if node is None: return names
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            nm=call_name(n)
            if nm in {'Depends','Security'}:
                if n.args:
                    target=n.args[0]
                    if isinstance(target, ast.Name): names.append(target.id)
                    elif isinstance(target, ast.Attribute): names.append(target.attr)
                    elif isinstance(target, ast.Call):
                        cn=call_name(target)
                        if cn: names.append(cn)
                        if cn=='require_business_scope' and target.args and const_str(target.args[0]):
                            names.append('business_scope:'+const_str(target.args[0]))
            elif nm=='require_business_scope' and n.args and const_str(n.args[0]):
                names.append('business_scope:'+const_str(n.args[0]))
    return sorted(set(names), key=names.index)

@dataclass
class RouterDef:
    module: str
    var: str
    path: Path
    prefix: str
    dependencies: tuple[str,...]
    route_count: int=0

@dataclass
class Include:
    parent: str
    child: str|None
    module: str
    line: int
    path: str
    prefix: str
    dependencies: tuple[str,...]
    lazy_module: str|None=None

@dataclass
class RawRoute:
    module: str
    router: str
    method: str
    raw_path: str
    handler: str
    path: Path
    line: int
    decorator: str
    include_in_schema: bool
    dependencies: tuple[str,...]

routers: dict[str,RouterDef]={}
raw_routes: list[RawRoute]=[]
imports: dict[str,dict[str,tuple[str,str]]]=defaultdict(dict)
includes: list[Include]=[]
unparsed_paths=[]

paths = list(ENDPOINTS.rglob('*.py')) + [ROUTER_PY] + list(GROUPS.glob('*.py'))
# Pass 1: all imports (including package re-exports) must exist before include resolution.
for path in paths:
    tree=ast.parse(path.read_text(), filename=str(path))
    mod=module_name(path)
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom):
            source_mod=n.module or ''
            if n.level:
                base_parts=mod.split('.')[:-n.level]
                source_mod='.'.join(base_parts + ([n.module] if n.module else []))
            for a in n.names:
                if a.name!='*':
                    imports[mod][a.asname or a.name]=(source_mod or mod, a.name)
        elif isinstance(n, ast.Import):
            for a in n.names:
                imports[mod][a.asname or a.name.split('.')[0]]=(a.name, a.asname or a.name.split('.')[0])
# Pass 2: router definitions, decorators, and includes.
for path in paths:
    src=path.read_text()
    tree=ast.parse(src, filename=str(path))
    mod=module_name(path)
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom):
            source_mod=n.module or ''
            if n.level:
                base_parts=mod.split('.')
                if mod.endswith('__init__'): pass
                # module id already strips __init__; go up level-1 directories
                base_parts=base_parts[:-n.level]
                source_mod='.'.join(base_parts + ([n.module] if n.module else []))
            for a in n.names:
                if a.name=='*': continue
                imports[mod][a.asname or a.name]=(source_mod or mod, a.name)
        elif isinstance(n, ast.Import):
            for a in n.names:
                imports[mod][a.asname or a.name.split('.')[0]]=(a.name, a.asname or a.name.split('.')[0])
    router_assigns=[]
    for n in tree.body:
        if isinstance(n,(ast.Assign,ast.AnnAssign)):
            targets=n.targets if isinstance(n,ast.Assign) else [n.target]
            value=n.value
            if not isinstance(value, ast.Call) or call_name(value)!='APIRouter': continue
            pfx=const_str(kw(value,'prefix')) or ''
            deps=dep_names(kw(value,'dependencies'))
            for t in targets:
                if isinstance(t,ast.Name):
                    rid=f'{mod}:{t.id}'
                    routers[rid]=RouterDef(mod,t.id,path,pfx,deps)
                    router_assigns.append((t.id,rid))
    # route decorators, only functions in this file's module
    for n in ast.walk(tree):
        if not isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)): continue
        for dec in n.decorator_list:
            if not isinstance(dec,ast.Call) or not isinstance(dec.func,ast.Attribute): continue
            meth=dec.func.attr
            owner=dec.func.value
            if not isinstance(owner,ast.Name) or owner.id not in {x[0] for x in router_assigns}: continue
            if meth not in HTTP_METHODS|{'api_route','websocket'}: continue
            pnode=kw(dec,'path')
            if pnode is None and dec.args: pnode=dec.args[0]
            p=const_str(pnode)
            if p is None:
                unparsed_paths.append({'module':mod,'handler':n.name,'line':getattr(dec,'lineno',n.lineno),'file':str(path.relative_to(ROOT))})
                continue
            if meth=='api_route':
                methods_node=kw(dec,'methods')
                methods=[]
                if isinstance(methods_node,(ast.List,ast.Tuple,ast.Set)):
                    for elt in methods_node.elts:
                        v=const_str(elt)
                        if v: methods.append(v.upper())
                if not methods: methods=['GET']
            elif meth=='websocket':
                methods=['WEBSOCKET']
            else:
                methods=[meth.upper()]
            schema=kw(dec,'include_in_schema',ast.Constant(True))
            schema_val = schema.value if isinstance(schema,ast.Constant) and isinstance(schema.value,bool) else True
            deps=dep_names(kw(dec,'dependencies'))
            function_deps=[]
            pos_args=list(n.args.args)
            pos_defaults=list(n.args.defaults)
            for arg,default in zip(pos_args[len(pos_args)-len(pos_defaults):], pos_defaults):
                if default is not None:
                    function_deps.extend(dep_names(default))
            for arg,default in zip(n.args.kwonlyargs, n.args.kw_defaults):
                if default is not None:
                    function_deps.extend(dep_names(default))
            for d in function_deps:
                if d not in deps:
                    deps.append(d)
            rid=f'{mod}:{owner.id}'
            for m in methods:
                raw_routes.append(RawRoute(mod,rid,m,p,n.name,path,getattr(dec,'lineno',n.lineno),meth,schema_val,deps))
    # include_router calls over all AST (nested not needed)
    for n in ast.walk(tree):
        if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute):
            if n.func.attr=='include_router' and isinstance(n.func.value,ast.Name):
                parent=f'{mod}:{n.func.value.id}'
                if n.args and isinstance(n.args[0],ast.Name):
                    child_alias=n.args[0].id
                    resolve_mod=mod
                    seen_symbols=set()
                    while child_alias in imports[resolve_mod] and (resolve_mod,child_alias) not in seen_symbols:
                        seen_symbols.add((resolve_mod,child_alias))
                        target_mod, target_name=imports[resolve_mod][child_alias]
                        child_candidate=f'{target_mod}:{target_name}'
                        if child_candidate in routers:
                            child=child_candidate
                            break
                        if target_name in imports.get(target_mod,{}):
                            resolve_mod=target_mod
                            child_alias=target_name
                            continue
                        child=child_candidate
                        break
                    else:
                        child=f'{resolve_mod}:{child_alias}'
                    pref=const_str(kw(n,'prefix')) or ''
                    deps=dep_names(kw(n,'dependencies'))
                    includes.append(Include(parent,child,mod,n.lineno,str(path.relative_to(ROOT)),pref,deps))
        if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='include_lazy_router':
            if len(n.args)>=2 and isinstance(n.args[0],ast.Name) and const_str(n.args[1]):
                lazy=const_str(n.args[1])
                includes.append(Include(f'{mod}:{n.args[0].id}',f'{lazy}:router',mod,n.lineno,str(path.relative_to(ROOT)),const_str(kw(n,'prefix')) or '',dep_names(kw(n,'dependencies')),lazy))

# Root mount detected from main.py
root_prefix=''
main_tree=ast.parse(MAIN.read_text(), filename=str(MAIN))
for n in ast.walk(main_tree):
    if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='include_router' and isinstance(n.func.value,ast.Name) and n.func.value.id=='app':
        if n.args and isinstance(n.args[0],ast.Name) and n.args[0].id=='api_router':
            root_prefix=const_str(kw(n,'prefix')) or ''
root_router='app.api.v1.router:api_router'

# Traverse mounted router graph.
def join_path(*parts):
    s=''
    for p in parts:
        if not p: continue
        if not s: s=p
        else: s=s.rstrip('/')+'/'+p.lstrip('/')
    return s
if root_prefix:
    root_prefix=root_prefix.rstrip('/')

mounted=[]; edge_issues=[]; unmounted_edges=[]
incoming=defaultdict(int)
for e in includes:
    if e.child: incoming[e.child]+=1
seen_routers=set()

def traverse(rid, mount_path, inherited_deps, agent_ctx=False, domain=None, stack=()):
    if rid in stack:
        edge_issues.append({'type':'cycle','router':rid,'path':mount_path})
        return
    if rid not in routers:
        edge_issues.append({'type':'missing_router','router':rid,'path':mount_path})
        return
    r=routers[rid]
    seen_routers.add(rid)
    base=join_path(mount_path, r.prefix)
    deps=list(inherited_deps)
    for d in r.dependencies:
        if d not in deps: deps.append(d)
    base_segments=[x for x in base.split('/') if x]
    if base_segments[-1:] == ['agent'] or r.module == 'app.api.v1.endpoints.agent' or r.module.startswith('app.api.v1.endpoints.agent.'):
        agent_ctx=True
    scopes=[d for d in deps if d.startswith('business_scope:')]
    if scopes: domain=scopes[-1].split(':',1)[1]
    for rr in raw_routes:
        if rr.router!=rid: continue
        effdeps=list(deps)
        for d in rr.dependencies:
            if d not in effdeps: effdeps.append(d)
        route_path=join_path(base, rr.raw_path)
        if root_prefix and not route_path.startswith(root_prefix+'/'):
            route_path=join_path(root_prefix, route_path)
        mounted.append({**rr.__dict__, 'router_def':rid,'path':route_path,'mount_path':base,'deps':effdeps,'agent':agent_ctx,'domain':domain,'source':f'{rr.path.relative_to(ROOT)}:{rr.line}'})
    for e in includes:
        if e.parent!=rid: continue
        if not e.child:
            continue
        child_path=join_path(base,e.prefix)
        child_deps=list(effdeps) if False else list(deps)
        for d in e.dependencies:
            if d not in child_deps: child_deps.append(d)
        traverse(e.child,child_path,child_deps,agent_ctx,domain,stack+(rid,))

traverse(root_router,root_prefix,[],False,None,())

# de-dupe accidental duplicated traversal mounts? Keep every mount; actual duplicate route registrations are distinct. But report duplicate exact method+path+handler.
unmounted_routes=[]
for rr in raw_routes:
    if rr.router not in seen_routers:
        unmounted_routes.append({**rr.__dict__,'source':f'{rr.path.relative_to(ROOT)}:{rr.line}'})

# classify auth
def classify(route):
    path=route['path']; deps=route['deps']; agent=route['agent']
    if agent:
        if 'path:path' in route['raw_path']:
            return 'agent_api_key','namespace_fallback'
        return 'agent_api_key', route.get('domain') or 'shared'
    if any(d.startswith('business_scope:') for d in deps):
        return 'agent_api_key', route.get('domain') or 'shared'
    if path in {'/api/v1/health/live','/api/v1/health/ready','/api/v1/auth/login'}:
        return 'public','public'
    if path.startswith('/api/v1/external/'):
        return 'public','retired_fallback'
    if path == '/api/v1/auth/me':
        return 'session_headers','dashboard'
    admin=any(x in {'require_admin','_require_admin'} for x in deps)
    internal=path.startswith('/api/v1/internal/') or path.startswith('/api/v1/agent-ops/')
    if internal:
        return ('internal_api_key+admin' if admin else 'internal_api_key'),'internal'
    session=any(x in {'_require_session','require_session','get_current_user','require_user'} for x in deps)
    if session:
        return ('api_key+session' if any(x in {'protected','require_api_key'} for x in deps) else 'session'),'dashboard'
    api_key=any(x in {'protected','require_api_key'} for x in deps)
    if api_key:
        return ('api_key+admin' if admin else 'api_key'),'dashboard'
    if admin:
        return 'api_key+admin','dashboard'
    return 'custom','dashboard'
for r in mounted:
    r['auth'],r['agent_domain']=classify(r)
    r['contract_eligible']=not ('path:path' in r['raw_path'] or r['raw_path'].endswith('/*'))

# Duplicate records within same mount
dup_counts=defaultdict(int)
for r in mounted: dup_counts[(r['method'],r['path'],r['handler'])]+=1
for r in mounted:
    r['duplicate_registration']=dup_counts[(r['method'],r['path'],r['handler'])]>1

result={
 'generated_from':str(ROOT),
 'root_prefix':root_prefix,
 'router_def_count':len(routers),
 'raw_route_declarations':len(raw_routes),
 'mounted_route_count':len(mounted),
 'comparable_route_count':sum(1 for r in mounted if r['contract_eligible']),
 'unmounted_route_declarations':len(unmounted_routes),
 'unparsed_path_declarations':len(unparsed_paths),
 'seen_router_count':len(seen_routers),
 'agent_route_count':sum(1 for r in mounted if r['agent']),
 'agent_contract_route_count':sum(1 for r in mounted if r['agent'] and r['contract_eligible']),
 'routes':mounted,
 'unmounted_routes':unmounted_routes,
 'unparsed_paths':unparsed_paths,
 'edge_issues':edge_issues,
 'router_defs':[({k:getattr(v,k) for k in ('module','var','prefix','dependencies')} | {'source':f'{v.path.relative_to(ROOT)}'}) for v in routers.values()],
 'includes':[{**e.__dict__}|{'source':e.path} for e in includes],
}
Path('/tmp/fastapi-routes.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str))
print(json.dumps({k:result[k] for k in ('root_prefix','router_def_count','raw_route_declarations','mounted_route_count','comparable_route_count','unmounted_route_declarations','unparsed_path_declarations','seen_router_count','agent_route_count','agent_contract_route_count')},indent=2))
print('edge issues',edge_issues[:20])
print('unparsed',unparsed_paths[:20])
print('unmounted routers',sorted(set(r['router'] for r in unmounted_routes)))
