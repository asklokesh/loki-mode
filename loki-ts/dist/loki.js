// @bun
var QQ=Object.defineProperty;var ZQ=($)=>$;function zQ($,Q){this[$]=ZQ.bind(null,Q)}var b=($,Q)=>{for(var Z in Q)QQ($,Z,{get:Q[Z],enumerable:!0,configurable:!0,set:zQ.bind(Q,Z)})};var L=($,Q)=>()=>($&&(Q=$($=0)),Q);var q$=import.meta.require;var h1={};b(h1,{lokiDir:()=>P,homeLokiDir:()=>i$,findRepoRootForVersion:()=>t$,REPO_ROOT:()=>g});import{resolve as a,dirname as r$}from"path";import{fileURLToPath as XQ}from"url";import{existsSync as R$}from"fs";import{homedir as KQ}from"os";function qQ(){let $=b1;for(let Q=0;Q<6;Q++){if(R$(a($,"VERSION"))&&R$(a($,"autonomy/run.sh")))return $;let Z=r$($);if(Z===$)break;$=Z}return a(b1,"..","..","..")}function t$($){let Q=$;for(let Z=0;Z<6;Z++){if(R$(a(Q,"VERSION"))&&R$(a(Q,"autonomy/run.sh")))return Q;let z=r$(Q);if(z===Q)break;Q=z}return a($,"..","..","..")}function P(){return process.env.LOKI_DIR??a(process.cwd(),".loki")}function i$(){return a(KQ(),".loki")}var b1,g;var C=L(()=>{b1=r$(XQ(import.meta.url));g=qQ()});import{readFileSync as VQ}from"fs";import{resolve as JQ,dirname as UQ}from"path";import{fileURLToPath as WQ}from"url";function E$(){if(Q$!==null)return Q$;let $="7.83.1";if(typeof $==="string"&&$.length>0)return Q$=$,Q$;try{let Q=UQ(WQ(import.meta.url)),Z=t$(Q);Q$=VQ(JQ(Z,"VERSION"),"utf-8").trim()}catch{Q$="unknown"}return Q$}var Q$=null;var e$=L(()=>{C()});var g1={};b(g1,{runOrThrow:()=>HQ,run:()=>F,readStreamCapped:()=>m1,commandVersion:()=>BQ,commandExists:()=>f,ShellError:()=>$1,MAX_STDOUT_BYTES:()=>v1});async function m1($,Q=v1){let Z=$.getReader(),z=new TextDecoder,X="",q=0;try{while(q<Q){let{done:K,value:U}=await Z.read();if(K)break;if(!U)continue;if(q+=U.byteLength,q>Q){let J=U.byteLength-(q-Q);X+=z.decode(U.subarray(0,J),{stream:!0});break}X+=z.decode(U,{stream:!0})}X+=z.decode()}finally{try{await Z.cancel()}catch{}Z.releaseLock()}return X}async function F($,Q={}){let Z=Bun.spawn({cmd:[...$],stdout:"pipe",stderr:"pipe",env:Q.env?{...process.env,...Q.env}:process.env,cwd:Q.cwd}),z,X;if(Q.timeoutMs&&Q.timeoutMs>0)z=setTimeout(()=>{try{Z.kill("SIGTERM")}catch{}X=setTimeout(()=>{try{Z.kill("SIGKILL")}catch{}},2000)},Q.timeoutMs);try{let[q,K,U]=await Promise.all([m1(Z.stdout),new Response(Z.stderr).text(),Z.exited]);return{stdout:q,stderr:K,exitCode:U}}finally{if(z)clearTimeout(z);if(X)clearTimeout(X)}}async function HQ($,Q={}){let Z=await F($,Q);if(Z.exitCode!==0)throw new $1(`command failed (${Z.exitCode}): ${$.join(" ")}`,Z.exitCode,Z.stdout,Z.stderr);return Z}async function f($){let Q=GQ($),Z=await F(["sh","-c",`command -v ${Q}`],{timeoutMs:5000});if(Z.exitCode===0)return Z.stdout.trim()||null;return null}function GQ($){if(!/^[A-Za-z0-9._/-]+$/.test($))throw Error(`refused to shell-escape suspect token: ${$}`);return $}async function BQ($,Q="--version"){if(!await f($))return null;let z=await F([$,Q],{timeoutMs:5000});if(z.exitCode!==0)return null;return((z.stdout||z.stderr).split(/\r?\n/)[0]?.trim()??"")||null}var v1=16777216,$1;var d=L(()=>{$1=class $1 extends Error{message;exitCode;stdout;stderr;constructor($,Q,Z,z){super($);this.message=$;this.exitCode=Q;this.stdout=Z;this.stderr=z;this.name="ShellError"}}});function s($){return YQ?"":$}var YQ,O,S,_,_Z,I,k,h,V;var c=L(()=>{YQ=(process.env.NO_COLOR??"").length>0;O=s("\x1B[0;31m"),S=s("\x1B[0;32m"),_=s("\x1B[1;33m"),_Z=s("\x1B[0;34m"),I=s("\x1B[0;36m"),k=s("\x1B[1m"),h=s("\x1B[2m"),V=s("\x1B[0m")});import{existsSync as jQ}from"fs";async function Z$(){if(Y$!==void 0)return Y$;let $="/opt/homebrew/bin/python3.12";if(jQ($))return Y$=$,$;let Q=await f("python3.12");if(Q)return Y$=Q,Q;let Z=await f("python3");return Y$=Z,Z}async function z$($,Q={}){let Z=await Z$();if(!Z)return{stdout:"",stderr:"python3 not found",exitCode:127};return F([Z,"-c",$],Q)}var Y$;var V$=L(()=>{d()});var X0={};b(X0,{runStatus:()=>oQ});import{existsSync as y,readFileSync as U$,readdirSync as r1,statSync as t1}from"fs";import{resolve as D,basename as vQ}from"path";import{homedir as mQ}from"os";function i1($){let Q=Math.trunc($);if(Q>=1e6)return`${(Math.trunc(Q/1e6*10)/10).toFixed(1)}M`;if(Q>=1000)return`${(Math.trunc(Q/1000*10)/10).toFixed(1)}K`;return String(Q)}function e1($,Q,Z){if(Q===0)return null;let z=Math.trunc($*100/Q),X=Math.trunc($*N$/Q);if(X>N$)X=N$;let q=N$-X,K=S;if(z>=80)K=O;else if(z>=50)K=_;let U="=".repeat(Math.max(0,X))+" ".repeat(Math.max(0,q)),J=i1($),W=i1(Q);return`  ${k}${Z}${V} ${K}[${U}]${V} ${z}% (${J} / ${W})`}async function fQ(){if(await f("jq"))return!0;return process.stdout.write(`${O}Error: jq is required but not installed.${V}
`),process.stdout.write(`Install with:
`),process.stdout.write(`  brew install jq    (macOS)
`),process.stdout.write(`  apt install jq     (Debian/Ubuntu)
`),process.stdout.write(`  yum install jq     (RHEL/CentOS)
`),!1}function S$($){if(!Number.isFinite($)||$<=0)return!1;try{return process.kill($,0),!0}catch{return!1}}function D$($){if(!y($))return null;try{let Q=U$($,"utf-8").trim();if(!Q)return null;let Z=Number.parseInt(Q,10);return Number.isFinite(Z)?Z:null}catch{return null}}function uQ($){let Q=[],Z=D$(D($,"loki.pid"));if(Z!==null&&S$(Z))Q.push(`global:${Z}`);let z=D($,"sessions");if(y(z)){let X=[];try{X=r1(z)}catch{X=[]}for(let q of X){let K=D(z,q);try{if(!t1(K).isDirectory())continue}catch{continue}let U=D(K,"loki.pid"),J=D$(U);if(J!==null&&S$(J))Q.push(`${q}:${J}`)}}if(y($)){let X=[];try{X=r1($)}catch{X=[]}for(let q of X){if(!q.startsWith("run-")||!q.endsWith(".pid"))continue;let K=D($,q);try{if(!t1(K).isFile())continue}catch{continue}let U=vQ(q,".pid").slice(4),J=D$(K);if(J!==null&&S$(J)){if(!Q.some((H)=>H.startsWith(`${U}:`)))Q.push(`${U}:${J}`)}}}return Q}async function $0($,Q){let Z=await F(["jq","-r",$,Q]);if(Z.exitCode!==0)return null;return Z.stdout.trim()}function Q0($,Q){try{let Z=U$($,"utf-8"),X=JSON.parse(Z)[Q];if(typeof X==="number"){if(Q==="budget_used"){let q=Math.round(X*100)/100;if(Number.isInteger(q))return String(q);return String(q)}return String(X)}if(X===void 0||X===null)return"0";return String(X)}catch{return"0"}}function Z0($,Q,Z){try{let z=U$($,"utf-8"),q=JSON.parse(z)[Q];if(typeof q==="number"&&Number.isFinite(q))return q;return Z}catch{return Z}}async function cQ(){let $=P();if(!await fQ())return 1;if(!y($))return process.stdout.write(`${k}Loki Mode Status${V}
`),process.stdout.write(`
`),process.stdout.write(`${_}No active session found.${V}
`),process.stdout.write(`Loki Mode has not been initialized in this directory.
`),process.stdout.write(`
`),process.stdout.write(`To start a session:
`),process.stdout.write(`  loki start <prd>              - Start with a PRD file
`),process.stdout.write(`  loki start                    - Start without a PRD
`),process.stdout.write(`
`),process.stdout.write(`${h}Current directory: ${process.cwd()}${V}
`),0;process.stdout.write(`${k}Loki Mode Status${V}
`),process.stdout.write(`
`);let Q="",Z=D($,"state","provider");if(y(Z))try{Q=U$(Z,"utf-8").trim()}catch{Q=""}let z=Q||process.env.LOKI_PROVIDER||"claude",X="full features";switch(z){case"codex":case"aider":X="degraded mode";break;case"cline":X="near-full mode";break;default:X="full features";break}process.stdout.write(`${I}Provider:${V} ${z} (${X})
`),process.stdout.write(`${h}  Switch with: loki provider set <claude|codex|cline|aider>${V}
`),process.stdout.write(`
`);let q=uQ($);if(q.length>0){process.stdout.write(`${S}Active Sessions: ${q.length}${V}
`);for(let Y of q){let T=Y.indexOf(":"),M=T>=0?Y.slice(0,T):Y,R=T>=0?Y.slice(T+1):"";if(M==="global")process.stdout.write(`  ${I}[global]${V} PID ${R}
`);else process.stdout.write(`  ${I}[#${M}]${V} PID ${R}
`)}process.stdout.write(`
`),process.stdout.write(`${h}  Stop specific: loki stop <session-id>${V}
`),process.stdout.write(`${h}  Stop all:      loki stop${V}
`),process.stdout.write(`
`)}if(y(D($,"PAUSE")))process.stdout.write(`${_}Status: PAUSED${V}
`),process.stdout.write(`${h}  Resume with: loki resume${V}
`),process.stdout.write(`
`);else if(y(D($,"STOP")))process.stdout.write(`${O}Status: STOPPED${V}
`),process.stdout.write(`${h}  Clear with: loki resume${V}
`),process.stdout.write(`
`);let K=D($,"STATUS.txt");if(y(K)){process.stdout.write(`${I}Session Info:${V}
`);try{process.stdout.write(U$(K,"utf-8"))}catch{}process.stdout.write(`
`)}let U=D($,"state","orchestrator.json");if(y(U)){process.stdout.write(`${I}Orchestrator State:${V}
`);let Y=await $0('.currentPhase // "unknown"',U);process.stdout.write(`${Y??"unknown"}
`)}let J=D($,"queue","pending.json");if(y(J)){let Y=await $0('if type == "array" then length elif .tasks then .tasks | length else 0 end',J);process.stdout.write(`${I}Pending Tasks:${V} ${Y??"0"}
`)}let W=D($,"metrics","budget.json");if(y(W)){let Y=Q0(W,"budget_limit"),T=Q0(W,"budget_used");if(Y!=="0"){process.stdout.write(`${I}Budget:${V} $${T} / $${Y}
`);let M=Math.trunc((Number.parseFloat(T)||0)*100),R=Number.parseFloat(Y),N=Number.isFinite(R)&&R!==0?Math.trunc(R*100):100,v=e1(M,N,"Budget");if(v!==null)process.stdout.write(`${v}
`)}else process.stdout.write(`${I}Cost:${V} $${T} (no limit)
`)}let H=D($,"state","context-usage.json");if(y(H)){let Y=Z0(H,"window_size",200000),T=Z0(H,"used_tokens",0),M=e1(T,Y,"Context");if(M!==null)process.stdout.write(`${M}
`)}let G=[D($,"dashboard","dashboard.pid"),D(mQ(),".loki","dashboard","dashboard.pid")].find((Y)=>y(Y))??"";if(G&&y(G)){let Y=D$(G);if(Y!==null&&S$(Y)){let T=D(G,".."),M=(u,A)=>{let E=D(T,u);try{return y(E)?U$(E,"utf-8").trim()||A:A}catch{return A}},R=M("scheme","http"),N=M("host","127.0.0.1"),v=M("port",process.env.LOKI_DASHBOARD_PORT||"57374");if(N==="0.0.0.0")N="127.0.0.1";process.stdout.write(`${I}Dashboard:${V} ${R}://${N}:${v}/
`)}}return await pQ($),process.stdout.write(`
`),process.stdout.write(`${h}  Tip: loki analyze context show   - detailed token breakdown${V}
`),process.stdout.write(`${h}  Tip: loki analyze code overview  - codebase intelligence${V}
`),0}async function pQ($){let Q=D($,"state"),Z=lQ(Q),z=D(Q,"relevant-learnings.json"),X=D($,"escalations"),q=Z.length>0,K=y(z),U=y(X);if(!q&&!K&&!U)return;if(process.stdout.write(`
${I}Phase 1 artifacts:${V}
`),q){let J=Z[Z.length-1],W=z0(J);if(W&&Array.isArray(W.findings)){let H={Critical:0,High:0,Medium:0,Low:0};for(let G of W.findings){let Y=String(G.severity??"");if(Y in H)H[Y]=(H[Y]??0)+1}let B=Object.entries(H).filter(([,G])=>G>0).map(([G,Y])=>`${Y} ${G.toLowerCase()}`).join(", ");process.stdout.write(`  Findings (iter ${W.iteration??"?"}): ${B||"none"} -- ${W.findings.length} total
`)}}if(K){let J=z0(z);if(J&&Array.isArray(J.learnings)&&J.learnings.length>0){let W=new Map;for(let B of J.learnings){let G=String(B.trigger??"unknown");W.set(G,(W.get(G)??0)+1)}let H=[...W.entries()].sort((B,G)=>G[1]-B[1]).slice(0,3).map(([B,G])=>`${G} ${B}`).join(", ");process.stdout.write(`  Learnings: ${J.learnings.length} total (${H})
`)}}if(U){let J=0,W="";try{let B=(await import("fs")).readdirSync(X).filter((G)=>G.endsWith(".md"));if(J=B.length,B.length>0)B.sort(),W=B[B.length-1]??""}catch{}if(J>0)process.stdout.write(`  Escalations: ${J} handoff doc${J===1?"":"s"} (latest: ${W})
`)}}function lQ($){if(!y($))return[];try{return q$("fs").readdirSync($).filter((z)=>/^findings-\d+\.json$/.test(z)).sort((z,X)=>{let q=Number.parseInt(z.replace(/[^0-9]/g,""),10)||0,K=Number.parseInt(X.replace(/[^0-9]/g,""),10)||0;return q-K}).map((z)=>D($,z))}catch{return[]}}function z0($){try{let Q=q$("fs");return JSON.parse(Q.readFileSync($,"utf-8"))}catch{return null}}async function dQ(){let $=await Z$();if(!$)return process.stderr.write(`{"error": "Failed to generate JSON status. Ensure python3 is available."}
`),1;let Q=g,Z=P(),z=process.env.LOKI_DASHBOARD_PORT||"57374",X=process.env.LOKI_PROVIDER||"claude",q=await F([$,"-c",gQ,Q,Z,z,X],{timeoutMs:30000});if(q.exitCode!==0)return process.stderr.write(`{"error": "Failed to generate JSON status. Ensure python3 is available."}
`),1;return process.stdout.write(q.stdout),0}async function oQ($){let Q=[...$];while(Q.length>0){let Z=Q[0];if(Z==="--json")return dQ();if(Z==="--help"||Z==="-h")return process.stdout.write(`Usage: loki status [--json]
`),0;return process.stdout.write(`${O}Unknown flag: ${Z}${V}
`),process.stdout.write(`Usage: loki status [--json]
`),1}return cQ()}var N$=30,gQ=`
import json, os, sys, time

skill_dir = sys.argv[1]
loki_dir = sys.argv[2]
dashboard_port = sys.argv[3]
env_provider = sys.argv[4]
result = {}

# Version
version_file = os.path.join(skill_dir, 'VERSION')
if os.path.isfile(version_file):
    with open(version_file) as f:
        result['version'] = f.read().strip()
else:
    result['version'] = 'unknown'

# Check if session exists
if not os.path.isdir(loki_dir):
    result['status'] = 'inactive'
    result['phase'] = None
    result['iteration'] = 0
    result['provider'] = env_provider if os.environ.get('LOKI_PROVIDER', '') else 'claude'
    result['provider_source'] = 'env' if os.environ.get('LOKI_PROVIDER', '') else 'default'
    result['dashboard_url'] = None
    result['pid'] = None
    result['elapsed_time'] = 0
    result['task_counts'] = {'total': 0, 'completed': 0, 'failed': 0, 'pending': 0}
    result['phase1'] = {
        'findings_iters': 0,
        'learnings_count': 0,
        'escalations_count': 0,
        'pause_signal': False,
        'gate_failure_counts': {},
    }
    print(json.dumps(result, indent=2))
    sys.exit(0)

# Status from signals and session.json
if os.path.isfile(os.path.join(loki_dir, 'PAUSE')):
    result['status'] = 'paused'
elif os.path.isfile(os.path.join(loki_dir, 'STOP')):
    result['status'] = 'stopped'
else:
    session_file = os.path.join(loki_dir, 'session.json')
    if os.path.isfile(session_file):
        try:
            with open(session_file) as f:
                session = json.load(f)
            result['status'] = session.get('status', 'unknown')
        except Exception:
            result['status'] = 'unknown'
    else:
        result['status'] = 'unknown'

# Phase and iteration from dashboard-state.json
ds_file = os.path.join(loki_dir, 'dashboard-state.json')
if os.path.isfile(ds_file):
    try:
        with open(ds_file) as f:
            ds = json.load(f)
        result['phase'] = ds.get('phase', ds.get('currentPhase'))
        result['iteration'] = ds.get('iteration', ds.get('currentIteration', 0))
    except Exception:
        result['phase'] = None
        result['iteration'] = 0
else:
    orch_file = os.path.join(loki_dir, 'state', 'orchestrator.json')
    if os.path.isfile(orch_file):
        try:
            with open(orch_file) as f:
                orch = json.load(f)
            result['phase'] = orch.get('currentPhase')
            result['iteration'] = orch.get('currentIteration', 0)
        except Exception:
            result['phase'] = None
            result['iteration'] = 0
    else:
        result['phase'] = None
        result['iteration'] = 0

# Provider + provider_source (v7.7.2 B-5 clarity, parity with bash)
# v7.7.12 (UT2-13 parity fix): read cli-provider marker FIRST so the bun
# route reports provider_source='cli' identically to bash route. Without
# this, --provider flag works for state but status --json silently
# downgrades the source field, breaking parity.
def _read_cli_provider_bun(loki_dir):
    cli_file = os.path.join(loki_dir, 'state', 'cli-provider')
    if not os.path.isfile(cli_file):
        return None
    try:
        content = open(cli_file).read().strip()
        parts = content.split(':')
        if len(parts) < 2:
            return None
        prov = parts[0]
        ts = int(parts[1])
        if prov not in ('claude', 'codex', 'cline', 'aider'):
            return None
        if time.time() - ts > 86400:
            return None
        if len(parts) >= 3:
            try:
                pid = int(parts[2])
                if pid > 0:
                    os.kill(pid, 0)
            except (ValueError, ProcessLookupError, PermissionError):
                return None
        return prov
    except Exception:
        return None

cli_prov = _read_cli_provider_bun(loki_dir)
provider_file = os.path.join(loki_dir, 'state', 'provider')
if os.path.isfile(provider_file):
    try:
        with open(provider_file) as f:
            saved = f.read().strip()
    except OSError:
        saved = ''
else:
    saved = ''
env_set = os.environ.get('LOKI_PROVIDER', '') != ''
if cli_prov:
    result['provider'] = cli_prov
    result['provider_source'] = 'cli'
elif saved:
    result['provider'] = saved
    result['provider_source'] = 'saved'
elif env_set:
    result['provider'] = env_provider
    result['provider_source'] = 'env'
else:
    result['provider'] = 'claude'
    result['provider_source'] = 'default'

# PID
pid_file = os.path.join(loki_dir, 'loki.pid')
if os.path.isfile(pid_file):
    try:
        with open(pid_file) as f:
            result['pid'] = int(f.read().strip())
    except (ValueError, Exception):
        result['pid'] = None
else:
    result['pid'] = None

# Elapsed time from session.json
session_file = os.path.join(loki_dir, 'session.json')
if os.path.isfile(session_file):
    try:
        with open(session_file) as f:
            session = json.load(f)
        start_time = session.get('start_time', session.get('startTime'))
        if start_time:
            if isinstance(start_time, (int, float)):
                result['elapsed_time'] = int(time.time() - start_time)
            else:
                from datetime import datetime
                dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                result['elapsed_time'] = int(time.time() - dt.timestamp())
        else:
            result['elapsed_time'] = 0
    except Exception:
        result['elapsed_time'] = 0
else:
    result['elapsed_time'] = 0

# Dashboard URL. Check BOTH the project-local in-build dashboard and the
# standalone dashboard (~/.loki/dashboard, where loki dashboard/serve now
# write) and honor saved scheme/host/port side-files, mirroring the bash
# route (autonomy/loki) so the two runtimes report identically.
_dash_candidates = [
    os.path.join(loki_dir, 'dashboard', 'dashboard.pid'),
    os.path.expanduser(os.path.join('~', '.loki', 'dashboard', 'dashboard.pid')),
]
dashboard_pid_file = next((p for p in _dash_candidates if os.path.isfile(p)), _dash_candidates[0])
dashboard_url = None
if os.path.isfile(dashboard_pid_file):
    try:
        with open(dashboard_pid_file) as f:
            dpid = int(f.read().strip())
        os.kill(dpid, 0)
        _dd = os.path.dirname(dashboard_pid_file)
        def _side(name, default):
            p = os.path.join(_dd, name)
            try:
                return open(p).read().strip() if os.path.isfile(p) else default
            except OSError:
                return default
        _scheme = _side('scheme', 'http')
        _host = _side('host', '127.0.0.1')
        _port = _side('port', str(dashboard_port))
        if _host == '0.0.0.0':
            _host = '127.0.0.1'
        dashboard_url = _scheme + '://' + _host + ':' + _port + '/'
    except (ProcessLookupError, PermissionError, ValueError, Exception):
        pass
result['dashboard_url'] = dashboard_url

# Task counts from queue files
task_counts = {'total': 0, 'completed': 0, 'failed': 0, 'pending': 0}
queue_dir = os.path.join(loki_dir, 'queue')
if os.path.isdir(queue_dir):
    for name, key in [('pending.json', 'pending'), ('completed.json', 'completed'), ('failed.json', 'failed')]:
        fpath = os.path.join(queue_dir, name)
        if os.path.isfile(fpath):
            try:
                with open(fpath) as f:
                    data = json.load(f)
                if isinstance(data, list):
                    task_counts[key] = len(data)
                elif isinstance(data, dict) and 'tasks' in data:
                    task_counts[key] = len(data['tasks'])
            except Exception:
                pass
    task_counts['total'] = task_counts['pending'] + task_counts['completed'] + task_counts['failed']
result['task_counts'] = task_counts

# v7.5.5 (#204): Phase 1 (RARV-C closure) artifact summary so dashboard /
# CI / operators can confirm the embedded-by-default flow is wired without
# tailing files. All counts are read-only and degrade silently to zero.
phase1 = {
    'findings_iters': 0,
    'learnings_count': 0,
    'escalations_count': 0,
    'pause_signal': False,
    'gate_failure_counts': {},
}
state_dir = os.path.join(loki_dir, 'state')
if os.path.isdir(state_dir):
    try:
        phase1['findings_iters'] = sum(
            1 for n in os.listdir(state_dir)
            if n.startswith('findings-') and n.endswith('.json')
        )
    except Exception:
        pass
    learnings_file = os.path.join(state_dir, 'relevant-learnings.json')
    if os.path.isfile(learnings_file):
        try:
            with open(learnings_file) as f:
                learnings = json.load(f)
            if isinstance(learnings, list):
                phase1['learnings_count'] = len(learnings)
            elif isinstance(learnings, dict):
                entries = learnings.get('entries')
                if isinstance(entries, list):
                    phase1['learnings_count'] = len(entries)
        except Exception:
            pass
escalations_dir = os.path.join(loki_dir, 'escalations')
if os.path.isdir(escalations_dir):
    try:
        phase1['escalations_count'] = sum(
            1 for n in os.listdir(escalations_dir) if n.endswith('.md')
        )
    except Exception:
        pass
phase1['pause_signal'] = os.path.isfile(os.path.join(loki_dir, 'PAUSE'))
gate_count_file = os.path.join(loki_dir, 'quality', 'gate-failure-count.json')
if os.path.isfile(gate_count_file):
    try:
        with open(gate_count_file) as f:
            gc = json.load(f)
        if isinstance(gc, dict):
            phase1['gate_failure_counts'] = {
                k: v for k, v in gc.items() if isinstance(v, (int, float))
            }
    except Exception:
        pass
result['phase1'] = phase1

print(json.dumps(result, indent=2))
`;var K0=L(()=>{d();V$();c();C()});var V0={};b(V0,{emitDeprecatedAlias:()=>z1,deprecatedAliasShouldSuppress:()=>q0});function q0($){let Q=$[0];if(Q!==void 0&&aQ.has(Q))return!0;for(let Z of $)if(nQ.has(Z))return!0;return!1}function z1($,Q,Z){if(q0(Z))return;process.stderr.write(`note: 'loki ${$}' is now 'loki ${Q}'. The old form still works.
`)}var nQ,aQ;var X1=L(()=>{nQ=new Set(["--json","-q","--quiet"]),aQ=new Set(["json","csv","timeline"])});var H0={};b(H0,{runStats:()=>$3,computeStats:()=>W0});import{readdirSync as J0,readFileSync as sQ,statSync as U0}from"fs";import{join as r}from"path";function W$($){try{if(!U0($).isFile())return null;return JSON.parse(sQ($,"utf-8"))}catch{return null}}function V1($){try{return U0($).isDirectory()}catch{return!1}}function rQ($){if(!V1($))return[];try{let Q=J0($).filter((Z)=>Z.startsWith("iteration-")&&Z.endsWith(".json"));return Q.sort(),Q.map((Z)=>r($,Z))}catch{return[]}}function H$($){return Math.trunc($).toLocaleString("en-US")}function K1($){let Q=Math.trunc($);if(Q<60)return`${Q}s`;let Z=Math.trunc(Q/3600),z=Math.trunc(Q%3600/60),X=Q%60;if(Z>0)return`${Z}h ${String(z).padStart(2,"0")}m`;return`${z}m ${String(X).padStart(2,"0")}s`}function t($,Q=0){let Z=Math.pow(10,Q);return Math.round($*Z)/Z}function G$($,Q){return $.toFixed(Q)}function q1($,Q){return $.length>=Q?$:$+" ".repeat(Q-$.length)}function tQ($){let Q="N/A",Z=0,z=W$(r($,"state","orchestrator.json"));if(z&&typeof z==="object"){if(typeof z.currentPhase==="string")Q=z.currentPhase;if(typeof z.currentIteration==="number")Z=z.currentIteration}let X=r($,"metrics","efficiency"),q=rQ(X),K=[];for(let j of q){let x=W$(j);if(x&&typeof x==="object")K.push(x)}if(K.length>0)Z=Math.max(Z,K.length);let U=K.reduce((j,x)=>j+(x.input_tokens??0),0),J=K.reduce((j,x)=>j+(x.output_tokens??0),0),W=U+J,H=K.reduce((j,x)=>j+(x.cost_usd??0),0),B=K.reduce((j,x)=>j+(x.duration_seconds??0),0),G=0,Y=0,T=W$(r($,"metrics","budget.json"));if(T&&typeof T==="object"){if(typeof T.budget_limit==="number")G=T.budget_limit;if(typeof T.budget_used==="number")Y=T.budget_used}let M=0,R=0,N=W$(r($,"state","quality-gates.json"));if(N&&typeof N==="object"){if(Array.isArray(N)){for(let j of N)if(R+=1,j===!0)M+=1;else if(j&&typeof j==="object"){let x=j;if(x.passed===!0||x.status==="passed")M+=1}}else for(let j of Object.values(N))if(typeof j==="boolean"){if(R+=1,j)M+=1}else if(j&&typeof j==="object"){R+=1;let x=j;if(x.passed===!0||x.status==="passed")M+=1}}let v={},u=W$(r($,"quality","gate-failure-count.json"));if(u&&typeof u==="object"&&!Array.isArray(u)){let j={};for(let[x,l]of Object.entries(u))if(typeof l==="number")j[x]=l;v=j}let A=0,E=0,n=0,s$=r($,"quality");if(V1(s$)){let j=[];try{j=J0(s$)}catch{j=[]}for(let x of j){if(!x.endsWith(".json")||x==="gate-failure-count.json")continue;let l=W$(r(s$,x));if(!l||typeof l!=="object")continue;if(!(("verdict"in l)||("approved"in l)||("reviewers"in l)))continue;A+=1;let C1=(l.verdict??"").toString().toLowerCase();if(l.approved===!0||["approved","approve","pass"].includes(C1))E+=1;else if(["revision","revise","changes_requested","reject"].includes(C1))n+=1}}return{phase:Q,iterationCount:Z,iterations:K,totalInput:U,totalOutput:J,totalTokens:W,totalCost:H,totalDuration:B,budgetLimit:G,budgetUsed:Y,gatesPassed:M,gatesTotal:R,gateFailures:v,reviewsTotal:A,reviewsApproved:E,reviewsRevision:n}}function iQ($,Q){let Z=$.iterationCount,z={session:{iterations:Z,duration_seconds:$.totalDuration,phase:$.phase},tokens:{input:$.totalInput,output:$.totalOutput,total:$.totalTokens,cost_usd:t($.totalCost,2)},quality:{gates_passed:$.gatesPassed,gates_total:$.gatesTotal,reviews_total:$.reviewsTotal,reviews_approved:$.reviewsApproved,reviews_revision:$.reviewsRevision,gate_failures:$.gateFailures},efficiency:{avg_tokens_per_iteration:Z>0?t($.totalTokens/Z,0):0,avg_cost_per_iteration:Z>0?t($.totalCost/Z,2):0,avg_duration_per_iteration:Z>0?t($.totalDuration/Z,1):0},budget:{used:t($.budgetUsed,2),limit:$.budgetLimit,percent:$.budgetLimit>0?t($.budgetUsed/$.budgetLimit*100,1):0}};if(Q)z.iterations=$.iterations.map((K,U)=>({number:U+1,input_tokens:K.input_tokens??0,output_tokens:K.output_tokens??0,cost_usd:t(K.cost_usd??0,2),duration_seconds:K.duration_seconds??0}));let X=JSON.stringify(z,null,2);function q(K,U){if(!U)return;let J=new RegExp(`("${K}": )(-?\\d+)(,?)$`,"m");X=X.replace(J,(W,H,B,G)=>`${H}${B}.0${G}`)}if(q("avg_duration_per_iteration",Z>0&&Number.isInteger(z.efficiency.avg_duration_per_iteration)),q("percent",$.budgetLimit>0&&Number.isInteger(z.budget.percent)),q("cost_usd",Z>0&&Number.isInteger(z.tokens.cost_usd)),Q)X=X.replace(/("cost_usd": )(-?\d+)(,?)$/gm,(K,U,J,W)=>`${U}${J}.0${W}`);return X}function eQ($,Q){let Z=[];if(Z.push("Loki Mode Session Statistics"),Z.push("============================"),Z.push(""),Z.push("Session"),Z.push(`  Iterations completed: ${$.iterationCount}`),Z.push(`  Duration: ${K1($.totalDuration)}`),Z.push(`  Current phase: ${$.phase}`),Z.push(""),Z.push("Token Usage"),$.iterations.length>0)Z.push(`  Input tokens:  ${H$($.totalInput)}`),Z.push(`  Output tokens: ${H$($.totalOutput)}`),Z.push(`  Total tokens:  ${H$($.totalTokens)}`),Z.push(`  Estimated cost: $${G$($.totalCost,2)}`);else Z.push("  N/A (no iteration metrics found)");if(Z.push(""),Z.push("Quality Gates"),$.gatesTotal>0){let z=Math.round($.gatesPassed/$.gatesTotal*100);Z.push(`  Gates passed: ${$.gatesPassed}/${$.gatesTotal} (${z}%)`)}else Z.push("  Gates passed: N/A");if($.reviewsTotal>0){let z=[];if($.reviewsApproved>0)z.push(`${$.reviewsApproved} approved`);if($.reviewsRevision>0)z.push(`${$.reviewsRevision} revision requested`);let X=z.length>0?z.join(", "):"N/A";Z.push(`  Code reviews: ${$.reviewsTotal} (${X})`)}if(Object.keys($.gateFailures).length>0){let z=Object.entries($.gateFailures).filter(([,X])=>X>0).map(([X,q])=>`${X} (${q})`);if(z.length>0)Z.push(`  Gate failures: ${z.join(", ")}`)}if(Z.push(""),Z.push("Efficiency"),$.iterationCount>0&&$.iterations.length>0){let z=Math.round($.totalTokens/$.iterationCount),X=$.totalCost/$.iterationCount,q=$.totalDuration/$.iterationCount;Z.push(`  Avg tokens/iteration: ${H$(z)}`),Z.push(`  Avg cost/iteration: $${G$(X,2)}`),Z.push(`  Avg duration/iteration: ${K1(q)}`)}else Z.push("  N/A (no iteration metrics found)");if(Z.push(""),Z.push("Budget"),$.budgetLimit>0){let z=t($.budgetUsed/$.budgetLimit*100,1),X=Number.isInteger(z)?`${z}.0`:`${z}`;Z.push(`  Used: $${G$($.budgetUsed,2)} / $${G$($.budgetLimit,2)} (${X}%)`)}else if($.budgetUsed>0)Z.push(`  Used: $${G$($.budgetUsed,2)} (no limit set)`);else Z.push("  N/A");if(Q&&$.iterations.length>0)Z.push(""),Z.push("Per-Iteration Breakdown"),$.iterations.forEach((z,X)=>{let q=X+1,K=q1(H$(z.input_tokens??0),10),U=q1(H$(z.output_tokens??0),10),J=z.cost_usd??0,W=K1(z.duration_seconds??0),H=q1(`${q}`,3);Z.push(`  #${H} input: ${K} output: ${U} cost: $${G$(J,2)}  time: ${W}`)});return Z.join(`
`)}function W0($){let Q=!1,Z=!1;for(let K of $)if(K==="--json")Q=!0;else if(K==="--efficiency")Z=!0;let z=P();if(!V1(z)){if(Q)return{exitCode:0,stdout:'{"error": "No active session"}'};return{exitCode:0,stdout:`${_}No active session found.${V}
Start a session with: loki start <prd>`}}let X=tQ(z);return{exitCode:0,stdout:Q?iQ(X,Z):eQ(X,Z)}}async function $3($){let{emitDeprecatedAlias:Q}=await Promise.resolve().then(() => (X1(),V0));Q("stats","report session",$);let Z=W0($);return console.log(Z.stdout),Z.exitCode}var G0=L(()=>{C();c()});var I0={};b(I0,{runDoctor:()=>Y3,pythonImportOk:()=>H1,httpReachable:()=>U1,checkTool:()=>O0,checkSkills:()=>w0,checkDisk:()=>W1,buildDoctorJson:()=>_0,_setPythonImportOkForTest:()=>V3});import{existsSync as B0,lstatSync as Q3,readlinkSync as Z3,statfsSync as z3}from"fs";import{spawnSync as X3}from"child_process";import{homedir as Y0}from"os";import{resolve as J1}from"path";function q3($){let Q=$.match(K3);return Q?Q[1]:null}async function M0($){try{let Q=await F([$,"--version"],{timeoutMs:5000}),Z=(Q.stdout||Q.stderr||"").trim();return q3(Z)}catch{return null}}function T0($,Q){let Z=$.split(".").map((X)=>parseInt(X,10)),z=Q.split(".").map((X)=>parseInt(X,10));while(Z.length<2)Z.push(0);while(z.length<2)z.push(0);for(let X=0;X<2;X++){let q=Z[X]??0,K=z[X]??0;if(Number.isNaN(q)||Number.isNaN(K))return 0;if(q!==K)return q-K}return 0}async function O0($,Q,Z,z=null){let X=await f(Q),q=X!==null,K=q?await M0(Q):null,U="pass";if(!q)U=Z==="required"?"fail":"warn";else if(z&&K){if(T0(K,z)<0)U=Z==="required"?"fail":"warn"}return{name:$,command:Q,found:q,version:K,required:Z,min_version:z,status:U,path:X}}function W1(){let $=null;try{let Z=z3(Y0()),z=Number(Z.bavail)*Number(Z.bsize);$=Math.round(z/1073741824*10)/10}catch{$=null}let Q="pass";if($!==null){if($<1)Q="fail";else if($<5)Q="warn"}return{available_gb:$,status:Q}}async function U1($,Q=2000){try{return(await fetch($,{signal:AbortSignal.timeout(Q)})).ok}catch{return!1}}async function H1($,Q=!1){let Z=`import ${$}`,z=Q?30000:5000;if(!Q)return(await z$(Z,{timeoutMs:z})).exitCode===0;let X=await Z$();if(!X)return!1;return(await F([X,"-c",Z],{timeoutMs:z})).exitCode===0}function V3($){h$.fn=$??H1}function w0(){let $=Y0();return J3.map(({name:Q,dir:Z})=>{let z=J1($,Z),X=z,q=J1(z,"SKILL.md");if(B0(q))return{name:Q,path:X,status:"pass",detail:""};try{if(Q3(z).isSymbolicLink()){let U="unknown";try{U=Z3(z)}catch{}return{name:Q,path:X,status:"fail",detail:`(broken symlink -> ${U})`}}}catch{}return{name:Q,path:X,status:"warn",detail:"(not found - run 'loki setup-skill')"}})}async function A0(){return Promise.all(U3.map(async($)=>{return{...await O0($.jsonName,$.cmd,$.required,$.min??null),displayName:$.displayName}}))}async function W3(){let Q=await f("sentrux")!==null,Z=Q?await M0("sentrux"):null;return{found:Q,version:Z,status:Q?"pass":"warn",required:"optional"}}async function H3(){let{openSync:$,statSync:Q,readSync:Z,closeSync:z,existsSync:X}=await import("fs"),{join:q}=await import("path"),K=65536,U=process.env.LOKI_DIR??".loki",J=q(U,"memory",".errors.log"),W=[],H=!1;try{if(X(J)){H=!0;let B=Q(J).size,G=Math.max(0,B-65536),Y=B-G,T=Buffer.alloc(Y),M=$(J,"r");try{Z(M,T,0,Y,G)}finally{z(M)}let N=T.toString("utf-8").split(`
`);if(G>0&&N.length>0)N=N.slice(1);N=N.map((v)=>v.trim()).filter((v)=>v.length>0),W=N.slice(-5)}}catch{W=[]}return{errors_log_path:H?J:null,recent_errors:W,recent_error_count:W.length,status:W.length===0?"pass":"warn"}}async function _0(){let Q=(await A0()).map(({displayName:J,...W})=>W),Z=W1(),z=await W3(),X=await H3(),q=0,K=0,U=0;for(let J of Q)if(J.status==="pass")q++;else if(J.status==="fail")K++;else U++;if(Z.status==="pass")q++;else if(Z.status==="fail")K++;else U++;return{loki_mode_version:E$(),checks:Q,disk:Z,sentrux:z,memory:X,summary:{passed:q,failed:K,warnings:U,ok:K===0}}}function w($){switch($){case"pass":return`${S}PASS${V}`;case"fail":return`${O}FAIL${V}`;case"warn":return`${_}WARN${V}`}}function C$($){let Q=$.version?` (v${$.version})`:"",Z=$.displayName;if(!$.found){let z=$.required==="required"?"not found":$.required==="recommended"?"not found (recommended)":"not found (optional)";return`  ${w($.status)}  ${Z} - ${z}`}if($.min_version&&$.version&&T0($.version,$.min_version)<0){let z=$.required==="required"?"requires":"recommended";return`  ${w($.status)}  ${Z}${Q} - ${z} >= ${$.min_version}`}return`  ${w($.status)}  ${Z}${Q}`}function b$($,Q){if(Q==="pass")$.pass++;else if(Q==="fail")$.fail++;else $.warn++}function G3(){process.stdout.write(`${k}loki doctor${V} - Check system prerequisites

`),process.stdout.write(`Usage: loki doctor [--json]

`),process.stdout.write(`Options:
`),process.stdout.write(`  --json    Output machine-readable JSON

`),process.stdout.write(`Checks: node, python3, jq, git, curl, bash version,
`),process.stdout.write(`        claude/codex CLIs, and disk space.
`)}async function B3(){process.stdout.write(`${k}Loki Mode Doctor${V}

`),process.stdout.write(`Checking system prerequisites...

`);let $={pass:0,fail:0,warn:0},Q=await A0(),Z=new Map(Q.map((A)=>[A.command,A]));process.stdout.write(`${I}Required:${V}
`);for(let A of["node","python3","jq","git","curl"]){let E=Z.get(A);process.stdout.write(C$(E)+`
`),b$($,E.status)}process.stdout.write(`
`),process.stdout.write(`${I}AI Providers:${V}
`);let z=["claude","codex","cline","aider"],X={claude:"npm install -g @anthropic-ai/claude-code",codex:"npm install -g @openai/codex",cline:"npm install -g cline",aider:"pip install aider-chat"},q=!1;for(let A of z){let E=Z.get(A);if(process.stdout.write(C$(E)+`
`),!E.found&&X[A])process.stderr.write(`         ${_}Install: ${X[A]}${V}
`);if(b$($,E.status),E.found)q=!0}if(!q){if(process.stdout.write(`  ${w("fail")}  No AI provider CLI installed -- at least one is required
`),process.stdout.write(`         ${_}Install: npm install -g @anthropic-ai/claude-code${V}
`),$.fail++,process.stdout.isTTY){let A=J1(g,"autonomy/provider-offer.sh");if(B0(A))X3("bash",[A,"report"],{stdio:"inherit"})}}process.stdout.write(`
`),process.stdout.write(`${I}API Keys:${V}
`);let K=Z.get("claude")?.found??!1,U=Z.get("codex")?.found??!1,J=process.env;if(J.ANTHROPIC_API_KEY)process.stdout.write(`  ${w("pass")}  ANTHROPIC_API_KEY is set
`),$.pass++;else if(K)process.stdout.write(`  ${h}  --  ${V}  ANTHROPIC_API_KEY not set (Claude CLI uses its own login)
`);if(J.OPENAI_API_KEY)process.stdout.write(`  ${w("pass")}  OPENAI_API_KEY is set
`),$.pass++;else if(U)process.stdout.write(`  ${h}  --  ${V}  OPENAI_API_KEY not set (Codex CLI uses its own login)
`);if(J.ANTHROPIC_BASE_URL){let A=J.ANTHROPIC_BASE_URL;if(process.stdout.write(`  ${w("pass")}  ANTHROPIC_BASE_URL: ${A}
`),$.pass++,!J.LOKI_MODEL_OVERRIDE)process.stdout.write(`  ${w("warn")}  LOKI_MODEL_OVERRIDE not set -- opus/sonnet/haiku aliases may not resolve on alt-provider
`),$.warn++;else process.stdout.write(`  ${w("pass")}  LOKI_MODEL_OVERRIDE: ${J.LOKI_MODEL_OVERRIDE}
`),$.pass++}process.stdout.write(`
`),process.stdout.write(`${I}Skills:${V}
`);for(let A of w0())if(A.status==="pass")process.stdout.write(`  ${w("pass")}  ${A.name}  ${h}${A.path}${V}
`),$.pass++;else if(A.status==="fail")process.stdout.write(`  ${w("fail")}  ${A.name}  ${h}${A.detail}${V}
`),process.stdout.write(`         ${_}Fix: loki setup-skill${V}
`),$.fail++;else process.stdout.write(`  ${w("warn")}  ${A.name}  ${h}${A.detail}${V}
`),$.warn++;process.stdout.write(`
`),process.stdout.write(`${I}Integrations:${V}
`);let[W,H,B]=await Promise.all([h$.fn("mcp"),h$.fn("numpy",!0),h$.fn("sentence_transformers",!0)]);if(W)process.stdout.write(`  ${w("pass")}  MCP SDK (Python)
`),$.pass++;else process.stdout.write(`  ${w("warn")}  MCP SDK - not installed (pip3 install mcp)
`),$.warn++;if(H)process.stdout.write(`  ${w("pass")}  numpy (vector search)
`),$.pass++;else process.stdout.write(`  ${w("warn")}  numpy - not installed (pip3 install numpy)
`),$.warn++;if(B)process.stdout.write(`  ${w("pass")}  sentence-transformers (embeddings)
`),$.pass++;else process.stdout.write(`  ${w("warn")}  sentence-transformers - not installed (loki memory vectors setup)
`),$.warn++;if(await U1("http://localhost:8100/api/v2/heartbeat"))process.stdout.write(`  ${w("pass")}  ChromaDB server (port 8100)
`),$.pass++;else process.stdout.write(`  ${w("warn")}  ChromaDB - not running (docker start loki-chroma)
`),$.warn++;{let A=["pyright-langserver","pylsp","typescript-language-server","gopls","rust-analyzer","jdtls"],E=[];for(let n of A)if(await f(n))E.push(n);if(E.length>0)process.stdout.write(`  ${w("pass")}  LSP servers detected (${E.length}): ${E.join(", ")}
`),$.pass++;else process.stdout.write(`  ${w("warn")}  LSP servers - none on PATH (install for symbol grounding: npm i -g pyright typescript-language-server; brew install gopls)
`),$.warn++}let G=process.env.LOKI_MIROFISH_URL;if(G)if(await U1(`${G}/health`))process.stdout.write(`  ${w("pass")}  MiroFish server (${G})
`),$.pass++;else process.stdout.write(`  ${w("warn")}  MiroFish - not running (loki start --mirofish-docker <image>)
`),$.warn++;if(process.env.LOKI_OTEL_ENDPOINT)process.stdout.write(`  ${w("pass")}  OTEL endpoint: ${process.env.LOKI_OTEL_ENDPOINT}
`),$.pass++;else process.stdout.write(`  ${w("warn")}  OTEL - not configured (set LOKI_OTEL_ENDPOINT)
`),$.warn++;if(await f("sentrux")){let A="unknown";try{let n=(await F(["sentrux","--version"],{timeoutMs:2000})).stdout.split(/\s+/).filter(Boolean).pop();if(n)A=n.replace(/^v/,"")}catch{}process.stdout.write(`  ${w("pass")}  sentrux ${A} (architectural drift gate: loki sentrux help)
`),$.pass++}else process.stdout.write(`  ${w("warn")}  sentrux - not installed (optional, brew install sentrux/tap/sentrux)
`),$.warn++;process.stdout.write(`
`),process.stdout.write(`${I}System:${V}
`);let Y=Z.get("bash");process.stdout.write(C$(Y)+`
`),b$($,Y.status);let T=Z.get("bun");if(T)process.stdout.write(C$(T)+`
`),b$($,T.status);let M=W1(),R=M.available_gb===null?null:Math.floor(M.available_gb);if(R===null)process.stdout.write(`  ${w("warn")}  Disk space: unable to determine
`),$.warn++;else if(M.status==="fail")process.stdout.write(`  ${w("fail")}  Disk space: ${R}GB available (need >= 1GB)
`),$.fail++;else if(M.status==="warn")process.stdout.write(`  ${w("warn")}  Disk space: ${R}GB available (low)
`),$.warn++;else process.stdout.write(`  ${w("pass")}  Disk space: ${R}GB available
`),$.pass++;process.stdout.write(`
`),process.stdout.write(`${I}Runtime route:${V}
`);let N=process.versions.bun!==void 0,v=process.argv[0]??"(unknown)";if(process.stdout.write(`  ${w("pass")}  Active runtime: ${N?"Bun":"Node"} (${v})
`),process.env.LOKI_LEGACY_BASH==="1"||process.env.LOKI_LEGACY_BASH==="true")process.stdout.write(`  ${w("warn")}  LOKI_LEGACY_BASH set: shim routes every command to autonomy/loki (bash)
`);if(process.env.LOKI_TS_ENTRY)process.stdout.write(`  ${w("pass")}  LOKI_TS_ENTRY override: ${process.env.LOKI_TS_ENTRY}
`);if(process.env.BUN_FROM_SOURCE==="1"||process.env.BUN_FROM_SOURCE==="true")process.stdout.write(`  ${w("pass")}  BUN_FROM_SOURCE set: shim prefers loki-ts/src/ over dist/
`);let u=await Z$();if(u!==null){let E=(await F([u,"-c","import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"],{timeoutMs:5000})).stdout.trim();if(E.startsWith("3.12"))process.stdout.write(`  ${w("pass")}  Python 3.12 (chromadb / sentence-transformers): ${E} at ${u}
`);else if(E)process.stdout.write(`  ${w("warn")}  Python 3.12 NOT found -- using ${E} at ${u}; chromadb / sentence-transformers may fail. Install python3.12 (brew install python@3.12 / apt install python3.12).
`);else process.stdout.write(`  ${w("warn")}  Python 3 found at ${u} but version probe failed; chromadb may not work.
`)}else process.stdout.write(`  ${w("warn")}  Python 3 not on PATH -- memory + MCP integrations disabled.
`);if(process.stdout.write(`
`),process.stdout.write(`${k}Summary:${V} ${S}${$.pass} passed${V}, ${O}${$.fail} failed${V}, ${_}${$.warn} warnings${V}

`),$.fail>0)return process.stdout.write(`${O}Some required prerequisites are missing.${V}
`),process.stdout.write(`Install missing dependencies and run 'loki doctor' again.
`),1;if($.warn>0)process.stdout.write(`${_}All required checks passed with some warnings.${V}
`);else process.stdout.write(`${S}All checks passed. System is ready for Loki Mode.${V}
`);return process.stdout.write(`
`),process.stdout.write(`Next: loki quickstart (guided first build from your idea, no PRD needed)
`),process.stdout.write(`      or loki demo (builds a sample todo app end to end) or loki start ./prd.md
`),0}async function Y3($){let Q=!1;for(let Z of $)if(Z==="--json")Q=!0;else if(Z==="--help"||Z==="-h")return G3(),0;else return process.stderr.write(`${O}Unknown option: ${Z}${V}
`),process.stderr.write(`Usage: loki doctor [--json]
`),1;if(Q){let Z=await _0();return process.stdout.write(JSON.stringify(Z,null,2)+`
`),0}return B3()}var K3,h$,J3,U3;var L0=L(()=>{C();d();V$();c();e$();K3=/(\d+\.\d+(?:\.\d+)*)/;h$={fn:H1};J3=[{name:"Claude Code",dir:".claude/skills/loki-mode"},{name:"Codex CLI",dir:".codex/skills/loki-mode"},{name:"Cline CLI",dir:".cline/skills/loki-mode"},{name:"Aider CLI",dir:".aider/skills/loki-mode"}];U3=[{displayName:"Node.js (>= 18)",jsonName:"Node.js",cmd:"node",required:"required",min:"18.0"},{displayName:"Python 3 (>= 3.8)",jsonName:"Python 3",cmd:"python3",required:"required",min:"3.8"},{displayName:"jq",jsonName:"jq",cmd:"jq",required:"required"},{displayName:"git",jsonName:"git",cmd:"git",required:"required"},{displayName:"curl",jsonName:"curl",cmd:"curl",required:"required"},{displayName:"bash (>= 4.0)",jsonName:"bash",cmd:"bash",required:"recommended",min:"4.0"},{displayName:"Bun (>= 1.3)",jsonName:"Bun",cmd:"bun",required:"recommended",min:"1.3"},{displayName:"Claude CLI",jsonName:"Claude CLI",cmd:"claude",required:"optional"},{displayName:"Codex CLI",jsonName:"Codex CLI",cmd:"codex",required:"optional"},{displayName:"Cline CLI",jsonName:"Cline CLI",cmd:"cline",required:"optional"},{displayName:"Aider CLI",jsonName:"Aider CLI",cmd:"aider",required:"optional"}]});import{existsSync as F0,mkdirSync as B9,readdirSync as M3,readFileSync as k0,renameSync as Y9,writeFileSync as M9}from"fs";import{dirname as T3,join as O3,resolve as w3}from"path";import{fileURLToPath as A3}from"url";function _3(){try{let $=T3(A3(import.meta.url)),Q=w3($,"..","..","data","model-pricing.json");if(!F0(Q))return T$;let z=JSON.parse(k0(Q,"utf8")).pricing;if(!z||typeof z!=="object")return T$;let X={};for(let[q,K]of Object.entries(z))if(K!==null&&typeof K==="object"&&typeof K.input==="number"&&typeof K.output==="number")X[q]={input:K.input,output:K.output};for(let q of Object.keys(T$))if(!(q in X))return T$;return X}catch{return T$}}function I3($){return Math.round(($+Number.EPSILON)*1e4)/1e4}function L3($){let Q=($??j0).toLowerCase();return P0[Q]??P0[j0]}function R0($){let Q=0;for(let Z of $){if(typeof Z.cost_usd==="number"&&Number.isFinite(Z.cost_usd)){Q+=Z.cost_usd;continue}let z=L3(Z.model),X=typeof Z.input_tokens==="number"?Z.input_tokens:0,q=typeof Z.output_tokens==="number"?Z.output_tokens:0;Q+=X/1e6*z.input+q/1e6*z.output}return I3(Q)}function E0($){if(!F0($))return[];let Q=[],Z;try{Z=M3($)}catch{return[]}for(let z of Z){if(!z.endsWith(".json"))continue;let X=O3($,z);try{let q=k0(X,"utf8"),K=JSON.parse(q);if(K&&typeof K==="object")Q.push(K)}catch{}}return Q}var T$,P0,j0="sonnet";var x0=L(()=>{C();T$={fable:{input:10,output:50},opus:{input:5,output:25},sonnet:{input:3,output:15},haiku:{input:1,output:5},"gpt-5.3-codex":{input:1.5,output:12}};P0=Object.freeze(_3())});import{existsSync as y$,readdirSync as P3,readFileSync as j3,statSync as F3}from"fs";import{join as v$}from"path";function k3($){let Q=[],Z=v$($,"votes");if(!y$(Z))return Q;let z;try{z=P3(Z)}catch{return Q}for(let X of z){if(!X.startsWith("round-")||!X.endsWith(".json"))continue;try{let q=v$(Z,X);if(!F3(q).isFile())continue;let K=JSON.parse(j3(q,"utf8"));Q.push({iteration:typeof K.iteration==="number"?K.iteration:void 0,verdict:typeof K.verdict==="string"?K.verdict:void 0,complete_votes:typeof K.complete_votes==="number"?K.complete_votes:void 0,total_members:typeof K.total_members==="number"?K.total_members:void 0,threshold:typeof K.threshold==="number"?K.threshold:void 0})}catch{}}return Q}function R3(){return{iteration_count:0,total_cost_usd:0,avg_cost_per_iteration:null,total_input_tokens:0,total_output_tokens:0,total_duration_ms:0,avg_duration_ms_per_iteration:null,model_breakdown:{},phase_breakdown:{},status_breakdown:{}}}function E3(){return{council_rounds:0,unanimous_rate:null,approval_rate:null,iteration_success_rate:null}}function x3($){let Q=R3();if($.length===0)return Q;Q.iteration_count=$.length,Q.total_cost_usd=Math.round(R0($)*1e4)/1e4;for(let Z of $){if(typeof Z.input_tokens==="number")Q.total_input_tokens+=Z.input_tokens;if(typeof Z.output_tokens==="number")Q.total_output_tokens+=Z.output_tokens;let z=Z;if(typeof z.duration_ms==="number")Q.total_duration_ms+=z.duration_ms;if(typeof Z.model==="string")Q.model_breakdown[Z.model]=(Q.model_breakdown[Z.model]??0)+1;if(typeof z.phase==="string")Q.phase_breakdown[z.phase]=(Q.phase_breakdown[z.phase]??0)+1;if(typeof z.status==="string")Q.status_breakdown[z.status]=(Q.status_breakdown[z.status]??0)+1}return Q.avg_cost_per_iteration=Math.round(Q.total_cost_usd/Q.iteration_count*1e4)/1e4,Q.avg_duration_ms_per_iteration=Math.round(Q.total_duration_ms/Q.iteration_count),Q}function N3($,Q,Z){let z=E3();if(z.council_rounds=$.length,$.length>0){let X=0,q=0;for(let K of $){if(typeof K.complete_votes==="number"&&typeof K.total_members==="number"&&K.total_members>0&&K.complete_votes===K.total_members)X+=1;if(K.verdict==="COMPLETE")q+=1}z.unanimous_rate=Math.round(X/$.length*1e4)/1e4,z.approval_rate=Math.round(q/$.length*1e4)/1e4}if(Z>0)z.iteration_success_rate=Math.round(Q/Z*1e4)/1e4;return z}function N0($){let Q=[],Z=v$($,"metrics","efficiency"),z=v$($,"council"),X=y$(Z)?E0(Z):[];if(!y$(Z))Q.push("no .loki/metrics/efficiency/ dir (efficiency KPIs zeroed)");else if(X.length===0)Q.push(".loki/metrics/efficiency/ exists but no iteration files found");let q=k3(z);if(!y$(z))Q.push("no .loki/council/ dir (accuracy KPIs zeroed)");else if(q.length===0)Q.push(".loki/council/ exists but no round-N.json files found");let K=x3(X),U=K.status_breakdown.success??0,J=N3(q,U,K.iteration_count);return{schema_version:1,generated_at:new Date().toISOString(),loki_dir:$,efficiency:K,accuracy:J,notes:Q}}function S0($){return JSON.stringify($,null,2)}function D0($){let Q=[];Q.push(`Loki Mode KPIs  (snapshot at ${$.generated_at})`),Q.push(`Source: ${$.loki_dir}`),Q.push(""),Q.push("Efficiency"),Q.push(`  Iterations:           ${$.efficiency.iteration_count}`),Q.push(`  Total cost USD:       ${$.efficiency.total_cost_usd}`),Q.push(`  Avg cost per iter:    ${$.efficiency.avg_cost_per_iteration??"n/a"}`),Q.push(`  Total input tokens:   ${$.efficiency.total_input_tokens}`),Q.push(`  Total output tokens:  ${$.efficiency.total_output_tokens}`),Q.push(`  Total duration (ms):  ${$.efficiency.total_duration_ms}`),Q.push(`  Avg duration / iter:  ${$.efficiency.avg_duration_ms_per_iteration??"n/a"}`);let Z=Object.entries($.efficiency.model_breakdown).sort((q,K)=>q[0].localeCompare(K[0]));if(Z.length>0)Q.push(`  Model breakdown:      ${Z.map(([q,K])=>`${q}=${K}`).join(", ")}`);let z=Object.entries($.efficiency.phase_breakdown).sort((q,K)=>q[0].localeCompare(K[0]));if(z.length>0)Q.push(`  Phase breakdown:      ${z.map(([q,K])=>`${q}=${K}`).join(", ")}`);let X=Object.entries($.efficiency.status_breakdown).sort((q,K)=>q[0].localeCompare(K[0]));if(X.length>0)Q.push(`  Status breakdown:     ${X.map(([q,K])=>`${q}=${K}`).join(", ")}`);if(Q.push(""),Q.push("Accuracy"),Q.push(`  Council rounds:       ${$.accuracy.council_rounds}`),Q.push(`  Unanimous rate:       ${$.accuracy.unanimous_rate??"n/a"}`),Q.push(`  Approval rate:        ${$.accuracy.approval_rate??"n/a"}`),Q.push(`  Iter success rate:    ${$.accuracy.iteration_success_rate??"n/a"}`),$.notes.length>0){Q.push(""),Q.push("Notes");for(let q of $.notes)Q.push(`  - ${q}`)}return Q.push(""),Q.push("See also: loki trust  (trust trajectory across runs)"),Q.join(`
`)}var C0=L(()=>{x0()});var G1={};b(G1,{runKpis:()=>D3});function D3($,Q={}){if(Q.aliasOf)z1(Q.aliasOf,"report kpis",$);let Z=!1;for(let X of $){if(X==="--help"||X==="-h"||X==="help")return process.stdout.write(S3),0;if(X==="--json"){Z=!0;continue}if(X==="-q"||X==="--quiet")continue;return process.stderr.write(`loki kpis: unknown arg: ${X}
Run 'loki kpis --help' for usage.
`),1}let z=N0(P());return process.stdout.write(Z?S0(z)+`
`:D0(z)+`
`),0}var S3=`loki report kpis -- accuracy + efficiency KPI snapshot (v7.5.28 MVP)

Usage:
  loki report kpis        Pretty-print KPI snapshot
  loki report kpis --json Emit KPIs as JSON
  loki report kpis --help Show this help
  (the old top-level 'loki kpis' still works; it prints a one-line pointer)

Reads from .loki/metrics/efficiency/iteration-*.json and
.loki/council/votes/round-*.json. Missing files yield zero/null KPIs
with explicit notes (not silent failure).

Efficiency KPIs: iteration count, total cost USD, avg cost per iter,
total input/output tokens, model/phase/status breakdowns, durations.

Accuracy KPIs: council rounds, unanimous rate, approval rate,
iteration success rate.

This is the Phase K MVP -- read-only derivation. Per-iteration
emission, dashboard panel, and the loki-bench harness are deferred
follow-ups (see project_v7_5_18_arc_status.md).
`;var B1=L(()=>{C0();C();X1()});var b0={};b(b0,{delegateToBash:()=>h3});import{resolve as C3}from"path";async function h3($){let Q=C3(g,"autonomy","loki"),Z=Bun.spawn({cmd:[Q,...$],stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,LOKI_LEGACY_BASH:"1"}}),z=setTimeout(()=>{try{Z.kill("SIGKILL")}catch{}},b3);try{return await Z.exited}finally{clearTimeout(z)}}var b3=3600000;var h0=L(()=>{C()});import{existsSync as y3,mkdirSync as v3,readdirSync as m3,readFileSync as g3,statSync as f3,writeFileSync as u3}from"fs";import{join as O$}from"path";function Y1($){return $&&typeof $==="object"?$:{}}function X$($){return Math.round($*1e4)/1e4}function o3($){let Q=String($??"").trim().toUpperCase();if(!Q)return null;for(let Z of v0)if(Q.startsWith(Z))return!0;return!1}function n3($){let Q=o3($.final_verdict);if(Q!==null)return Q?1:0;let Z=$.reviewers;if(Array.isArray(Z)&&Z.length>0){let z=0,X=0;for(let q of Z){if(!q||typeof q!=="object")continue;X+=1;let K=String(q.vote??"").trim().toUpperCase();if(v0.some((U)=>K.startsWith(U)))z+=1}if(X>0)return z===X?1:0}return null}function a3($){let Q=Number($.total),Z=Number($.passed);if(!Number.isFinite(Q)||!Number.isFinite(Z))return null;if(Q<=0)return null;return Math.max(0,Math.min(1,Z/Q))}function s3($){let Q;if($&&typeof $==="object")Q=$.count;else Q=$;let Z=Number(Q);if(!Number.isFinite(Z)||Z<0)return null;return Z}function r3($){let Q=Y1($.council);for(let Z of[Q.interventions,$.interventions]){let z=Number(Z);if(Number.isFinite(z)&&z>=0)return z}return null}function t3($){let Q=O$($,"proofs"),Z=[];if(!y3(Q))return Z;let z;try{z=m3(Q).sort()}catch{return Z}for(let X of z){let q=O$(Q,X);try{if(!f3(q).isDirectory())continue}catch{continue}let K=null;try{K=JSON.parse(g3(O$(q,"proof.json"),"utf8"))}catch{continue}if(!K||typeof K!=="object")continue;Z.push({run_id:String(K.run_id??X),generated_at:typeof K.generated_at==="string"?K.generated_at:null,council_pass_rate:n3(Y1(K.council)),gate_pass_rate:a3(Y1(K.quality_gates)),iterations:s3(K.iterations),interventions:r3(K)})}return Z.sort((X,q)=>{let K=X.generated_at===null?1:0,U=q.generated_at===null?1:0;if(K!==U)return K-U;return(X.generated_at??"").localeCompare(q.generated_at??"")}),Z}function y0($){return $.reduce((Q,Z)=>Q+Z,0)/$.length}function i3($,Q){let Z=p3[$],z=l3[$],X=d3[$],q=Q.filter((M)=>M!==null),K=q.length;if(K===0)return{axis:$,label:X,available:!1,higher_is_better:Z,note:"no runs recorded this metric"};if(K<2)return{axis:$,label:X,available:!0,higher_is_better:Z,data_points:K,latest:X$(q[K-1]),direction:"flat",improving:null,delta:0,earlier_mean:X$(q[0]),later_mean:X$(q[K-1]),insufficient:!0,note:"not enough history yet (need 2+ runs with this metric)"};let U=Math.floor(K/2),J=q.slice(0,U),W=q.slice(K-U),H=y0(J),B=y0(W),G=B-H,Y;if(Math.abs(G)<=z)Y="flat";else if(G>0)Y="up";else Y="down";let T;if(Y==="flat")T=null;else T=Y==="up"===Z;return{axis:$,label:X,available:!0,higher_is_better:Z,data_points:K,latest:X$(q[K-1]),direction:Y,improving:T,delta:X$(G),earlier_mean:X$(H),later_mean:X$(B),insufficient:!1}}function m0($){let Q=t3($),Z=Q.map((J)=>({run_id:J.run_id,generated_at:J.generated_at,council_pass_rate:J.council_pass_rate,gate_pass_rate:J.gate_pass_rate,iterations:J.iterations,interventions:J.interventions})),z={};for(let J of m$)z[J]=i3(J,Q.map((W)=>W[J]));let X=Q.length<2,q=m$.filter((J)=>z[J].available&&z[J].improving===!0),K=m$.filter((J)=>z[J].available&&z[J].improving===!1),U=[];if(X)U.push(`not enough history yet: ${Q.length} run(s) recorded, need 2+ to show a trend`);if(!z.interventions.available)U.push("intervention trend unavailable: no per-run intervention count in proof.json yet (axis lights up automatically once recorded)");return{schema_version:c3,generated_at:new Date().toISOString(),loki_dir:$,runs_count:Q.length,insufficient:X,axes:z,improving_count:q.length,regressing_count:K.length,improving_axes:q,regressing_axes:K,series:Z,notes:U}}function g0($){return JSON.stringify($,null,2)}function f0($,Q){let Z=O$($,"metrics"),z=O$(Z,"trust-trajectory.json");try{return v3(Z,{recursive:!0}),u3(z,JSON.stringify(Q,null,2)),z}catch{return null}}function e3($){if($==="up")return"up";if($==="down")return"down";return"flat"}function $8($){let Q=$.label??$.axis;if(!$.available)return`  ${(Q+":").padEnd(26)} no data`;let Z;if($.insufficient)Z="(need 2+ runs)";else if($.improving===!0)Z="improving";else if($.improving===!1)Z="regressing";else Z="stable";let z=$.higher_is_better?"higher better":"lower better",X=$.latest??"n/a";return`  ${(Q+":").padEnd(26)} ${e3($.direction).padEnd(5)} latest=${String(X).padEnd(7)} ${Z.padEnd(11)} [${z}]`}function u0($){let Q=[];if(Q.push(`Loki Mode Trust Trajectory  (snapshot at ${$.generated_at})`),Q.push(`Source: ${$.loki_dir}`),Q.push(`Runs analyzed: ${$.runs_count}`),Q.push(""),$.insufficient){if(Q.push("Not enough history yet."),Q.push("Trust trajectory needs 2+ recorded runs to show a direction."),Q.push("Each `loki start` run writes a proof-of-run; come back after the next run."),$.notes.length>0){Q.push(""),Q.push("Notes");for(let X of $.notes)Q.push(`  - ${X}`)}return Q.join(`
`)}Q.push("Is the agent earning autonomy on this repo?");for(let X of m$)if($.axes[X])Q.push($8($.axes[X]));Q.push("");let{improving_count:Z,regressing_count:z}=$;if(Z&&!z)Q.push(`Overall: trending more trustworthy (${Z} axis improving).`);else if(z&&!Z)Q.push(`Overall: trust regressing (${z} axis regressing). Review recent runs.`);else if(Z||z)Q.push(`Overall: mixed (${Z} improving / ${z} regressing).`);else Q.push("Overall: stable.");if($.notes.length>0){Q.push(""),Q.push("Notes");for(let X of $.notes)Q.push(`  - ${X}`)}return Q.join(`
`)}var c3=1,m$,p3,l3,d3,v0;var c0=L(()=>{m$=["council_pass_rate","gate_pass_rate","iterations","interventions"],p3={council_pass_rate:!0,gate_pass_rate:!0,iterations:!1,interventions:!1},l3={council_pass_rate:0.01,gate_pass_rate:0.01,iterations:0.25,interventions:0.25},d3={council_pass_rate:"Council pass rate",gate_pass_rate:"Gate pass rate",iterations:"Iterations to completion",interventions:"Human interventions"},v0=["APPROVE","APPROVED","COMPLETE","PASS","PASSED"]});var p0={};b(p0,{runTrust:()=>Z8});function Z8($){let Q=!1;for(let X of $){if(X==="--help"||X==="-h"||X==="help")return process.stdout.write(Q8),0;if(X==="--json"){Q=!0;continue}return process.stderr.write(`loki trust: unknown arg: ${X}
Run 'loki trust --help' for usage.
`),1}let Z=P(),z=m0(Z);return f0(Z,z),process.stdout.write(Q?g0(z)+`
`:u0(z)+`
`),0}var Q8=`loki trust -- visible trust trajectory (R4)

Usage:
  loki trust             Pretty-print the per-project trust trajectory
  loki trust --json      Emit the trajectory as JSON
  loki trust --help      Show this help

Shows whether the agent is earning autonomy on THIS repo over time:
  - Council pass rate        (higher is better)
  - Gate pass rate           (higher is better)
  - Iterations to completion (lower is better)
  - Human interventions      (lower is better, when recorded)

Derived read-only from proof-of-run history in .loki/proofs/. With fewer
than 2 recorded runs it reports "not enough history yet" rather than a
fabricated trend. Complements 'loki kpis' (single-run snapshot).
`;var l0=L(()=>{c0();C()});import{closeSync as w$,fstatSync as z8,fsyncSync as d0,lstatSync as X8,mkdirSync as o0,openSync as f$,readSync as K8,renameSync as q8,rmSync as n0,statSync as V8,unlinkSync as a0,writeSync as s0}from"fs";import{dirname as M1}from"path";function T1($,Q){o0(M1($),{recursive:!0});let Z=`${$}.tmp.${process.pid}.${++J8}`,z=f$(Z,"w");try{s0(z,Q),d0(z)}finally{w$(z)}q8(Z,$),U8($)}function U8($){let Q=null;try{Q=f$(M1($),"r"),d0(Q)}catch{}finally{if(Q!==null)try{w$(Q)}catch{}}}function A$($,Q){T1($,`${JSON.stringify(Q,null,2)}
`)}async function r0($,Q){let Z=g$.get($)??Promise.resolve(),z=()=>{},X=new Promise((K)=>{z=K}),q=Z.catch(()=>{}).then(()=>X);g$.set($,q);try{return await Z.catch(()=>{}),await Q()}finally{if(z(),g$.get($)===q)g$.delete($)}}function H8($){return`${$}.lock`}function G8($){if(!Number.isFinite($)||$<=0)return!1;try{return process.kill($,0),!0}catch(Q){return Q?.code==="EPERM"}}function B8($){let Q=null;try{return o0(M1($),{recursive:!0}),Q=f$($,"wx"),s0(Q,`${process.pid}
`),Q}catch(Z){if(Q!==null){try{w$(Q)}catch{}try{a0($)}catch{}}if(Z?.code==="EEXIST")return null;throw Z}}function Y8($,Q){let Z;try{Z=X8($)}catch{return!0}if(Z.isSymbolicLink())try{return a0($),!0}catch{return!1}let z;try{z=f$($,"r")}catch{return!0}try{let X=z8(z);if(Date.now()-X.mtimeMs<Q)return!1;let K=NaN;try{let U=Buffer.alloc(64),J=K8(z,U,0,64,0);K=Number.parseInt(U.subarray(0,J).toString("utf-8").trim(),10)}catch{}if(Number.isFinite(K)&&G8(K))return!1;try{if(V8($).mtimeMs>X.mtimeMs)return!1}catch{return!0}try{n0($,{force:!0})}catch{}return!0}finally{try{w$(z)}catch{}}}function _$($,Q,Z={}){let z=Z.timeoutMs??1e4,X=Z.pollMs??25,q=Z.staleMs??30000,K=H8($),U=Date.now()+z,J=null,W=0,H=new Int32Array(new SharedArrayBuffer(4));while(J===null){if(J=B8(K),J!==null)break;if(Date.now()>U)throw Error(`withFileLockSync: timed out after ${z}ms acquiring ${K}`);if(Y8(K,q))continue;let B=Math.min(X*2**Math.min(W,4),W8);W+=1,Atomics.wait(H,0,0,B)}try{return Q()}finally{try{w$(J)}catch{}try{n0(K,{force:!0})}catch{}}}var J8=0,g$,W8=50;var I$=L(()=>{g$=new Map});import{existsSync as K$,mkdirSync as B$,copyFileSync as $6,readFileSync as A1,readdirSync as M8,statSync as T8,writeFileSync as O8,renameSync as Q6,appendFileSync as Z6,rmSync as w8}from"fs";import{join as m,dirname as u$}from"path";function _8($){let Q=i0.then($,$);return i0=Q.catch((Z)=>{console.warn("[checkpoint] serialized op rejected:",Z);return}),Q}function o($){return m($,"state","checkpoints")}function z6($){return m(o($),"index.jsonl")}async function I8($){let Q=await F(["git","rev-parse","HEAD"],{cwd:$,timeoutMs:5000});if(Q.exitCode!==0)return"no-git";return Q.stdout.trim()||"no-git"}async function L8($){let Q=await F(["git","branch","--show-current"],{cwd:$,timeoutMs:5000});if(Q.exitCode!==0)return"unknown";return Q.stdout.trim()||"unknown"}async function P8($){let Q=await F(["git","diff","--quiet"],{cwd:$,timeoutMs:5000}),Z=await F(["git","diff","--cached","--quiet"],{cwd:$,timeoutMs:5000}),z=Q.exitCode===1,X=Z.exitCode===1;return z||X}function j8($){let Q=m($,"state","orchestrator.json");if(!K$(Q))return"unknown";try{let z=JSON.parse(A1(Q,"utf-8")).currentPhase;return typeof z==="string"&&z.length>0?z:"unknown"}catch{return"unknown"}}function k8($,Q){for(let Z of F8){let z=m($,Z);if(!K$(z))continue;let X=m(Q,Z);B$(u$(X),{recursive:!0});try{$6(z,X)}catch{}}}function K6($,Q){B$(u$($),{recursive:!0});let Z=`${$}.tmp.${process.pid}.${++X6}`;O8(Z,Q),Q6(Z,$)}function R8($){return JSON.stringify($,null,2)}function q6($){return`{${[`"id": ${JSON.stringify($.id)}`,`"ts": ${JSON.stringify($.ts)}`,`"iter": ${JSON.stringify($.iter)}`,`"task": ${JSON.stringify($.task)}`,`"sha": ${JSON.stringify($.sha)}`].join(", ")}}`}async function E8($){return _8(()=>x8($))}async function x8($){let Q=$.lokiDirOverride??P(),Z=process.cwd(),z=o(Q);if(B$(z,{recursive:!0}),!$.forceCreate){if(!await P8(Z))return{created:!1,reason:"no uncommitted changes"}}let X=await I8(Z),q=await L8(Z),K=$.iteration??Number.parseInt(process.env.ITERATION_COUNT??"0",10),U=$.epochOverride??Math.floor(Date.now()/1000),J=`cp-${K}-${U}`,W=m(z,J);B$(W,{recursive:!0}),k8(Q,W);let H=new Date().toISOString().replace(/\.\d{3}Z$/,"Z"),B=($.taskDescription??"task completed").slice(0,A8),G=$.provider??process.env.PROVIDER_NAME??"claude",Y={id:J,timestamp:H,iteration:K,task_id:$.taskId??"unknown",task_description:B,git_sha:X,git_branch:q,provider:G,phase:j8(Q)};K6(m(W,"metadata.json"),R8(Y));let T={id:Y.id,ts:Y.timestamp,iter:Y.iteration,task:Y.task_description,sha:Y.git_sha},M=z6(Q);return _$(M,()=>{Z6(M,`${q6(T)}
`)}),N8(Q),{created:!0,id:J,metadata:Y,dir:W}}function _1($){let Q=o($);if(!K$(Q))return[];return M8(Q).filter((Z)=>Z.startsWith("cp-")).filter((Z)=>{try{return T8(m(Q,Z)).isDirectory()}catch{return!1}})}function I1($){return[...$].sort((Q,Z)=>{let z=e0(Q),X=e0(Z);return z-X})}function e0($){let Q=$.split("-");if(Q.length<3)return 0;let Z=Q[Q.length-1],z=Number.parseInt(Z??"0",10);return Number.isFinite(z)?z:0}function N8($){let Q=_1($);if(Q.length<=t0)return;let Z=I1(Q),z=Z.slice(0,Z.length-t0);for(let X of z)try{w8(m(o($),X),{recursive:!0,force:!0})}catch{}S8($)}function S8($){let Q=I1(_1($)),Z=[];for(let q of Q){let K=m(o($),q,"metadata.json"),U=m(o($),q);if(!K$(K)){O1($,U,"missing_field","metadata.json");continue}try{let J=JSON.parse(A1(K,"utf-8")),W=J6(J,K);if(!W.ok){O1($,U,W.reason,W.field);continue}let H=W.value;Z.push(q6({id:H.id,ts:H.timestamp,iter:H.iteration,task:H.task_description??"",sha:H.git_sha}))}catch{O1($,U,"invalid_type","metadata.json")}}let z=z6($),X=Z.length>0?`${Z.join(`
`)}
`:"";K6(z,X)}function O1($,Q,Z,z){let X=m($,"events.jsonl"),q={timestamp:new Date().toISOString(),type:"checkpoint.metadata.dropped",checkpoint_dir:Q,reason:Z,field:z};try{B$(u$(X),{recursive:!0}),_$(X,()=>{Z6(X,`${JSON.stringify(q)}
`)})}catch{}}function L1($){let Q=$??P(),Z=I1(_1(Q)),z=[];for(let X of Z){let q=V6(Q,X);if(q)z.push(q)}return z}function V6($,Q){let Z=m(o($),Q,"metadata.json");if(!K$(Z))return null;try{let z=JSON.parse(A1(Z,"utf-8"));return D8(z,Z)}catch{return null}}function D8($,Q){let Z=J6($,Q);return Z.ok?Z.value:null}function J6($,Q){if($===null||typeof $!=="object")return console.warn(`[checkpoint] invalid metadata at ${Q}: not an object`),{ok:!1,reason:"invalid_type",field:"<root>"};let Z=$,z=["id","timestamp","task_id","task_description","git_sha","git_branch","provider","phase"];for(let X of z){if(!(X in Z))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "${X}" missing`),{ok:!1,reason:"missing_field",field:X};if(typeof Z[X]!=="string")return console.warn(`[checkpoint] invalid metadata at ${Q}: field "${X}" not a string`),{ok:!1,reason:"invalid_type",field:X}}if(!Object.prototype.hasOwnProperty.call(Z,"iteration"))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "iteration" missing`),{ok:!1,reason:"missing_field",field:"iteration"};if(typeof Z.iteration!=="number"||!Number.isFinite(Z.iteration))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "iteration" not a finite number`),{ok:!1,reason:"invalid_type",field:"iteration"};for(let X of b8){let q=Z[X];if(C8.test(q))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "${X}" contains control characters`),{ok:!1,reason:"control_chars",field:X}}return{ok:!0,value:{id:Z.id,timestamp:Z.timestamp,iteration:Z.iteration,task_id:Z.task_id,task_description:Z.task_description,git_sha:Z.git_sha,git_branch:Z.git_branch,provider:Z.provider,phase:Z.phase}}}function P1($,Q){if(!h8.test($))throw new U6($);let Z=Q??P(),z=m(o(Z),$);if(!K$(z))throw new w1($);let X=V6(Z,$);if(!X)throw new w1($);return X}function W6($,Q){let Z=P1($,Q),z=Q??P(),X=m(o(z),$),q=[];for(let K of y8){let U=m(X,K);if(!K$(U))continue;q.push({from:U,to:m(z,K)})}return{id:$,metadata:Z,restore:q}}function v8($){let Q=[],Z=0;for(let z of $.restore)try{B$(u$(z.to),{recursive:!0});let X=`${z.to}.tmp.${process.pid}.${++X6}`;$6(z.from,X),Q6(X,z.to),Z+=1}catch(X){Q.push(`${z.from} -> ${z.to}: ${X.message}`)}return{restored:Z,errors:Q}}async function H6($,Q,Z=!1){let z=null;try{let q=await E8({taskDescription:`pre-rollback snapshot (before restoring ${$.id})`,taskId:"rollback",forceCreate:!0,lokiDirOverride:Q});if(q.created)z=q.id}catch(q){let K=q instanceof Error?q.message:String(q);if(!Z)throw Error("pre-rollback snapshot failed ("+K+"); aborting rollback to preserve current state. Re-run with force to roll back anyway without a safety snapshot.");console.warn("[checkpoint] pre-rollback snapshot failed; proceeding due to force:",K)}let X=v8($);return{preRollbackSnapshotId:z,restored:X.restored,errors:X.errors}}var t0=50,A8=200,i0,F8,X6=0,C8,b8,h8,w1,U6,y8;var G6=L(()=>{C();d();I$();i0=Promise.resolve();F8=["state/orchestrator.json","autonomy-state.json","queue/pending.json","queue/completed.json","queue/in-progress.json","queue/current-task.json","CONTINUITY.md"];C8=/[\x00-\x08\x0a-\x1f\x7f-\x9f]/,b8=["id","task_id","git_sha","git_branch","provider","phase"];h8=/^[a-zA-Z0-9_-]+$/;w1=class w1 extends Error{id;constructor($){super(`Checkpoint not found: ${$}`);this.id=$;this.name="CheckpointNotFoundError"}};U6=class U6 extends Error{id;constructor($){super(`Invalid checkpoint ID: must be alphanumeric, hyphens, underscores only (got: ${$})`);this.id=$;this.name="InvalidCheckpointIdError"}};y8=["state/orchestrator.json","queue/pending.json","queue/completed.json","queue/in-progress.json","queue/current-task.json","CONTINUITY.md"]});var M6={};b(M6,{runRollback:()=>m8});async function m8($){let Q=$[0],Z=$.slice(1);if(Q===void 0||Q==="help"||Q==="--help"||Q==="-h")return process.stdout.write(B6),Q===void 0?1:0;switch(Q){case"list":{let z=[...L1()].reverse();if(z.length===0)return process.stdout.write(`${_}No checkpoints found.${V}
`),0;process.stdout.write(`${k}Checkpoints${V} (${z.length}, newest first):
`);for(let X of z)process.stdout.write(`  ${I}${X.id}${V}  iter=${X.iteration}  ${X.git_branch||"(no branch)"}@${(X.git_sha||"").slice(0,7)}  ${X.timestamp}
`);return 0}case"show":{let z=Z[0];if(!z)return process.stderr.write(`${O}Missing checkpoint id.${V} Use \`loki rollback list\`.
`),2;try{let X=P1(z);return process.stdout.write(`${JSON.stringify(X,null,2)}
`),0}catch(X){return process.stderr.write(`${O}Failed to read checkpoint:${V} ${X.message}
`),1}}case"to":{let z=Z[0];if(!z)return process.stderr.write(`${O}Missing checkpoint id.${V} Use \`loki rollback list\`.
`),2;return await Y6(z,Z.includes("--force"))}case"latest":{let z=L1(),X=z[z.length-1];if(!X)return process.stderr.write(`${O}No checkpoints found to roll back to.${V}
`),1;return process.stdout.write(`Rolling back to latest checkpoint: ${I}${X.id}${V}
`),await Y6(X.id,Z.includes("--force"))}default:return process.stderr.write(`Unknown subcommand: ${Q}
`),process.stderr.write(B6),2}}async function Y6($,Q=!1){let Z;try{Z=W6($)}catch(X){return process.stderr.write(`${O}Cannot plan rollback:${V} ${X.message}
`),1}if(Z.restore.length===0)return process.stdout.write(`${_}Checkpoint ${$} has no restorable state files; nothing to do.${V}
`),0;let z;try{z=await H6(Z,void 0,Q)}catch(X){return process.stderr.write(`${O}Rollback aborted:${V} ${X.message}
`),1}if(z.errors.length>0){for(let X of z.errors)process.stderr.write(`${O}restore error:${V} ${X}
`);return process.stderr.write(`${O}Partial rollback: ${z.restored}/${Z.restore.length} files restored.${V}
`),1}if(process.stdout.write(`${S}Rolled back ${z.restored}/${Z.restore.length} state files from ${$}.${V}
`),z.preRollbackSnapshotId)process.stdout.write(`Saved your prior state as ${I}${z.preRollbackSnapshotId}${V}; undo this rollback with \`loki rollback to ${z.preRollbackSnapshotId}\`.
`);return process.stdout.write("Run `loki start` to resume from the restored state.\n"),0}var B6=`Usage: loki rollback <subcommand>

Subcommands:
  list                   List checkpoints (newest first)
  show <id>              Print metadata for one checkpoint
  to <id>                Restore .loki/ state + context to that checkpoint
  latest                 Restore to the most recent checkpoint

Restored automatically (safe, non-code):
  .loki/state/orchestrator.json
  .loki/queue/{pending,completed,in-progress,current-task}.json
  .loki/CONTINUITY.md            (iteration / conversation handoff context)

Re-undoable: every rollback first captures a forced pre-rollback snapshot of
your current state, so you can always undo the undo (the snapshot id is printed).

Source code is NOT touched by this command. To also restore the working tree
to the checkpoint's snapshot (if one was anchored at checkpoint time):
  git stash apply refs/loki/cp/<id>

Re-run \`loki start\` to resume from the restored state.
`;var T6=L(()=>{G6();c()});function g8(){return process.env.LOKI_TIER||"oss"}function O6($){let Q=g8();if(Q==="oss")return{allowed:!0,notes:[]};if(!process.env.LOKI_LICENSE_KEY)return{allowed:!1,notes:[`${_}LOKI_TIER='${Q}' requested but no LOKI_LICENSE_KEY set.${V}`,`Hosted/enterprise license verification is not available yet (capability: ${$}).`,"OSS users: leave LOKI_TIER unset (or 'oss') -- everything stays free."]};return{allowed:!0,notes:[`${_}LOKI_LICENSE_KEY set but the verification backend is not available yet (R9 seam).${V}`]}}var w6=L(()=>{c()});var _6={};b(_6,{runProof:()=>$7});import{existsSync as L$,readdirSync as f8,readFileSync as A6,mkdtempSync as u8,copyFileSync as c8,rmSync as p8}from"fs";import{join as e}from"path";import{tmpdir as l8}from"os";import{createInterface as d8}from"readline";import{readFile as o8}from"fs/promises";function $$($){return $&&typeof $==="object"?$:{}}function p($){return $===void 0||$===null?"-":String($)}function P$(){return e(P(),"proofs")}function j1($){let Q=e(P$(),$,"proof.json");if(!L$(Q))return null;try{return JSON.parse(A6(Q,"utf8"))}catch{return{}}}function i($,Q){return $.length>=Q?$:$+" ".repeat(Q-$.length)}function a8(){let $=P$();if(!L$($))return process.stdout.write(`${_}No proofs found.${V} Run 'loki start' to generate one.
`),0;let Q=[];try{Q=f8($,{withFileTypes:!0}).filter((z)=>z.isDirectory()).map((z)=>z.name).sort()}catch{Q=[]}let Z=[];for(let z of Q){let X=e($,z,"proof.json");if(!L$(X))continue;let q={};try{q=JSON.parse(A6(X,"utf8"))}catch{q={}}let K=p(q.run_id),U=p(q.generated_at),J=p($$(q.council).final_verdict),W=p($$(q.cost).usd),H=p($$(q.files_changed).count);Z.push(`${i(K,26)}  ${i(U,20)}  ${i(J,10)}  ${i(W,9)}  ${H}`)}if(Z.length===0)return process.stdout.write(`${_}No proofs found.${V} Run 'loki start' to generate one.
`),0;process.stdout.write(`${i("RUN_ID",26)}  ${i("GENERATED_AT",20)}  ${i("VERDICT",10)}  ${i("COST_USD",9)}  FILES
`);for(let z of Z)process.stdout.write(`${z}
`);return 0}function s8($){if(!$)return process.stderr.write(`${O}Missing proof id.${V} Use 'loki proof list'.
`),2;let Q=j1($);if(Q===null)return process.stderr.write(`${O}Proof not found: ${$}${V}
`),process.stderr.write(`Use 'loki proof list' to see available proofs.
`),1;return process.stdout.write(`${JSON.stringify(Q,null,2)}
`),0}async function r8($){if(!$)return process.stderr.write(`${O}Missing proof id.${V} Use 'loki proof list'.
`),2;let Q=e(P$(),$,"index.html");if(!L$(Q))return process.stderr.write(`${O}Proof page not found: ${$}/index.html${V}
`),process.stderr.write(`Use 'loki proof list' to see available proofs.
`),1;process.stdout.write(`${S}Opening proof: ${Q}${V}
`);for(let Z of["open","xdg-open","start"])try{if((await F([Z,Q],{timeoutMs:5000})).exitCode===0)return 0}catch{}return process.stdout.write(`
Could not detect browser opener.
`),process.stdout.write(`Please open in browser: ${Q}
`),0}function t8($){return new Promise((Q)=>{let Z=d8({input:process.stdin,output:process.stdout});Z.question($,(z)=>{Z.close();let X=z.trim().toLowerCase();Q(X==="y"||X==="yes")})})}async function i8($,Q,Z){let z=O6("hosted_publish");for(let G of z.notes)process.stderr.write(`${G}
`);let X=process.env.LOKI_HOSTED_ENDPOINT||"";if(!X)return process.stderr.write(`${_}Hosted publishing backend not available.${V}
`),process.stderr.write(`There is no official Loki hosted service yet (R9 ships the seam, not a live backend).
`),process.stderr.write(`To publish to your own hosted endpoint, set LOKI_HOSTED_ENDPOINT to its URL.
`),process.stderr.write(`Or publish to a GitHub Gist instead: loki proof share ${$}
`),1;let q=j1($);if(q){if($$(q.redaction).applied!==!0)return process.stderr.write(`${O}Refusing to publish: proof redaction was not confirmed applied.${V}
`),process.stderr.write(`Regenerate the proof (LOKI_PROOF=1) so the redactor runs, then retry.
`),1}process.stdout.write(`${k}Publishing proof '${$}' to hosted endpoint${V}
`),process.stdout.write(`  endpoint: ${X}
`),process.stdout.write(`  payload:  ${Q} (already redacted by the generator)

`);let K;try{K=await o8(Q)}catch{return process.stderr.write(`${O}Could not read proof page: ${Q}${V}
`),1}let U={"Content-Type":"text/html","X-Loki-Proof-Id":$},J=process.env.LOKI_LICENSE_KEY||"";if(J)U.Authorization=`Bearer ${J}`;let W;try{W=await fetch(X,{method:"POST",headers:U,body:new Uint8Array(K)})}catch(G){return process.stderr.write(`${O}Failed to reach hosted endpoint: ${String(G.message||G)}${V}
`),process.stderr.write(`Check LOKI_HOSTED_ENDPOINT or publish to a gist: loki proof share ${$}
`),1}let H=await W.text();if(!W.ok){if(process.stderr.write(`${O}Hosted endpoint returned HTTP ${W.status}.${V}
`),H)process.stderr.write(`Response:
`),process.stderr.write(`${H.slice(0,500)}
`);return process.stderr.write(`Nothing was published. Or publish to a gist: loki proof share ${$}
`),1}let B="";try{let G=JSON.parse(H);if(G&&typeof G==="object"){let Y=G.url??G.public_url;if(typeof Y==="string")B=Y}}catch{}if(B)process.stdout.write(`${S}Published: ${B}${V}
`);else process.stdout.write(`${S}Published to ${X} (HTTP ${W.status}).${V}
`),process.stdout.write(`The endpoint did not return a 'url' field; check your endpoint's response.
`);return 0}async function e8($){let Q="",Z=!1,z="--public",X=!1;for(let M of $)if(M==="--yes"||M==="-y")Z=!0;else if(M==="--private")z="";else if(M==="--public")z="--public";else if(M==="--hosted")X=!0;else if(M.startsWith("-"))return process.stderr.write(`${O}Unknown option: ${M}${V}
`),1;else Q=M;if(!Q)return process.stderr.write(`${O}Missing proof id.${V} Use 'loki proof list'.
`),2;let q=e(P$(),Q,"index.html");if(!L$(q))return process.stderr.write(`${O}Proof page not found: ${Q}/index.html${V}
`),process.stderr.write(`Use 'loki proof list' to see available proofs.
`),1;if(X)return i8(Q,q,e(P$(),Q,"proof.json"));if((await F(["gh","--version"],{timeoutMs:5000})).exitCode!==0)return process.stderr.write(`${O}gh CLI not found${V}
`),process.stderr.write(`Install the GitHub CLI to publish a proof:
`),process.stderr.write(`  brew install gh        # macOS
`),process.stderr.write(`  sudo apt install gh    # Ubuntu/Debian
`),process.stderr.write(`  https://cli.github.com # Other platforms
`),1;if((await F(["gh","auth","status"],{timeoutMs:1e4})).exitCode!==0)return process.stderr.write(`${O}GitHub CLI not authenticated${V}
`),process.stderr.write(`Run 'gh auth login' to authenticate, then try again.
`),1;let J=z===""?"secret":"public";process.stdout.write(`${k}Publishing proof '${Q}' as a ${J} GitHub Gist${V}

`),process.stdout.write(`What will be shared:
`),process.stdout.write(`  - ${q}
`);let W=j1(Q);if(W){let M=p($$(W.cost).usd),R=p($$(W.files_changed).count),N=p($$(W.council).final_verdict),v=$$(W.redaction);process.stdout.write(`  - cost.usd:        ${M}
`),process.stdout.write(`  - files_changed:   ${R}
`),process.stdout.write(`  - council verdict: ${N}
`),process.stdout.write(`  - redaction:       applied=${p(v.applied)} rules_version=${p(v.rules_version)} redactions_count=${p(v.redactions_count)}
`)}if(process.stdout.write(`
${_}Secrets, API keys, tokens, env values, and absolute paths have already been stripped by the generator.${V}

`),!Z){if(!await t8(`Publish this proof to a ${J} gist? [y/N] `))return process.stdout.write(`Aborted. Nothing was published.
`),0}let H=u8(e(l8(),"loki-proof-")),B=e(H,"index.html");c8(q,B),process.stdout.write(`Uploading proof page...
`);let G=`Loki Mode proof-of-run ${Q}`,Y=["gh","gist","create",B,"--desc",G];if(z!=="")Y.push(z);let T=await F(Y,{timeoutMs:60000});try{p8(H,{recursive:!0,force:!0})}catch{}if(T.exitCode!==0)return process.stderr.write(`${O}Failed to create gist${V}
`),process.stderr.write(`${T.stdout}${T.stderr}
`),1;return process.stdout.write(`${S}Shared: ${T.stdout.trim()}${V}
`),0}async function $7($){let Q=$[0],Z=$.slice(1);if(Q===void 0||Q==="help"||Q==="--help"||Q==="-h")return process.stdout.write(n8),Q===void 0?1:0;switch(Q){case"list":return a8();case"show":return s8(Z[0]);case"open":return r8(Z[0]);case"share":return e8(Z);default:return process.stderr.write(`${O}Unknown subcommand: ${Q}${V}
`),process.stderr.write(`Run 'loki proof --help' for usage.
`),1}}var n8;var I6=L(()=>{C();d();c();w6();n8=`${k}loki proof${V} - inspect and share proof-of-run artifacts

Usage: loki proof <subcommand> [args]

Subcommands:
  list                 List proof-of-run artifacts in .loki/proofs/
  show <id>            Pretty-print .loki/proofs/<id>/proof.json
  open <id>            Open .loki/proofs/<id>/index.html in a browser
  share <id>           Publish the proof page as a GitHub Gist (opt-in)

Options for 'share':
  --yes                Skip the redaction-preview confirmation prompt
  --private            Create a secret gist (default: public)
  --hosted             Publish to LOKI_HOSTED_ENDPOINT (open-core seam; no official backend yet)

Proofs are generated automatically at run completion (LOKI_PROOF=0 to opt out).
`});var R6={};b(R6,{runCrash:()=>U7});import{existsSync as P6,readdirSync as Q7,readFileSync as Z7}from"fs";import{join as j6}from"path";function j$($){return $===void 0||$===null?"-":String($)}function c$($,Q){return $.length>=Q?$:$+" ".repeat(Q-$.length)}function F6(){return j6(P(),"crash")}function F1(){let $=F6();if(!P6($))return[];try{return Q7($,{withFileTypes:!0}).filter((Q)=>Q.isFile()&&Q.name.endsWith(".json")).map((Q)=>Q.name.slice(0,-5)).sort()}catch{return[]}}function X7($){if($.length===0)return!1;if($.includes("/")||$.includes("\\"))return!1;if($.includes(".."))return!1;return!0}function p$($){if(!X7($))return null;let Q=j6(F6(),`${$}.json`);if(!P6(Q))return null;try{return JSON.parse(Z7(Q,"utf8"))}catch{return{}}}function K7(){let $=F1();if($.length===0)return process.stdout.write(`${_}No crash reports found.${V} Nothing has been captured in .loki/crash/.
`),0;process.stdout.write(`${c$("ID",40)}  ${c$("CAPTURED_AT",22)}  ERROR_CLASS
`);for(let Q of $){let Z=p$(Q)??{},z=j$(Z.fingerprint),X=j$(Z.captured_at),q=j$(Z.error_class),K=z!=="-"?z:Q;process.stdout.write(`${c$(K,40)}  ${c$(X,22)}  ${q}
`)}return process.stdout.write(`
${$.length} report(s). Run 'loki crash show <id>' to inspect, 'loki crash submit' to get a prefilled GitHub issue URL.
`),0}function k6($){let Q=p$($);if(Q!==null)return{id:$,report:Q};for(let Z of F1()){let z=p$(Z);if(z&&String(z.fingerprint??"")===$)return{id:Z,report:z}}return null}function q7($){if(!$)return process.stderr.write(`${O}Missing crash id.${V} Use 'loki crash' to list reports.
`),2;let Q=k6($);if(Q===null)return process.stderr.write(`${O}Crash report not found: ${$}${V}
`),process.stderr.write(`Use 'loki crash' to see available reports.
`),1;return process.stdout.write(`${JSON.stringify(Q.report,null,2)}
`),0}function V7($){let Q=j$($.error_class),Z=j$($.fingerprint),z=Z!=="-"?Z.slice(0,12):"unknown",X=`crash: ${Q} (${z})`,K=["Anonymous crash report captured by Loki Mode (scrubbed, whitelist-only).","","Scrubbed payload:","```json",JSON.stringify($,null,2),"```","","Nothing was sent automatically. This issue is submitted manually by me."].join(`
`),U=new URLSearchParams({title:X,body:K});return`${z7}?${U.toString()}`}function J7($){let Q;if($){if(Q=k6($),Q===null)return process.stderr.write(`${O}Crash report not found: ${$}${V}
`),process.stderr.write(`Use 'loki crash' to see available reports.
`),1}else{let Z=F1();if(Z.length===0)return process.stdout.write(`${_}No crash reports found.${V} Nothing to submit.
`),0;let z=Z[Z.length-1],X=p$(z)??{};Q={id:z,report:X}}return process.stdout.write(`${k}Scrubbed payload (this is the ENTIRE report):${V}
`),process.stdout.write(`${JSON.stringify(Q.report,null,2)}

`),process.stdout.write(`${_}Nothing is sent automatically in this version.${V} Loki Mode never transmits crash data on its own.
`),process.stdout.write(`To submit manually, open this prefilled GitHub issue and review it first:

`),process.stdout.write(`  ${I}${V7(Q.report)}${V}

`),process.stdout.write(`${S}The payload above is exactly what the URL contains.${V}
`),process.stdout.write(`See docs/PRIVACY.md for what is and is not collected.
`),0}async function U7($){let Q=$[0];switch(Q){case void 0:case"list":return K7();case"--help":case"-h":case"help":return process.stdout.write(L6),0;case"show":return q7($[1]);case"submit":return J7($[1]);default:return process.stderr.write(`${O}Unknown crash subcommand: ${Q}${V}
`),process.stdout.write(L6),2}}var z7="https://github.com/asklokesh/loki-mode/issues/new",L6;var E6=L(()=>{C();c();L6=`${k}loki crash${V} - inspect and manually submit local crash reports

Usage: loki crash [subcommand] [args]

Subcommands:
  (none) | list        List crash reports in .loki/crash/
  show <id>            Pretty-print one scrubbed crash report
  submit [<id>]        Print the scrubbed payload and a prefilled GitHub
                       issue URL for manual submission

Crash reports are anonymous, scrubbed, and stored locally only. Nothing is
sent automatically in this version. See docs/PRIVACY.md.
`});var D6={};b(D6,{runWiki:()=>Y7});import{existsSync as k1,readFileSync as x6}from"fs";import{join as R1,resolve as W7}from"path";function G7(){return R1(process.cwd(),".loki","wiki")}function B7($){let Q="";for(let X of $){if(X==="--help"||X==="-h")return process.stdout.write(`Usage: loki wiki show [section]
Sections: architecture, modules, data-flow
`),0;if(X.startsWith("-"))return process.stderr.write(`${O}Unknown option: ${X}${V}
`),1;Q=X}let Z=G7();if(!k1(Z))return process.stderr.write(`${_}No wiki found. Run 'loki wiki generate' first.${V}
`),1;if(Q){if(!H7.has(Q))return process.stderr.write(`${O}No such section: ${Q} (try: architecture, modules, data-flow)${V}
`),1;let X=R1(Z,`${Q}.md`);if(!k1(X))return process.stderr.write(`${O}Section not generated: ${Q}${V}
`),1;return process.stdout.write(x6(X,"utf8")),0}let z=R1(Z,"index.md");if(!k1(z))return process.stderr.write(`${O}Wiki index not found. Run 'loki wiki generate'.${V}
`),1;return process.stdout.write(x6(z,"utf8")),0}async function S6($,Q){let Z=W7(g,"autonomy","loki"),z=3600000,X=Bun.spawn({cmd:[Z,"wiki",$,...Q],stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,LOKI_LEGACY_BASH:"1"}}),q=setTimeout(()=>{try{X.kill("SIGKILL")}catch{}},3600000);try{return await X.exited}finally{clearTimeout(q)}}async function Y7($){let Q=$[0],Z=$.slice(1);switch(Q){case void 0:case"help":case"--help":case"-h":return process.stdout.write(N6),0;case"show":return B7(Z);case"generate":return S6("generate",Z);case"ask":return S6("ask",Z);default:return process.stderr.write(`${O}Unknown wiki command: ${Q}${V}
`),process.stdout.write(N6),1}}var N6,H7;var C6=L(()=>{C();c();N6=`${k}loki wiki${V} - Auto-generated, cited codebase wiki + Q&A

Usage: loki wiki <command> [options]

Commands:
  generate [path] [--force]   Build/refresh the cited wiki in .loki/wiki/
  show [section]              Print the wiki (or one section: architecture|modules|data-flow)
  ask "<question>"           Cited answer grounded in the codebase (file:line)

Each wiki section cites the real source files it was built from.
Generation is incremental: it skips when the codebase is unchanged.

Examples:
  loki wiki generate
  loki wiki show architecture
  loki wiki ask "how does the cli dispatch commands"
`,H7=new Set(["architecture","modules","data-flow"])});var x1={};b(x1,{renderFindingsForPrompt:()=>A7,loadPreviousFindings:()=>E1,findLatestReviewDir:()=>m6,_parseReviewerOutputForTests:()=>_7});import{existsSync as h6,readFileSync as b6,readdirSync as y6,statSync as M7}from"fs";import{join as l$}from"path";function w7($){let Q=$.toLowerCase();if(Q==="critical")return"Critical";if(Q==="high")return"High";if(Q==="medium")return"Medium";return"Low"}function v6($,Q,Z,z){let X=[],q=$.split(/\r?\n/);for(let K of q){let U=K.trim();if(U.length===0)continue;let J=U.replace(/^[-*]\s*/,""),W=T7.exec(J);if(!W||!W[1]||!W[2])continue;let H=w7(W[1]),B=W[2].trim(),G=O7.exec(B),Y=G&&G[1]?G[1]:null,T=G&&G[2]?Number.parseInt(G[2],10):null;X.push({reviewId:Z,iteration:z,reviewer:Q,severity:H,description:B,file:Y,line:Number.isFinite(T)?T:null,raw:U})}return X}function m6($,Q){let Z=l$($,"quality","reviews");if(!h6(Z))return null;let z;try{z=y6(Z)}catch{return null}let X=Q===void 0?z.filter((U)=>U.startsWith("review-")):z.filter((U)=>U.endsWith(`-${Q}`)&&U.startsWith("review-"));if(X.length===0)return null;X.sort();let q=X[X.length-1];if(!q)return null;let K=l$(Z,q);try{if(!M7(K).isDirectory())return null}catch{return null}return K}function E1($,Q){let Z=m6($,Q);if(Z===null)return{reviewDir:null,reviewId:null,iteration:null,findings:[]};let z=null,X=null,q=l$(Z,"aggregate.json");if(h6(q))try{let W=b6(q,"utf-8"),H=JSON.parse(W);if(typeof H.review_id==="string")z=H.review_id;if(typeof H.iteration==="number")X=H.iteration}catch{}let K;try{K=y6(Z)}catch{return{reviewDir:Z,reviewId:z,iteration:X,findings:[]}}let U=new Set(["diff.txt","files.txt","anti-sycophancy.txt"]),J=[];for(let W of K){if(!W.endsWith(".txt"))continue;if(U.has(W))continue;if(W.endsWith("-prompt.txt"))continue;let H=W.replace(/\.txt$/,""),B;try{B=b6(l$(Z,W),"utf-8")}catch{continue}J.push(...v6(B,H,z??"",X??-1))}return{reviewDir:Z,reviewId:z,iteration:X,findings:J}}function A7($){if($.length===0)return"";let Q=["Critical","High","Medium","Low"],Z=new Map;for(let X of Q)Z.set(X,[]);for(let X of $){let q=Z.get(X.severity);if(q)q.push(X)}let z=[];z.push("PREVIOUS REVIEWER FINDINGS (must address each, or supply counter-evidence in .loki/state/counter-evidence-<iter>.json):");for(let X of Q){let q=Z.get(X)??[];if(q.length===0)continue;z.push(`  [${X}] (${q.length}):`);for(let K of q){let U=K.file?` (${K.file}${K.line!==null?":"+K.line:""})`:"";z.push(`    - ${K.description}${U} -- via ${K.reviewer}`)}}return z.join(`
`)}function _7($,Q,Z="review-test",z=0){return v6($,Q,Z,z)}var T7,O7;var d$=L(()=>{T7=/\[(Critical|High|Medium|Low)\]\s*(.+)/i,O7=/([\w.\-/]+\.[a-zA-Z]+):(\d+)/});import{existsSync as I7}from"fs";import{join as L7}from"path";async function g6($,Q){let Z=L7($,"memory");if(!I7(Z))return{stored:!1,reason:"memory dir not initialized"};let z=Math.max(0,Math.floor(Q.durationSeconds??0)),X={_LOKI_PROJECT_DIR:g,_LOKI_TARGET_DIR:process.cwd(),_LOKI_TASK_ID:Q.taskId,_LOKI_OUTCOME:Q.outcome,_LOKI_PHASE:Q.phase,_LOKI_GOAL:Q.goal,_LOKI_DURATION:String(z),_LOKI_LOKI_DIR:$},K=await z$(`
import os, sys
project = os.environ.get('_LOKI_PROJECT_DIR', '')
loki = os.environ.get('_LOKI_LOKI_DIR', '.loki')
task_id = os.environ.get('_LOKI_TASK_ID', '')
outcome = os.environ.get('_LOKI_OUTCOME', '')
phase = os.environ.get('_LOKI_PHASE', '')
goal = os.environ.get('_LOKI_GOAL', '')
duration = os.environ.get('_LOKI_DURATION', '0')
sys.path.insert(0, project)
try:
    from memory.engine import MemoryEngine
    from memory.schemas import EpisodeTrace
    engine = MemoryEngine(loki + '/memory')
    engine.initialize()
    trace = EpisodeTrace.create(
        task_id=task_id,
        agent='loki-orchestrator',
        phase=phase,
        goal=goal,
        outcome=outcome,
        duration_seconds=int(duration) if duration.isdigit() else 0,
    )
    engine.store_episode(trace)
    print('OK')
except Exception as e:
    print('ERR:' + str(e))
`,{env:X,timeoutMs:15000});if(K.exitCode===127)return{stored:!1,reason:"python3 not found"};let U=K.stdout.trim();if(U==="OK")return{stored:!0,reason:"stored"};if(U.startsWith("ERR:"))return{stored:!1,reason:U.replace(/^ERR:/,"")};return{stored:!1,reason:K.stderr.trim()||"unknown"}}var f6=L(()=>{V$();C()});var l6={};b(l6,{loadLearnings:()=>N1,appendLearning:()=>F$,appendFromGateFailure:()=>N7});import{existsSync as P7,readFileSync as j7}from"fs";import{join as u6}from"path";import{createHash as F7}from"crypto";function c6($){return u6($,k7)}function R7($){if($===null||typeof $!=="object")return!1;let Q=$;return typeof Q.id==="string"&&typeof Q.timestamp==="string"&&typeof Q.iteration==="number"&&typeof Q.trigger==="string"&&typeof Q.rootCause==="string"&&typeof Q.fix==="string"&&typeof Q.preventInFuture==="string"&&typeof Q.evidence==="object"&&Q.evidence!==null}function p6($){if(!P7($))return{version:1,learnings:[]};try{let Q=j7($,"utf-8"),Z=JSON.parse(Q);if(Z.version===1&&Array.isArray(Z.learnings))return{version:1,learnings:Z.learnings.filter(R7)}}catch{}return{version:1,learnings:[]}}function E7($,Q,Z){return F7("sha256").update(`${$} ${Q} ${Z??""}`).digest("hex").slice(0,16)}async function F$($,Q,Z={}){let z=E7(Q.trigger,Q.rootCause,Q.evidence.file),X=new Date().toISOString(),q={id:z,timestamp:X,...Q},K=c6($);if(await r0(K,()=>{_$(K,()=>{let J=p6(K),W=J.learnings.findIndex((H)=>H.id===z);if(W>=0){let H=J.learnings[W];J.learnings[W]={...H,timestamp:X,iteration:q.iteration}}else J.learnings.push(q);A$(K,J)})}),Z.episodeBridge!==null&&(Z.episodeBridge!==void 0||process.env.LOKI_AUTO_LEARNINGS_EPISODE==="1")){let J=Z.episodeBridge??g6,W=Z.bridgeFailureLog??x7;try{let H=await J($,{taskId:`learning-${z}`,outcome:"failure",phase:"VERIFY",goal:`${Q.trigger}: ${Q.rootCause}`});if(H&&!H.stored){if(!new Set(["memory dir not initialized","stub"]).has(H.reason))W(`episode_bridge skipped: ${H.reason}`)}}catch(H){W(`episode_bridge threw: ${H.message}`)}}return q}function x7($){process.stderr.write(`[learnings_writer] ${$}
`)}async function N7($,Q,Z,z={}){let X=`[${Z.severity}] ${Z.description}`;return F$($,{iteration:Q,trigger:"gate_failure",rootCause:X,fix:"pending: dev agent must address in next iteration or supply counter-evidence",preventInFuture:"if this finding recurs, lower its severity threshold or add a regression test",evidence:{reviewId:Z.reviewId,file:Z.file??void 0,line:Z.line??void 0,severity:Z.severity,reviewer:Z.reviewer}},z)}function N1($){return p6(c6($))}var k7;var o$=L(()=>{I$();f6();k7=u6("state","relevant-learnings.json")});var o6={};b(o6,{runOverrideCouncil:()=>y7,recordOverrideOutcome:()=>v7,loadCounterEvidence:()=>h7,canonicalFindingId:()=>n$,DEFAULT_OVERRIDE_JUDGES:()=>d6});import{existsSync as S7,readFileSync as D7}from"fs";import{join as C7}from"path";function h7($,Q){let Z=C7($,"state",`counter-evidence-${Q}.json`);if(!S7(Z))return null;try{let z=D7(Z,"utf-8"),X=JSON.parse(z);if(typeof X.iteration!=="number")return null;let q=Array.isArray(X.evidence)?X.evidence:[],K=[];for(let U of q){if(typeof U!=="object"||U===null)continue;let J=U;if(typeof J.findingId!=="string")continue;if(typeof J.claim!=="string")continue;let W=J.proofType;if(typeof W!=="string"||!b7.has(W))continue;let H=W,B=Array.isArray(J.artifacts)?J.artifacts:[];K.push({findingId:J.findingId,claim:J.claim,proofType:H,artifacts:B.filter((G)=>typeof G==="string")})}return{iteration:X.iteration,evidence:K}}catch{return null}}async function y7($,Q,Z,z={}){let X=z.judges??d6,q=new Set,K=new Set,U={},J=new Map;for(let H of Q.evidence)J.set(H.findingId,H);let W=new Map;for(let H of $){let B=n$(H);W.set(B,(W.get(B)??0)+1)}for(let H of $){let B=n$(H);if((W.get(B)??0)>1){K.add(B);continue}let G=J.get(B);if(!G){K.add(B);continue}let Y=await Promise.all(X.map((M)=>Z({finding:H,evidence:G,judge:M})));if(U[B]=Y,Y.filter((M)=>M.verdict==="APPROVE_OVERRIDE").length>=2)q.add(B);else K.add(B)}return{approvedFindingIds:q,rejectedFindingIds:K,votes:U}}function n$($){let Q=$.raw.slice(0,80).replace(/\s+/g," ").trim();return`${$.reviewer}::${Q}`}async function v7($,Q,Z,z,X={}){let q={episodeBridge:X.episodeBridge===void 0?null:X.episodeBridge};for(let K of z){let U=n$(K);if(Z.approvedFindingIds.has(U))await F$($,{iteration:Q,trigger:"override_approved",rootCause:`[${K.severity}] ${K.description}`,fix:"override council approved counter-evidence; finding lifted",preventInFuture:"if this reviewer/file pair recurs, narrow the reviewer's selector OR add a baseline doc",evidence:{findingId:U,reviewId:K.reviewId,file:K.file??void 0,line:K.line??void 0,severity:K.severity,reviewer:K.reviewer}},q);else if(Z.rejectedFindingIds.has(U))await F$($,{iteration:Q,trigger:"override_rejected",rootCause:`[${K.severity}] ${K.description}`,fix:"override council rejected -- dev agent must fix the finding",preventInFuture:"address this finding in the next iteration",evidence:{findingId:U,reviewId:K.reviewId,file:K.file??void 0,line:K.line??void 0,severity:K.severity,reviewer:K.reviewer}},q)}}var b7,d6;var n6=L(()=>{o$();b7=new Set(["file-exists","test-passes","grep-miss","reviewer-misread","duplicate-code-path","out-of-scope"]);d6=["judge-primary","judge-secondary","judge-tertiary"]});var s6={};b(s6,{writeEscalationHandoff:()=>o7,renderHandoff:()=>a6,readLatestHandoff:()=>n7});import{existsSync as m7,readdirSync as g7,readFileSync as f7}from"fs";import{join as a$}from"path";function u7(){return new Date().toISOString()}function c7($){let Q=$.file?` (${$.file}${$.line!==null?":"+$.line:""})`:"";return`  - [${$.severity}] ${$.description}${Q} -- ${$.reviewer}`}function p7($){let Q=$.evidence,Z=Q.file?` ${Q.file}${Q.line!==void 0?":"+Q.line:""}`:"";return`  - **${$.trigger}** (iter ${$.iteration})${Z}: ${$.rootCause}`}function a6($,Q,Z){let z=[];if(z.push(`# Loki escalation handoff -- ${u7()}`),z.push(""),z.push(`Gate **${$.gateName}** has failed ${$.consecutiveFailures} consecutive times at iteration ${$.iteration}.`),z.push(""),z.push(`Reason: ${$.detail}`),z.push(""),Q.length>0){z.push(`## Outstanding findings (${Q.length})`),z.push("");for(let X of Q)z.push(c7(X));z.push("")}else z.push("## Outstanding findings"),z.push(""),z.push("(no per-finding records captured -- gate failed without populating reviewer outputs)"),z.push("");if(Z.length>0){z.push(`## Recent learnings (${Math.min(Z.length,10)})`),z.push("");for(let X of Z.slice(-10))z.push(p7(X));z.push("")}return z.push("## What the human must decide"),z.push(""),z.push("- Fix the finding? Address it in the code, then `rm .loki/PAUSE` to resume. A code_review BLOCK is NOT lifted by self-supplied counter-evidence -- the gated agent authors that file, so it cannot self-certify a trust-gate finding away."),z.push('- Override after your own review? You (the operator) are the escape path: review the finding and, if you accept it, `rm .loki/PAUSE` to resume. To direct the agent on resume, `echo "instructions" > .loki/HUMAN_INPUT.md` first.'),z.push("- Disable a gate? Set `LOKI_GATE_<NAME>=false` in env (see skills/quality-gates.md)."),z.push("- Tweak escalation? Set `LOKI_GATE_PAUSE_LIMIT` or `LOKI_GATE_ESCALATE_LIMIT`."),z.push("- Roll back? Switch to `LOKI_LEGACY_BASH=1` and re-run; the bash route does not consult this handoff doc."),z.push(""),z.push("To resume: fix the findings (or, after your own review, accept them), then `rm .loki/PAUSE`."),z.join(`
`)}function d7($,Q){T1($,Q)}function o7($,Q,Z={}){let z=Z.findings??E1($,Q.iteration).findings,X=Z.learnings??N1($).learnings,q=a6(Q,z,X),K=(Z.now?.()??new Date).toISOString().replace(/[-:.]/g,""),U=a$($,"escalations"),J=++l7,W=a$(U,`handoff-${K}-${process.pid}-${J}-${Q.gateName}.md`);return d7(W,q),{path:W,bytes:q.length}}function n7($){let Q=a$($,"escalations");if(!m7(Q))return null;let Z;try{Z=g7(Q).filter((q)=>q.endsWith(".md"))}catch{return null}if(Z.length===0)return null;Z.sort();let z=Z[Z.length-1];if(!z)return null;let X=a$(Q,z);try{return{path:X,body:f7(X,"utf-8")}}catch{return null}}var l7=0;var r6=L(()=>{I$();d$();o$()});var i6={};b(i6,{runInternalPhase1Hooks:()=>e7,_resolveForTests:()=>i7,_internalPhase1HooksHelp:()=>zZ,__testAppendHook:()=>t6});import{existsSync as a7,mkdirSync as s7,readdirSync as r7,statSync as t7}from"fs";import{join as k$,resolve as i7}from"path";async function e7($){let[Q,...Z]=$;switch(Q){case void 0:case"help":case"--help":case"-h":return process.stdout.write(S1),Q===void 0?1:0;case"reflect":return $Z(Z);case"override":return QZ(Z);case"handoff":return ZZ(Z);default:return process.stderr.write(`Unknown subcommand: ${Q}
`),process.stderr.write(S1),2}}async function $Z($){let Q=D1($[0]);if(Q===null)return process.stderr.write(`reflect: missing or invalid <iter>
`),2;let Z=P();try{let X=(await Promise.resolve().then(() => (d$(),x1))).loadPreviousFindings(Z,Q);if(X.findings.length===0)return process.stdout.write(`reflect: no findings for iter ${Q} (nothing to do)
`),0;let q=k$(Z,"state");s7(q,{recursive:!0}),A$(k$(q,`findings-${Q}.json`),{review_id:X.reviewId,iteration:Q,findings:X.findings});let K=await Promise.resolve().then(() => (o$(),l6)),U=0,J=0;if(process.env.LOKI_AUTO_LEARNINGS!=="0"){let H=X.findings.filter((G)=>G.severity==="Critical"||G.severity==="High"),B=t6.fn??K.appendFromGateFailure;for(let G of H)try{await B(Z,Q,G,{episodeBridge:null}),U+=1}catch(Y){J+=1,process.stderr.write(`reflect: learning append failed for finding ${G.reviewer}/${G.severity}: ${Y.message}
`)}if(J>0&&U===0)return process.stderr.write(`reflect: all ${J} learning appends failed (iter ${Q})
`),1}let W=J>0?` (${J} failed)`:"";return process.stdout.write(`reflect: persisted ${X.findings.length} findings + ${U} learnings${W} (iter ${Q})
`),0}catch(z){return process.stderr.write(`reflect: ${z.message}
`),1}}async function QZ($){let Q=D1($[0]);if(Q===null)return process.stderr.write(`override: missing or invalid <iter>
`),2;let Z=P();try{let z=await Promise.resolve().then(() => (n6(),o6)),X=z.loadCounterEvidence(Z,Q);if(X===null||X.evidence.length===0)return process.stdout.write(`override: no counter-evidence for iter ${Q} (skip)
`),0;let K=(await Promise.resolve().then(() => (d$(),x1))).loadPreviousFindings(Z,Q),U=K.findings.filter((T)=>T.severity==="Critical"||T.severity==="High");if(U.length===0)return process.stdout.write(`override: no blocking findings for iter ${Q} (skip)
`),0;let J=async(T)=>{return{judge:T.judge,verdict:"REJECT_OVERRIDE",reasoning:`[stub] proofType=${T.evidence.proofType}: self-supplied counter-evidence cannot lift a trust-gate BLOCK on the agent-authored route. Fix the finding, or use the human-escape path (rm .loki/PAUSE; optionally .loki/HUMAN_INPUT.md). The only adjudicated override is the Bun-route real-LLM judge.`}},W=await z.runOverrideCouncil(U,X,J);await z.recordOverrideOutcome(Z,Q,W,U);let H=k$(Z,"quality","reviews");if(a7(H))try{let T=r7(H).filter((R)=>R.startsWith("review-")).sort(),M=T[T.length-1];if(M&&t7(k$(H,M)).isDirectory())A$(k$(H,M,`override-${Q}.json`),{review_id:K.reviewId,iteration:Q,approved_finding_ids:Array.from(W.approvedFindingIds),rejected_finding_ids:Array.from(W.rejectedFindingIds),votes:W.votes})}catch{}let B=W.approvedFindingIds.size,G=W.rejectedFindingIds.size;if(G===0&&B>0)process.stdout.write(`override: LIFTED -- ${B} approved, ${G} rejected
`);else process.stdout.write(`override: BLOCKED -- ${B} approved, ${G} rejected
`);return 0}catch(z){return process.stderr.write(`override: ${z.message}
`),1}}async function ZZ($){let Q=$[0],Z=Number.parseInt($[1]??"0",10),z=D1($[2]);if(!Q||!Number.isFinite(Z)||z===null)return process.stderr.write(`handoff: usage: handoff <gate> <consecutive-failures> <iter>
`),2;let X=P();try{let K=(await Promise.resolve().then(() => (r6(),s6))).writeEscalationHandoff(X,{gateName:Q,iteration:z,consecutiveFailures:Z,detail:`${Q} hit PAUSE_LIMIT (${Z} consecutive failures)`});return process.stdout.write(`handoff: wrote ${K.path} (${K.bytes}B)
`),0}catch(q){return process.stderr.write(`handoff: ${q.message}
`),1}}function D1($){if($===void 0)return null;let Q=Number.parseInt($,10);return Number.isFinite(Q)&&Q>=0?Q:null}var t6,S1=`loki internal phase1-hooks <subcommand>

Subcommands:
  reflect <iter>                    Persist structured findings + auto-learnings.
  override <iter>                   Run override council if counter-evidence present.
  handoff <gate> <count> <iter>     Write structured handoff doc before PAUSE.

This command is invoked by autonomy/run.sh between iterations. Users
should not run it directly -- run \`loki start\` instead.
`,zZ;var e6=L(()=>{C();I$();t6={fn:null};zZ=S1});e$();function y1(){return process.stdout.write(`Loki Mode v${E$()}
`),0}d();c();C();import{readFileSync as MQ,existsSync as TQ}from"fs";import{resolve as OQ}from"path";var wQ=["claude","codex","cline","aider"];function f1(){let $=OQ(P(),"state","provider");if(!TQ($))return"";try{return MQ($,"utf-8").trim()}catch{return""}}function AQ($,Q){return $||Q||process.env.LOKI_PROVIDER||"claude"}function _Q($){let Q=f1(),Z=AQ($,Q);switch(process.stdout.write(`${k}Current Provider${V}
`),process.stdout.write(`
`),process.stdout.write(`${I}Provider:${V} ${Z}
`),Z){case"claude":process.stdout.write(`${S}Status:${V}   Full features (subagents, parallel, MCP)
`);break;case"cline":process.stdout.write(`${S}Status:${V}   Near-full mode (subagents, MCP, 12+ providers)
`);break;case"codex":case"aider":process.stdout.write(`${_}Status:${V}   Degraded mode (sequential only)
`);break;default:break}if(Q)process.stdout.write(`${h}(saved in .loki/state/provider)${V}
`);else process.stdout.write(`${h}(default - not explicitly set)${V}
`);return process.stdout.write(`
`),process.stdout.write(`Switch provider: ${I}loki provider set <name>${V}
`),process.stdout.write(`Available:       ${I}loki provider list${V}
`),0}async function IQ(){let Q=f1()||process.env.LOKI_PROVIDER||"claude";process.stdout.write(`${k}Available Providers${V}
`),process.stdout.write(`
`);let Z=await Promise.all(wQ.map(async(q)=>[q,await f(q)!==null])),z=new Map;for(let[q,K]of Z)z.set(q,K?`${S}installed${V}`:`${O}not installed${V}`);let X=[["claude","claude  - Claude Code (Anthropic)    "],["codex","codex   - Codex CLI (OpenAI)         "],["cline","cline   - Cline (multi-provider)     "],["aider","aider   - Aider (terminal pair prog) "]];for(let[q,K]of X){let U=Q===q?` ${I}(current)${V}`:"";process.stdout.write(`  ${K} ${z.get(q)}${U}
`)}return process.stdout.write(`
`),process.stdout.write(`Set provider: ${I}loki provider set <name>${V}
`),0}function LQ(){return process.stdout.write(`${k}Loki Mode Provider Management${V}
`),process.stdout.write(`
`),process.stdout.write(`Usage: loki provider <command>
`),process.stdout.write(`
`),process.stdout.write(`Commands:
`),process.stdout.write(`  show     Show current provider (default)
`),process.stdout.write(`  set      Set provider for this project
`),process.stdout.write(`  list     List available providers
`),process.stdout.write(`  info     Show provider details
`),process.stdout.write(`  models   Show resolved model configuration for all providers
`),process.stdout.write(`
`),process.stdout.write(`Examples:
`),process.stdout.write(`  loki provider show
`),process.stdout.write(`  loki provider set claude
`),process.stdout.write(`  loki provider set codex
`),process.stdout.write(`  loki provider list
`),process.stdout.write(`  loki provider info codex
`),process.stdout.write(`  loki provider models
`),0}async function u1($){let Q=$[0]??"show",Z=$.slice(1);switch(Q){case"show":case"current":return _Q(Z[0]);case"list":return IQ();case"set":case"info":case"models":return PQ(["provider",Q,...Z]);default:return LQ()}}async function PQ($){let{run:Q}=await Promise.resolve().then(() => (d(),g1)),{resolve:Z}=await import("path"),{REPO_ROOT:z}=await Promise.resolve().then(() => (C(),h1)),X=Z(z,"autonomy","loki"),q=await Q([X,...$],{env:{LOKI_LEGACY_BASH:"1"},timeoutMs:3600000});return process.stdout.write(q.stdout),process.stderr.write(q.stderr),q.exitCode}c();C();V$();import{existsSync as c1,readFileSync as FQ}from"fs";import{resolve as J$}from"path";import{mkdir as kQ}from"fs/promises";var M$=J$(i$(),"learnings");function Q1($){if(!c1($))return 0;try{let Q=FQ($,"utf-8"),Z=0;for(let z of Q.split(`
`))if(z.includes('"description"'))Z++;return Z}catch{return 0}}async function RQ(){await kQ(M$,{recursive:!0});let $=Q1(J$(M$,"patterns.jsonl")),Q=Q1(J$(M$,"mistakes.jsonl")),Z=Q1(J$(M$,"successes.jsonl"));return process.stdout.write(`${k}Cross-Project Learnings${V}
`),process.stdout.write(`
`),process.stdout.write(`  Patterns:  ${S}${$}${V}
`),process.stdout.write(`  Mistakes:  ${_}${Q}${V}
`),process.stdout.write(`  Successes: ${I}${Z}${V}
`),process.stdout.write(`
`),process.stdout.write(`Location: ${M$}
`),process.stdout.write(`
`),process.stdout.write(`Use 'loki memory show <type>' to view entries
`),0}async function EQ($){if($){let z=`
try:
    from memory.layers import IndexLayer
    layer = IndexLayer('.loki/memory')
    layer.update([])
    print('Index rebuilt')
except ImportError:
    print('Error: memory.layers module not found')
except Exception as e:
    print(f'Error: {e}')
`.trim(),X=await z$(z,{cwd:g});return process.stdout.write(X.stdout),0}let Q=J$(P(),"memory","index.json");if(!c1(Q))return process.stdout.write(`No index found
`),0;let Z=await z$(`import json, sys; sys.stdout.write(json.dumps(json.load(open(${JSON.stringify(Q)})), indent=4) + "\\n")`);if(Z.exitCode!==0)return process.stdout.write(`No index found
`),0;return process.stdout.write(Z.stdout),0}async function p1($){switch($[0]??"list"){case"list":case"ls":return RQ();case"index":return EQ($[1]==="rebuild");default:{let Z=J$(g,"autonomy","loki"),z=3600000,X=Bun.spawn({cmd:[Z,"memory",...$],stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,LOKI_LEGACY_BASH:"1"}}),q=setTimeout(()=>{try{X.kill("SIGKILL")}catch{}},3600000);try{return await X.exited}finally{clearTimeout(q)}}}}C();V$();d();import{resolve as xQ,join as NQ}from"path";import{existsSync as Z1,readFileSync as SQ}from"fs";import{homedir as DQ}from"os";import{spawnSync as n1}from"child_process";var a1=3000;function CQ(){let $=(process.env.LOKI_TELEMETRY??"").toLowerCase();if($==="off")return!1;if(process.env.LOKI_TELEMETRY_DISABLED==="true")return!1;if(process.env.DO_NOT_TRACK==="1")return!1;let Q=!1,Z=!1;try{let z=NQ(DQ(),".loki","config");if(Z1(z)){let X=SQ(z,"utf8");for(let q of X.split(`
`)){let K=q.replace(/\r$/,"");if(K==="TELEMETRY_DISABLED=true")Q=!0;if(K==="TELEMETRY_ENABLED=true")Z=!0}}}catch{}if(Q)return!1;if($==="on"||Z)return!0;return!1}var x$=!1;function bQ(){return xQ(g,"autonomy","lib","crash_capture.py")}function hQ($,Q){let Z=[$,"--error-class",Q.errorClass,"--message",Q.message];if(Q.stack!==void 0)Z.push("--stack",Q.stack);if(Q.rarvPhase!==void 0)Z.push("--rarv-phase",Q.rarvPhase);if(Q.exitCode!==void 0)Z.push("--exit-code",String(Q.exitCode));if(Q.frictionKind!==void 0)Z.push("--friction-kind",Q.frictionKind);return Z.push("--target-dir",Q.targetDir??process.cwd()),Z}function yQ(){if(Z1("/opt/homebrew/bin/python3.12"))return"/opt/homebrew/bin/python3.12";for(let Q of["python3.12","python3"])try{let Z=n1("sh",["-c",`command -v ${Q}`],{timeout:a1,encoding:"utf8"});if(Z.status===0){let z=(Z.stdout||"").trim();if(z)return z}}catch{}return null}function l1($){try{if(!CQ())return;let Q=bQ();if(!Z1(Q))return;let Z=yQ();if(!Z)return;let z=hQ(Q,$);n1(Z,z,{timeout:a1,stdio:"ignore"})}catch{}}function d1($,Q){if($ instanceof Error){let z={errorClass:$.name&&$.name.length>0?$.name:Q,message:$.message};if($.stack)z.stack=$.stack;return z}return{errorClass:Q,message:String($)}}var o1=!1;function s1(){if(o1)return;o1=!0,process.on("uncaughtException",($)=>{if(!x$){x$=!0;let Q=d1($,"UncaughtException");l1({errorClass:Q.errorClass,message:Q.message,...Q.stack!==void 0?{stack:Q.stack}:{},exitCode:1})}try{process.stderr.write(`${$&&$.stack||String($)}
`)}catch{}process.exit(1)}),process.on("unhandledRejection",($)=>{if(!x$){x$=!0;let Q=d1($,"UnhandledRejection");l1({errorClass:Q.errorClass,message:Q.message,...Q.stack!==void 0?{stack:Q.stack}:{},exitCode:1})}try{let Q=$ instanceof Error?$.stack||$.message:String($);process.stderr.write(`Unhandled promise rejection: ${Q}
`)}catch{}process.exit(1)})}var $Q=`Loki Mode (TypeScript port, Phase 2 of bash->Bun migration)

Usage: loki <command> [args...]

Phase 2 ported (Bun-native, fast):
  version                Print Loki Mode version
  status [--json]        Show current orchestrator status
  stats [--json] [--efficiency]   Session statistics
  provider show [name]   Show current provider
  provider list          List available providers and install status
  memory list            Cross-project learnings counts
  memory index [rebuild] Show or rebuild memory index
  doctor [--json]        System prerequisites health check
  rollback <subcmd>      Restore .loki/ state from a checkpoint
                         (subcmds: list | show <id> | to <id> | latest)
  proof <subcmd>         Inspect/share proof-of-run artifacts
                         (subcmds: list | show <id> | open <id> | share <id>)
  wiki <subcmd>          Auto-generated, cited codebase wiki + Q&A
                         (subcmds: generate | show [section] | ask "<question>")

All other commands fall through to the bash CLI (autonomy/loki).
Set LOKI_LEGACY_BASH=1 to force the bash CLI for every command.
`;function XZ(){let $=process.env.LOKI_LEGACY_BASH;if($===void 0)return;let Q=$.trim().toLowerCase();if(Q!=="1"&&Q!=="true"&&Q!=="yes"&&Q!=="on")return;if(process.env.LOKI_SUPPRESS_BUN_DIRECT_WARN==="1")return;process.stderr.write(`warning: LOKI_LEGACY_BASH is set, but you are running the Bun runtime directly (src/cli.ts). The env var only takes effect via the bin/loki shim, which dispatches between Bun and bash. Behavior is unchanged; this message is informational.
`)}async function KZ($){XZ();let Q=$[0],Z=$.slice(1);switch(Q){case void 0:case"help":case"--help":case"-h":return process.stdout.write($Q),0;case"version":case"--version":case"-v":return y1();case"provider":return u1(Z);case"memory":return p1(Z);case"status":{let{runStatus:z}=await Promise.resolve().then(() => (K0(),X0));return z(Z)}case"stats":{let{runStats:z}=await Promise.resolve().then(() => (G0(),H0));return z(Z)}case"doctor":{let{runDoctor:z}=await Promise.resolve().then(() => (L0(),I0));return z(Z)}case"kpis":{let{runKpis:z}=await Promise.resolve().then(() => (B1(),G1));return z(Z,{aliasOf:"kpis"})}case"report":{if(Z.find((q)=>!q.startsWith("-"))==="kpis"){let{runKpis:q}=await Promise.resolve().then(() => (B1(),G1)),K=!1,U=Z.filter((J)=>{if(!K&&J==="kpis")return K=!0,!1;return!0});return q(U)}let{delegateToBash:X}=await Promise.resolve().then(() => (h0(),b0));return X(["report",...Z])}case"trust":{let{runTrust:z}=await Promise.resolve().then(() => (l0(),p0));return z(Z)}case"rollback":{let{runRollback:z}=await Promise.resolve().then(() => (T6(),M6));return z(Z)}case"proof":{let{runProof:z}=await Promise.resolve().then(() => (I6(),_6));return z(Z)}case"crash":{let{runCrash:z}=await Promise.resolve().then(() => (E6(),R6));return z(Z)}case"wiki":{let{runWiki:z}=await Promise.resolve().then(() => (C6(),D6));return z(Z)}case"internal":{let z=Z[0];if(!z||z==="--help"||z==="-h"||z==="help"){let q=["loki internal -- runtime hooks driven by autonomy/run.sh","","Subcommands:","  phase1-hooks    Persist structured findings, run override council,","                  append learnings, and write the escalation handoff","                  doc once per iteration. Driven by run.sh; not","                  intended for direct invocation.","","Phase 1 (RARV-C closure) env vars:","  LOKI_INJECT_FINDINGS=1   Persist structured reviewer findings to","                           .loki/state/findings-<iter>.json so the","                           next iteration can address them.","  LOKI_OVERRIDE_COUNCIL=1  Allow a 3-LLM override panel to lift a","                           BLOCK when counter-evidence is presented.","                           See LOKI_OVERRIDE_JUDGES (csv),","                           LOKI_OVERRIDE_PANEL_SIZE,","                           LOKI_OVERRIDE_REAL_JUDGE.","  LOKI_AUTO_LEARNINGS=1    Append failure rootcauses to","                           .loki/state/relevant-learnings.json via","                           the episodic memory bridge.","  LOKI_HANDOFF_MD=1        Write a structured human handoff doc to","                           .loki/escalations/<ts>.md before PAUSE.","","All four are default-on as of v7.5.3. Set to 0 to disable.","Reference: CHANGELOG.md (search 'Phase 1') and skills/healing.md.","","These commands are wired into the autonomous loop and may change","without notice. Do not script against them.",""].join(`
`);return process.stdout.write(`${q}
`),0}if(z==="phase1-hooks"){let{runInternalPhase1Hooks:q}=await Promise.resolve().then(() => (e6(),i6));return q(Z.slice(1))}return process.stderr.write(`Unknown internal subcommand: ${z}
`),process.stderr.write(`Run 'loki internal --help' for the supported list.
`),2}default:return process.stderr.write(`Unknown command: ${Q}
`),process.stderr.write($Q),2}}s1();process.on("SIGINT",()=>process.exit(130));process.on("SIGTERM",()=>process.exit(143));var qZ=await KZ(Bun.argv.slice(2));process.exit(qZ);

//# debugId=8AD63677BE89399E64756E2164756E21
