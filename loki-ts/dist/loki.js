// @bun
var t6=Object.defineProperty;var i6=($)=>$;function e6($,Q){this[$]=i6.bind(null,Q)}var h=($,Q)=>{for(var Z in Q)t6($,Z,{get:Q[Z],enumerable:!0,configurable:!0,set:e6.bind(Q,Z)})};var P=($,Q)=>()=>($&&(Q=$($=0)),Q);var q$=import.meta.require;var D1={};h(D1,{lokiDir:()=>j,homeLokiDir:()=>r$,findRepoRootForVersion:()=>s$,REPO_ROOT:()=>g});import{resolve as a,dirname as a$}from"path";import{fileURLToPath as $Q}from"url";import{existsSync as F$}from"fs";import{homedir as QQ}from"os";function ZQ(){let $=S1;for(let Q=0;Q<6;Q++){if(F$(a($,"VERSION"))&&F$(a($,"autonomy/run.sh")))return $;let Z=a$($);if(Z===$)break;$=Z}return a(S1,"..","..","..")}function s$($){let Q=$;for(let Z=0;Z<6;Z++){if(F$(a(Q,"VERSION"))&&F$(a(Q,"autonomy/run.sh")))return Q;let z=a$(Q);if(z===Q)break;Q=z}return a($,"..","..","..")}function j(){return process.env.LOKI_DIR??a(process.cwd(),".loki")}function r$(){return a(QQ(),".loki")}var S1,g;var b=P(()=>{S1=a$($Q(import.meta.url));g=ZQ()});import{readFileSync as zQ}from"fs";import{resolve as XQ,dirname as KQ}from"path";import{fileURLToPath as qQ}from"url";function R$(){if(Q$!==null)return Q$;let $="7.71.0";if(typeof $==="string"&&$.length>0)return Q$=$,Q$;try{let Q=KQ(qQ(import.meta.url)),Z=s$(Q);Q$=zQ(XQ(Z,"VERSION"),"utf-8").trim()}catch{Q$="unknown"}return Q$}var Q$=null;var t$=P(()=>{b()});var b1={};h(b1,{runOrThrow:()=>VQ,run:()=>k,commandVersion:()=>WQ,commandExists:()=>f,ShellError:()=>i$});async function k($,Q={}){let Z=Bun.spawn({cmd:[...$],stdout:"pipe",stderr:"pipe",env:Q.env?{...process.env,...Q.env}:process.env,cwd:Q.cwd}),z,X;if(Q.timeoutMs&&Q.timeoutMs>0)z=setTimeout(()=>{try{Z.kill("SIGTERM")}catch{}X=setTimeout(()=>{try{Z.kill("SIGKILL")}catch{}},2000)},Q.timeoutMs);try{let[q,K,W]=await Promise.all([new Response(Z.stdout).text(),new Response(Z.stderr).text(),Z.exited]);return{stdout:q,stderr:K,exitCode:W}}finally{if(z)clearTimeout(z);if(X)clearTimeout(X)}}async function VQ($,Q={}){let Z=await k($,Q);if(Z.exitCode!==0)throw new i$(`command failed (${Z.exitCode}): ${$.join(" ")}`,Z.exitCode,Z.stdout,Z.stderr);return Z}async function f($){let Q=JQ($),Z=await k(["sh","-c",`command -v ${Q}`],{timeoutMs:5000});if(Z.exitCode===0)return Z.stdout.trim()||null;return null}function JQ($){if(!/^[A-Za-z0-9._/-]+$/.test($))throw Error(`refused to shell-escape suspect token: ${$}`);return $}async function WQ($,Q="--version"){if(!await f($))return null;let z=await k([$,Q],{timeoutMs:5000});if(z.exitCode!==0)return null;return((z.stdout||z.stderr).split(/\r?\n/)[0]?.trim()??"")||null}var i$;var d=P(()=>{i$=class i$ extends Error{message;exitCode;stdout;stderr;constructor($,Q,Z,z){super($);this.message=$;this.exitCode=Q;this.stdout=Z;this.stderr=z;this.name="ShellError"}}});function s($){return UQ?"":$}var UQ,T,S,_,_Z,I,x,y,V;var c=P(()=>{UQ=(process.env.NO_COLOR??"").length>0;T=s("\x1B[0;31m"),S=s("\x1B[0;32m"),_=s("\x1B[1;33m"),_Z=s("\x1B[0;34m"),I=s("\x1B[0;36m"),x=s("\x1B[1m"),y=s("\x1B[2m"),V=s("\x1B[0m")});import{existsSync as _Q}from"fs";async function Z$(){if(Y$!==void 0)return Y$;let $="/opt/homebrew/bin/python3.12";if(_Q($))return Y$=$,$;let Q=await f("python3.12");if(Q)return Y$=Q,Q;let Z=await f("python3");return Y$=Z,Z}async function z$($,Q={}){let Z=await Z$();if(!Z)return{stdout:"",stderr:"python3 not found",exitCode:127};return k([Z,"-c",$],Q)}var Y$;var V$=P(()=>{d()});var e1={};h(e1,{runStatus:()=>cQ});import{existsSync as v,readFileSync as W$,readdirSync as d1,statSync as o1}from"fs";import{resolve as D,basename as CQ}from"path";import{homedir as bQ}from"os";function n1($){let Q=Math.trunc($);if(Q>=1e6)return`${(Math.trunc(Q/1e6*10)/10).toFixed(1)}M`;if(Q>=1000)return`${(Math.trunc(Q/1000*10)/10).toFixed(1)}K`;return String(Q)}function a1($,Q,Z){if(Q===0)return null;let z=Math.trunc($*100/Q),X=Math.trunc($*x$/Q);if(X>x$)X=x$;let q=x$-X,K=S;if(z>=80)K=T;else if(z>=50)K=_;let W="=".repeat(Math.max(0,X))+" ".repeat(Math.max(0,q)),J=n1($),U=n1(Q);return`  ${x}${Z}${V} ${K}[${W}]${V} ${z}% (${J} / ${U})`}async function yQ(){if(await f("jq"))return!0;return process.stdout.write(`${T}Error: jq is required but not installed.${V}
`),process.stdout.write(`Install with:
`),process.stdout.write(`  brew install jq    (macOS)
`),process.stdout.write(`  apt install jq     (Debian/Ubuntu)
`),process.stdout.write(`  yum install jq     (RHEL/CentOS)
`),!1}function E$($){if(!Number.isFinite($)||$<=0)return!1;try{return process.kill($,0),!0}catch{return!1}}function N$($){if(!v($))return null;try{let Q=W$($,"utf-8").trim();if(!Q)return null;let Z=Number.parseInt(Q,10);return Number.isFinite(Z)?Z:null}catch{return null}}function vQ($){let Q=[],Z=N$(D($,"loki.pid"));if(Z!==null&&E$(Z))Q.push(`global:${Z}`);let z=D($,"sessions");if(v(z)){let X=[];try{X=d1(z)}catch{X=[]}for(let q of X){let K=D(z,q);try{if(!o1(K).isDirectory())continue}catch{continue}let W=D(K,"loki.pid"),J=N$(W);if(J!==null&&E$(J))Q.push(`${q}:${J}`)}}if(v($)){let X=[];try{X=d1($)}catch{X=[]}for(let q of X){if(!q.startsWith("run-")||!q.endsWith(".pid"))continue;let K=D($,q);try{if(!o1(K).isFile())continue}catch{continue}let W=CQ(q,".pid").slice(4),J=N$(K);if(J!==null&&E$(J)){if(!Q.some((H)=>H.startsWith(`${W}:`)))Q.push(`${W}:${J}`)}}}return Q}async function s1($,Q){let Z=await k(["jq","-r",$,Q]);if(Z.exitCode!==0)return null;return Z.stdout.trim()}function r1($,Q){try{let Z=W$($,"utf-8"),X=JSON.parse(Z)[Q];if(typeof X==="number"){if(Q==="budget_used"){let q=Math.round(X*100)/100;if(Number.isInteger(q))return String(q);return String(q)}return String(X)}if(X===void 0||X===null)return"0";return String(X)}catch{return"0"}}function t1($,Q,Z){try{let z=W$($,"utf-8"),q=JSON.parse(z)[Q];if(typeof q==="number"&&Number.isFinite(q))return q;return Z}catch{return Z}}async function mQ(){let $=j();if(!await yQ())return 1;if(!v($))return process.stdout.write(`${x}Loki Mode Status${V}
`),process.stdout.write(`
`),process.stdout.write(`${_}No active session found.${V}
`),process.stdout.write(`Loki Mode has not been initialized in this directory.
`),process.stdout.write(`
`),process.stdout.write(`To start a session:
`),process.stdout.write(`  loki start <prd>              - Start with a PRD file
`),process.stdout.write(`  loki start                    - Start without a PRD
`),process.stdout.write(`
`),process.stdout.write(`${y}Current directory: ${process.cwd()}${V}
`),0;process.stdout.write(`${x}Loki Mode Status${V}
`),process.stdout.write(`
`);let Q="",Z=D($,"state","provider");if(v(Z))try{Q=W$(Z,"utf-8").trim()}catch{Q=""}let z=Q||process.env.LOKI_PROVIDER||"claude",X="full features";switch(z){case"codex":case"aider":X="degraded mode";break;case"cline":X="near-full mode";break;default:X="full features";break}process.stdout.write(`${I}Provider:${V} ${z} (${X})
`),process.stdout.write(`${y}  Switch with: loki provider set <claude|codex|cline|aider>${V}
`),process.stdout.write(`
`);let q=vQ($);if(q.length>0){process.stdout.write(`${S}Active Sessions: ${q.length}${V}
`);for(let B of q){let O=B.indexOf(":"),M=O>=0?B.slice(0,O):B,L=O>=0?B.slice(O+1):"";if(M==="global")process.stdout.write(`  ${I}[global]${V} PID ${L}
`);else process.stdout.write(`  ${I}[#${M}]${V} PID ${L}
`)}process.stdout.write(`
`),process.stdout.write(`${y}  Stop specific: loki stop <session-id>${V}
`),process.stdout.write(`${y}  Stop all:      loki stop${V}
`),process.stdout.write(`
`)}if(v(D($,"PAUSE")))process.stdout.write(`${_}Status: PAUSED${V}
`),process.stdout.write(`${y}  Resume with: loki resume${V}
`),process.stdout.write(`
`);else if(v(D($,"STOP")))process.stdout.write(`${T}Status: STOPPED${V}
`),process.stdout.write(`${y}  Clear with: loki resume${V}
`),process.stdout.write(`
`);let K=D($,"STATUS.txt");if(v(K)){process.stdout.write(`${I}Session Info:${V}
`);try{process.stdout.write(W$(K,"utf-8"))}catch{}process.stdout.write(`
`)}let W=D($,"state","orchestrator.json");if(v(W)){process.stdout.write(`${I}Orchestrator State:${V}
`);let B=await s1('.currentPhase // "unknown"',W);process.stdout.write(`${B??"unknown"}
`)}let J=D($,"queue","pending.json");if(v(J)){let B=await s1('if type == "array" then length elif .tasks then .tasks | length else 0 end',J);process.stdout.write(`${I}Pending Tasks:${V} ${B??"0"}
`)}let U=D($,"metrics","budget.json");if(v(U)){let B=r1(U,"budget_limit"),O=r1(U,"budget_used");if(B!=="0"){process.stdout.write(`${I}Budget:${V} $${O} / $${B}
`);let M=Math.trunc((Number.parseFloat(O)||0)*100),L=Number.parseFloat(B),F=Number.isFinite(L)&&L!==0?Math.trunc(L*100):100,C=a1(M,F,"Budget");if(C!==null)process.stdout.write(`${C}
`)}else process.stdout.write(`${I}Cost:${V} $${O} (no limit)
`)}let H=D($,"state","context-usage.json");if(v(H)){let B=t1(H,"window_size",200000),O=t1(H,"used_tokens",0),M=a1(O,B,"Context");if(M!==null)process.stdout.write(`${M}
`)}let G=[D($,"dashboard","dashboard.pid"),D(bQ(),".loki","dashboard","dashboard.pid")].find((B)=>v(B))??"";if(G&&v(G)){let B=N$(G);if(B!==null&&E$(B)){let O=D(G,".."),M=(u,A)=>{let E=D(O,u);try{return v(E)?W$(E,"utf-8").trim()||A:A}catch{return A}},L=M("scheme","http"),F=M("host","127.0.0.1"),C=M("port",process.env.LOKI_DASHBOARD_PORT||"57374");if(F==="0.0.0.0")F="127.0.0.1";process.stdout.write(`${I}Dashboard:${V} ${L}://${F}:${C}/
`)}}return await gQ($),process.stdout.write(`
`),process.stdout.write(`${y}  Tip: loki analyze context show   - detailed token breakdown${V}
`),process.stdout.write(`${y}  Tip: loki analyze code overview  - codebase intelligence${V}
`),0}async function gQ($){let Q=D($,"state"),Z=fQ(Q),z=D(Q,"relevant-learnings.json"),X=D($,"escalations"),q=Z.length>0,K=v(z),W=v(X);if(!q&&!K&&!W)return;if(process.stdout.write(`
${I}Phase 1 artifacts:${V}
`),q){let J=Z[Z.length-1],U=i1(J);if(U&&Array.isArray(U.findings)){let H={Critical:0,High:0,Medium:0,Low:0};for(let G of U.findings){let B=String(G.severity??"");if(B in H)H[B]=(H[B]??0)+1}let Y=Object.entries(H).filter(([,G])=>G>0).map(([G,B])=>`${B} ${G.toLowerCase()}`).join(", ");process.stdout.write(`  Findings (iter ${U.iteration??"?"}): ${Y||"none"} -- ${U.findings.length} total
`)}}if(K){let J=i1(z);if(J&&Array.isArray(J.learnings)&&J.learnings.length>0){let U=new Map;for(let Y of J.learnings){let G=String(Y.trigger??"unknown");U.set(G,(U.get(G)??0)+1)}let H=[...U.entries()].sort((Y,G)=>G[1]-Y[1]).slice(0,3).map(([Y,G])=>`${G} ${Y}`).join(", ");process.stdout.write(`  Learnings: ${J.learnings.length} total (${H})
`)}}if(W){let J=0,U="";try{let Y=(await import("fs")).readdirSync(X).filter((G)=>G.endsWith(".md"));if(J=Y.length,Y.length>0)Y.sort(),U=Y[Y.length-1]??""}catch{}if(J>0)process.stdout.write(`  Escalations: ${J} handoff doc${J===1?"":"s"} (latest: ${U})
`)}}function fQ($){if(!v($))return[];try{return q$("fs").readdirSync($).filter((z)=>/^findings-\d+\.json$/.test(z)).sort((z,X)=>{let q=Number.parseInt(z.replace(/[^0-9]/g,""),10)||0,K=Number.parseInt(X.replace(/[^0-9]/g,""),10)||0;return q-K}).map((z)=>D($,z))}catch{return[]}}function i1($){try{let Q=q$("fs");return JSON.parse(Q.readFileSync($,"utf-8"))}catch{return null}}async function uQ(){let $=await Z$();if(!$)return process.stderr.write(`{"error": "Failed to generate JSON status. Ensure python3 is available."}
`),1;let Q=g,Z=j(),z=process.env.LOKI_DASHBOARD_PORT||"57374",X=process.env.LOKI_PROVIDER||"claude",q=await k([$,"-c",hQ,Q,Z,z,X],{timeoutMs:30000});if(q.exitCode!==0)return process.stderr.write(`{"error": "Failed to generate JSON status. Ensure python3 is available."}
`),1;return process.stdout.write(q.stdout),0}async function cQ($){let Q=[...$];while(Q.length>0){let Z=Q[0];if(Z==="--json")return uQ();if(Z==="--help"||Z==="-h")return process.stdout.write(`Usage: loki status [--json]
`),0;return process.stdout.write(`${T}Unknown flag: ${Z}${V}
`),process.stdout.write(`Usage: loki status [--json]
`),1}return mQ()}var x$=30,hQ=`
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
`;var $0=P(()=>{d();V$();c();b()});var Z0={};h(Z0,{emitDeprecatedAlias:()=>Q1,deprecatedAliasShouldSuppress:()=>Q0});function Q0($){let Q=$[0];if(Q!==void 0&&lQ.has(Q))return!0;for(let Z of $)if(pQ.has(Z))return!0;return!1}function Q1($,Q,Z){if(Q0(Z))return;process.stderr.write(`note: 'loki ${$}' is now 'loki ${Q}'. The old form still works.
`)}var pQ,lQ;var Z1=P(()=>{pQ=new Set(["--json","-q","--quiet"]),lQ=new Set(["json","csv","timeline"])});var q0={};h(q0,{runStats:()=>rQ,computeStats:()=>K0});import{readdirSync as z0,readFileSync as dQ,statSync as X0}from"fs";import{join as r}from"path";function U$($){try{if(!X0($).isFile())return null;return JSON.parse(dQ($,"utf-8"))}catch{return null}}function K1($){try{return X0($).isDirectory()}catch{return!1}}function oQ($){if(!K1($))return[];try{let Q=z0($).filter((Z)=>Z.startsWith("iteration-")&&Z.endsWith(".json"));return Q.sort(),Q.map((Z)=>r($,Z))}catch{return[]}}function H$($){return Math.trunc($).toLocaleString("en-US")}function z1($){let Q=Math.trunc($);if(Q<60)return`${Q}s`;let Z=Math.trunc(Q/3600),z=Math.trunc(Q%3600/60),X=Q%60;if(Z>0)return`${Z}h ${String(z).padStart(2,"0")}m`;return`${z}m ${String(X).padStart(2,"0")}s`}function t($,Q=0){let Z=Math.pow(10,Q);return Math.round($*Z)/Z}function G$($,Q){return $.toFixed(Q)}function X1($,Q){return $.length>=Q?$:$+" ".repeat(Q-$.length)}function nQ($){let Q="N/A",Z=0,z=U$(r($,"state","orchestrator.json"));if(z&&typeof z==="object"){if(typeof z.currentPhase==="string")Q=z.currentPhase;if(typeof z.currentIteration==="number")Z=z.currentIteration}let X=r($,"metrics","efficiency"),q=oQ(X),K=[];for(let R of q){let N=U$(R);if(N&&typeof N==="object")K.push(N)}if(K.length>0)Z=Math.max(Z,K.length);let W=K.reduce((R,N)=>R+(N.input_tokens??0),0),J=K.reduce((R,N)=>R+(N.output_tokens??0),0),U=W+J,H=K.reduce((R,N)=>R+(N.cost_usd??0),0),Y=K.reduce((R,N)=>R+(N.duration_seconds??0),0),G=0,B=0,O=U$(r($,"metrics","budget.json"));if(O&&typeof O==="object"){if(typeof O.budget_limit==="number")G=O.budget_limit;if(typeof O.budget_used==="number")B=O.budget_used}let M=0,L=0,F=U$(r($,"state","quality-gates.json"));if(F&&typeof F==="object"){if(Array.isArray(F)){for(let R of F)if(L+=1,R===!0)M+=1;else if(R&&typeof R==="object"){let N=R;if(N.passed===!0||N.status==="passed")M+=1}}else for(let R of Object.values(F))if(typeof R==="boolean"){if(L+=1,R)M+=1}else if(R&&typeof R==="object"){L+=1;let N=R;if(N.passed===!0||N.status==="passed")M+=1}}let C={},u=U$(r($,"quality","gate-failure-count.json"));if(u&&typeof u==="object"&&!Array.isArray(u)){let R={};for(let[N,l]of Object.entries(u))if(typeof l==="number")R[N]=l;C=R}let A=0,E=0,n=0,n$=r($,"quality");if(K1(n$)){let R=[];try{R=z0(n$)}catch{R=[]}for(let N of R){if(!N.endsWith(".json")||N==="gate-failure-count.json")continue;let l=U$(r(n$,N));if(!l||typeof l!=="object")continue;if(!(("verdict"in l)||("approved"in l)||("reviewers"in l)))continue;A+=1;let N1=(l.verdict??"").toString().toLowerCase();if(l.approved===!0||["approved","approve","pass"].includes(N1))E+=1;else if(["revision","revise","changes_requested","reject"].includes(N1))n+=1}}return{phase:Q,iterationCount:Z,iterations:K,totalInput:W,totalOutput:J,totalTokens:U,totalCost:H,totalDuration:Y,budgetLimit:G,budgetUsed:B,gatesPassed:M,gatesTotal:L,gateFailures:C,reviewsTotal:A,reviewsApproved:E,reviewsRevision:n}}function aQ($,Q){let Z=$.iterationCount,z={session:{iterations:Z,duration_seconds:$.totalDuration,phase:$.phase},tokens:{input:$.totalInput,output:$.totalOutput,total:$.totalTokens,cost_usd:t($.totalCost,2)},quality:{gates_passed:$.gatesPassed,gates_total:$.gatesTotal,reviews_total:$.reviewsTotal,reviews_approved:$.reviewsApproved,reviews_revision:$.reviewsRevision,gate_failures:$.gateFailures},efficiency:{avg_tokens_per_iteration:Z>0?t($.totalTokens/Z,0):0,avg_cost_per_iteration:Z>0?t($.totalCost/Z,2):0,avg_duration_per_iteration:Z>0?t($.totalDuration/Z,1):0},budget:{used:t($.budgetUsed,2),limit:$.budgetLimit,percent:$.budgetLimit>0?t($.budgetUsed/$.budgetLimit*100,1):0}};if(Q)z.iterations=$.iterations.map((K,W)=>({number:W+1,input_tokens:K.input_tokens??0,output_tokens:K.output_tokens??0,cost_usd:t(K.cost_usd??0,2),duration_seconds:K.duration_seconds??0}));let X=JSON.stringify(z,null,2);function q(K,W){if(!W)return;let J=new RegExp(`("${K}": )(-?\\d+)(,?)$`,"m");X=X.replace(J,(U,H,Y,G)=>`${H}${Y}.0${G}`)}if(q("avg_duration_per_iteration",Z>0&&Number.isInteger(z.efficiency.avg_duration_per_iteration)),q("percent",$.budgetLimit>0&&Number.isInteger(z.budget.percent)),q("cost_usd",Z>0&&Number.isInteger(z.tokens.cost_usd)),Q)X=X.replace(/("cost_usd": )(-?\d+)(,?)$/gm,(K,W,J,U)=>`${W}${J}.0${U}`);return X}function sQ($,Q){let Z=[];if(Z.push("Loki Mode Session Statistics"),Z.push("============================"),Z.push(""),Z.push("Session"),Z.push(`  Iterations completed: ${$.iterationCount}`),Z.push(`  Duration: ${z1($.totalDuration)}`),Z.push(`  Current phase: ${$.phase}`),Z.push(""),Z.push("Token Usage"),$.iterations.length>0)Z.push(`  Input tokens:  ${H$($.totalInput)}`),Z.push(`  Output tokens: ${H$($.totalOutput)}`),Z.push(`  Total tokens:  ${H$($.totalTokens)}`),Z.push(`  Estimated cost: $${G$($.totalCost,2)}`);else Z.push("  N/A (no iteration metrics found)");if(Z.push(""),Z.push("Quality Gates"),$.gatesTotal>0){let z=Math.round($.gatesPassed/$.gatesTotal*100);Z.push(`  Gates passed: ${$.gatesPassed}/${$.gatesTotal} (${z}%)`)}else Z.push("  Gates passed: N/A");if($.reviewsTotal>0){let z=[];if($.reviewsApproved>0)z.push(`${$.reviewsApproved} approved`);if($.reviewsRevision>0)z.push(`${$.reviewsRevision} revision requested`);let X=z.length>0?z.join(", "):"N/A";Z.push(`  Code reviews: ${$.reviewsTotal} (${X})`)}if(Object.keys($.gateFailures).length>0){let z=Object.entries($.gateFailures).filter(([,X])=>X>0).map(([X,q])=>`${X} (${q})`);if(z.length>0)Z.push(`  Gate failures: ${z.join(", ")}`)}if(Z.push(""),Z.push("Efficiency"),$.iterationCount>0&&$.iterations.length>0){let z=Math.round($.totalTokens/$.iterationCount),X=$.totalCost/$.iterationCount,q=$.totalDuration/$.iterationCount;Z.push(`  Avg tokens/iteration: ${H$(z)}`),Z.push(`  Avg cost/iteration: $${G$(X,2)}`),Z.push(`  Avg duration/iteration: ${z1(q)}`)}else Z.push("  N/A (no iteration metrics found)");if(Z.push(""),Z.push("Budget"),$.budgetLimit>0){let z=t($.budgetUsed/$.budgetLimit*100,1),X=Number.isInteger(z)?`${z}.0`:`${z}`;Z.push(`  Used: $${G$($.budgetUsed,2)} / $${G$($.budgetLimit,2)} (${X}%)`)}else if($.budgetUsed>0)Z.push(`  Used: $${G$($.budgetUsed,2)} (no limit set)`);else Z.push("  N/A");if(Q&&$.iterations.length>0)Z.push(""),Z.push("Per-Iteration Breakdown"),$.iterations.forEach((z,X)=>{let q=X+1,K=X1(H$(z.input_tokens??0),10),W=X1(H$(z.output_tokens??0),10),J=z.cost_usd??0,U=z1(z.duration_seconds??0),H=X1(`${q}`,3);Z.push(`  #${H} input: ${K} output: ${W} cost: $${G$(J,2)}  time: ${U}`)});return Z.join(`
`)}function K0($){let Q=!1,Z=!1;for(let K of $)if(K==="--json")Q=!0;else if(K==="--efficiency")Z=!0;let z=j();if(!K1(z)){if(Q)return{exitCode:0,stdout:'{"error": "No active session"}'};return{exitCode:0,stdout:`${_}No active session found.${V}
Start a session with: loki start <prd>`}}let X=nQ(z);return{exitCode:0,stdout:Q?aQ(X,Z):sQ(X,Z)}}async function rQ($){let{emitDeprecatedAlias:Q}=await Promise.resolve().then(() => (Z1(),Z0));Q("stats","report session",$);let Z=K0($);return console.log(Z.stdout),Z.exitCode}var V0=P(()=>{b();c()});var T0={};h(T0,{runDoctor:()=>U3,pythonImportOk:()=>W1,httpReachable:()=>V1,checkTool:()=>G0,checkSkills:()=>B0,checkDisk:()=>J1,buildDoctorJson:()=>M0,_setPythonImportOkForTest:()=>z3});import{existsSync as J0,lstatSync as tQ,readlinkSync as iQ,statfsSync as eQ}from"fs";import{spawnSync as $3}from"child_process";import{homedir as W0}from"os";import{resolve as q1}from"path";function Z3($){let Q=$.match(Q3);return Q?Q[1]:null}async function U0($){try{let Q=await k([$,"--version"],{timeoutMs:5000}),Z=(Q.stdout||Q.stderr||"").trim();return Z3(Z)}catch{return null}}function H0($,Q){let Z=$.split(".").map((X)=>parseInt(X,10)),z=Q.split(".").map((X)=>parseInt(X,10));while(Z.length<2)Z.push(0);while(z.length<2)z.push(0);for(let X=0;X<2;X++){let q=Z[X]??0,K=z[X]??0;if(Number.isNaN(q)||Number.isNaN(K))return 0;if(q!==K)return q-K}return 0}async function G0($,Q,Z,z=null){let X=await f(Q),q=X!==null,K=q?await U0(Q):null,W="pass";if(!q)W=Z==="required"?"fail":"warn";else if(z&&K){if(H0(K,z)<0)W=Z==="required"?"fail":"warn"}return{name:$,command:Q,found:q,version:K,required:Z,min_version:z,status:W,path:X}}function J1(){let $=null;try{let Z=eQ(W0()),z=Number(Z.bavail)*Number(Z.bsize);$=Math.round(z/1073741824*10)/10}catch{$=null}let Q="pass";if($!==null){if($<1)Q="fail";else if($<5)Q="warn"}return{available_gb:$,status:Q}}async function V1($,Q=2000){try{return(await fetch($,{signal:AbortSignal.timeout(Q)})).ok}catch{return!1}}async function W1($,Q=!1){let Z=`import ${$}`,z=Q?30000:5000;if(!Q)return(await z$(Z,{timeoutMs:z})).exitCode===0;let X=await Z$();if(!X)return!1;return(await k([X,"-c",Z],{timeoutMs:z})).exitCode===0}function z3($){C$.fn=$??W1}function B0(){let $=W0();return X3.map(({name:Q,dir:Z})=>{let z=q1($,Z),X=z,q=q1(z,"SKILL.md");if(J0(q))return{name:Q,path:X,status:"pass",detail:""};try{if(tQ(z).isSymbolicLink()){let W="unknown";try{W=iQ(z)}catch{}return{name:Q,path:X,status:"fail",detail:`(broken symlink -> ${W})`}}}catch{}return{name:Q,path:X,status:"warn",detail:"(not found - run 'loki setup-skill')"}})}async function Y0(){return Promise.all(K3.map(async($)=>{return{...await G0($.jsonName,$.cmd,$.required,$.min??null),displayName:$.displayName}}))}async function q3(){let Q=await f("sentrux")!==null,Z=Q?await U0("sentrux"):null;return{found:Q,version:Z,status:Q?"pass":"warn",required:"optional"}}async function V3(){let{openSync:$,statSync:Q,readSync:Z,closeSync:z,existsSync:X}=await import("fs"),{join:q}=await import("path"),K=65536,W=process.env.LOKI_DIR??".loki",J=q(W,"memory",".errors.log"),U=[],H=!1;try{if(X(J)){H=!0;let Y=Q(J).size,G=Math.max(0,Y-65536),B=Y-G,O=Buffer.alloc(B),M=$(J,"r");try{Z(M,O,0,B,G)}finally{z(M)}let F=O.toString("utf-8").split(`
`);if(G>0&&F.length>0)F=F.slice(1);F=F.map((C)=>C.trim()).filter((C)=>C.length>0),U=F.slice(-5)}}catch{U=[]}return{errors_log_path:H?J:null,recent_errors:U,recent_error_count:U.length,status:U.length===0?"pass":"warn"}}async function M0(){let Q=(await Y0()).map(({displayName:J,...U})=>U),Z=J1(),z=await q3(),X=await V3(),q=0,K=0,W=0;for(let J of Q)if(J.status==="pass")q++;else if(J.status==="fail")K++;else W++;if(Z.status==="pass")q++;else if(Z.status==="fail")K++;else W++;return{loki_mode_version:R$(),checks:Q,disk:Z,sentrux:z,memory:X,summary:{passed:q,failed:K,warnings:W,ok:K===0}}}function w($){switch($){case"pass":return`${S}PASS${V}`;case"fail":return`${T}FAIL${V}`;case"warn":return`${_}WARN${V}`}}function S$($){let Q=$.version?` (v${$.version})`:"",Z=$.displayName;if(!$.found){let z=$.required==="required"?"not found":$.required==="recommended"?"not found (recommended)":"not found (optional)";return`  ${w($.status)}  ${Z} - ${z}`}if($.min_version&&$.version&&H0($.version,$.min_version)<0){let z=$.required==="required"?"requires":"recommended";return`  ${w($.status)}  ${Z}${Q} - ${z} >= ${$.min_version}`}return`  ${w($.status)}  ${Z}${Q}`}function D$($,Q){if(Q==="pass")$.pass++;else if(Q==="fail")$.fail++;else $.warn++}function J3(){process.stdout.write(`${x}loki doctor${V} - Check system prerequisites

`),process.stdout.write(`Usage: loki doctor [--json]

`),process.stdout.write(`Options:
`),process.stdout.write(`  --json    Output machine-readable JSON

`),process.stdout.write(`Checks: node, python3, jq, git, curl, bash version,
`),process.stdout.write(`        claude/codex CLIs, and disk space.
`)}async function W3(){process.stdout.write(`${x}Loki Mode Doctor${V}

`),process.stdout.write(`Checking system prerequisites...

`);let $={pass:0,fail:0,warn:0},Q=await Y0(),Z=new Map(Q.map((A)=>[A.command,A]));process.stdout.write(`${I}Required:${V}
`);for(let A of["node","python3","jq","git","curl"]){let E=Z.get(A);process.stdout.write(S$(E)+`
`),D$($,E.status)}process.stdout.write(`
`),process.stdout.write(`${I}AI Providers:${V}
`);let z=["claude","codex","cline","aider"],X={claude:"npm install -g @anthropic-ai/claude-code",codex:"npm install -g @openai/codex",cline:"npm install -g cline",aider:"pip install aider-chat"},q=!1;for(let A of z){let E=Z.get(A);if(process.stdout.write(S$(E)+`
`),!E.found&&X[A])process.stderr.write(`         ${_}Install: ${X[A]}${V}
`);if(D$($,E.status),E.found)q=!0}if(!q){if(process.stdout.write(`  ${w("fail")}  No AI provider CLI installed -- at least one is required
`),process.stdout.write(`         ${_}Install: npm install -g @anthropic-ai/claude-code${V}
`),$.fail++,process.stdout.isTTY){let A=q1(g,"autonomy/provider-offer.sh");if(J0(A))$3("bash",[A,"report"],{stdio:"inherit"})}}process.stdout.write(`
`),process.stdout.write(`${I}API Keys:${V}
`);let K=Z.get("claude")?.found??!1,W=Z.get("codex")?.found??!1,J=process.env;if(J.ANTHROPIC_API_KEY)process.stdout.write(`  ${w("pass")}  ANTHROPIC_API_KEY is set
`),$.pass++;else if(K)process.stdout.write(`  ${y}  --  ${V}  ANTHROPIC_API_KEY not set (Claude CLI uses its own login)
`);if(J.OPENAI_API_KEY)process.stdout.write(`  ${w("pass")}  OPENAI_API_KEY is set
`),$.pass++;else if(W)process.stdout.write(`  ${y}  --  ${V}  OPENAI_API_KEY not set (Codex CLI uses its own login)
`);if(J.ANTHROPIC_BASE_URL){let A=J.ANTHROPIC_BASE_URL;if(process.stdout.write(`  ${w("pass")}  ANTHROPIC_BASE_URL: ${A}
`),$.pass++,!J.LOKI_MODEL_OVERRIDE)process.stdout.write(`  ${w("warn")}  LOKI_MODEL_OVERRIDE not set -- opus/sonnet/haiku aliases may not resolve on alt-provider
`),$.warn++;else process.stdout.write(`  ${w("pass")}  LOKI_MODEL_OVERRIDE: ${J.LOKI_MODEL_OVERRIDE}
`),$.pass++}process.stdout.write(`
`),process.stdout.write(`${I}Skills:${V}
`);for(let A of B0())if(A.status==="pass")process.stdout.write(`  ${w("pass")}  ${A.name}  ${y}${A.path}${V}
`),$.pass++;else if(A.status==="fail")process.stdout.write(`  ${w("fail")}  ${A.name}  ${y}${A.detail}${V}
`),process.stdout.write(`         ${_}Fix: loki setup-skill${V}
`),$.fail++;else process.stdout.write(`  ${w("warn")}  ${A.name}  ${y}${A.detail}${V}
`),$.warn++;process.stdout.write(`
`),process.stdout.write(`${I}Integrations:${V}
`);let[U,H,Y]=await Promise.all([C$.fn("mcp"),C$.fn("numpy",!0),C$.fn("sentence_transformers",!0)]);if(U)process.stdout.write(`  ${w("pass")}  MCP SDK (Python)
`),$.pass++;else process.stdout.write(`  ${w("warn")}  MCP SDK - not installed (pip3 install mcp)
`),$.warn++;if(H)process.stdout.write(`  ${w("pass")}  numpy (vector search)
`),$.pass++;else process.stdout.write(`  ${w("warn")}  numpy - not installed (pip3 install numpy)
`),$.warn++;if(Y)process.stdout.write(`  ${w("pass")}  sentence-transformers (embeddings)
`),$.pass++;else process.stdout.write(`  ${w("warn")}  sentence-transformers - not installed (loki memory vectors setup)
`),$.warn++;if(await V1("http://localhost:8100/api/v2/heartbeat"))process.stdout.write(`  ${w("pass")}  ChromaDB server (port 8100)
`),$.pass++;else process.stdout.write(`  ${w("warn")}  ChromaDB - not running (docker start loki-chroma)
`),$.warn++;{let A=["pyright-langserver","pylsp","typescript-language-server","gopls","rust-analyzer","jdtls"],E=[];for(let n of A)if(await f(n))E.push(n);if(E.length>0)process.stdout.write(`  ${w("pass")}  LSP servers detected (${E.length}): ${E.join(", ")}
`),$.pass++;else process.stdout.write(`  ${w("warn")}  LSP servers - none on PATH (install for symbol grounding: npm i -g pyright typescript-language-server; brew install gopls)
`),$.warn++}let G=process.env.LOKI_MIROFISH_URL;if(G)if(await V1(`${G}/health`))process.stdout.write(`  ${w("pass")}  MiroFish server (${G})
`),$.pass++;else process.stdout.write(`  ${w("warn")}  MiroFish - not running (loki start --mirofish-docker <image>)
`),$.warn++;if(process.env.LOKI_OTEL_ENDPOINT)process.stdout.write(`  ${w("pass")}  OTEL endpoint: ${process.env.LOKI_OTEL_ENDPOINT}
`),$.pass++;else process.stdout.write(`  ${w("warn")}  OTEL - not configured (set LOKI_OTEL_ENDPOINT)
`),$.warn++;if(await f("sentrux")){let A="unknown";try{let n=(await k(["sentrux","--version"],{timeoutMs:2000})).stdout.split(/\s+/).filter(Boolean).pop();if(n)A=n.replace(/^v/,"")}catch{}process.stdout.write(`  ${w("pass")}  sentrux ${A} (architectural drift gate: loki sentrux help)
`),$.pass++}else process.stdout.write(`  ${w("warn")}  sentrux - not installed (optional, brew install sentrux/tap/sentrux)
`),$.warn++;process.stdout.write(`
`),process.stdout.write(`${I}System:${V}
`);let B=Z.get("bash");process.stdout.write(S$(B)+`
`),D$($,B.status);let O=Z.get("bun");if(O)process.stdout.write(S$(O)+`
`),D$($,O.status);let M=J1(),L=M.available_gb===null?null:Math.floor(M.available_gb);if(L===null)process.stdout.write(`  ${w("warn")}  Disk space: unable to determine
`),$.warn++;else if(M.status==="fail")process.stdout.write(`  ${w("fail")}  Disk space: ${L}GB available (need >= 1GB)
`),$.fail++;else if(M.status==="warn")process.stdout.write(`  ${w("warn")}  Disk space: ${L}GB available (low)
`),$.warn++;else process.stdout.write(`  ${w("pass")}  Disk space: ${L}GB available
`),$.pass++;process.stdout.write(`
`),process.stdout.write(`${I}Runtime route:${V}
`);let F=process.versions.bun!==void 0,C=process.argv[0]??"(unknown)";if(process.stdout.write(`  ${w("pass")}  Active runtime: ${F?"Bun":"Node"} (${C})
`),process.env.LOKI_LEGACY_BASH==="1"||process.env.LOKI_LEGACY_BASH==="true")process.stdout.write(`  ${w("warn")}  LOKI_LEGACY_BASH set: shim routes every command to autonomy/loki (bash)
`);if(process.env.LOKI_TS_ENTRY)process.stdout.write(`  ${w("pass")}  LOKI_TS_ENTRY override: ${process.env.LOKI_TS_ENTRY}
`);if(process.env.BUN_FROM_SOURCE==="1"||process.env.BUN_FROM_SOURCE==="true")process.stdout.write(`  ${w("pass")}  BUN_FROM_SOURCE set: shim prefers loki-ts/src/ over dist/
`);let u=await Z$();if(u!==null){let E=(await k([u,"-c","import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"],{timeoutMs:5000})).stdout.trim();if(E.startsWith("3.12"))process.stdout.write(`  ${w("pass")}  Python 3.12 (chromadb / sentence-transformers): ${E} at ${u}
`);else if(E)process.stdout.write(`  ${w("warn")}  Python 3.12 NOT found -- using ${E} at ${u}; chromadb / sentence-transformers may fail. Install python3.12 (brew install python@3.12 / apt install python3.12).
`);else process.stdout.write(`  ${w("warn")}  Python 3 found at ${u} but version probe failed; chromadb may not work.
`)}else process.stdout.write(`  ${w("warn")}  Python 3 not on PATH -- memory + MCP integrations disabled.
`);if(process.stdout.write(`
`),process.stdout.write(`${x}Summary:${V} ${S}${$.pass} passed${V}, ${T}${$.fail} failed${V}, ${_}${$.warn} warnings${V}

`),$.fail>0)return process.stdout.write(`${T}Some required prerequisites are missing.${V}
`),process.stdout.write(`Install missing dependencies and run 'loki doctor' again.
`),1;if($.warn>0)return process.stdout.write(`${_}All required checks passed with some warnings.${V}
`),0;return process.stdout.write(`${S}All checks passed. System is ready for Loki Mode.${V}
`),0}async function U3($){let Q=!1;for(let Z of $)if(Z==="--json")Q=!0;else if(Z==="--help"||Z==="-h")return J3(),0;else return process.stderr.write(`${T}Unknown option: ${Z}${V}
`),process.stderr.write(`Usage: loki doctor [--json]
`),1;if(Q){let Z=await M0();return process.stdout.write(JSON.stringify(Z,null,2)+`
`),0}return W3()}var Q3,C$,X3,K3;var O0=P(()=>{b();d();V$();c();t$();Q3=/(\d+\.\d+(?:\.\d+)*)/;C$={fn:W1};X3=[{name:"Claude Code",dir:".claude/skills/loki-mode"},{name:"Codex CLI",dir:".codex/skills/loki-mode"},{name:"Cline CLI",dir:".cline/skills/loki-mode"},{name:"Aider CLI",dir:".aider/skills/loki-mode"}];K3=[{displayName:"Node.js (>= 18)",jsonName:"Node.js",cmd:"node",required:"required",min:"18.0"},{displayName:"Python 3 (>= 3.8)",jsonName:"Python 3",cmd:"python3",required:"required",min:"3.8"},{displayName:"jq",jsonName:"jq",cmd:"jq",required:"required"},{displayName:"git",jsonName:"git",cmd:"git",required:"required"},{displayName:"curl",jsonName:"curl",cmd:"curl",required:"required"},{displayName:"bash (>= 4.0)",jsonName:"bash",cmd:"bash",required:"recommended",min:"4.0"},{displayName:"Bun (>= 1.3)",jsonName:"Bun",cmd:"bun",required:"recommended",min:"1.3"},{displayName:"Claude CLI",jsonName:"Claude CLI",cmd:"claude",required:"optional"},{displayName:"Codex CLI",jsonName:"Codex CLI",cmd:"codex",required:"optional"},{displayName:"Cline CLI",jsonName:"Cline CLI",cmd:"cline",required:"optional"},{displayName:"Aider CLI",jsonName:"Aider CLI",cmd:"aider",required:"optional"}]});import{existsSync as _0,mkdirSync as B9,readdirSync as H3,readFileSync as I0,renameSync as Y9,writeFileSync as M9}from"fs";import{dirname as G3,join as B3,resolve as Y3}from"path";import{fileURLToPath as M3}from"url";function T3(){try{let $=G3(M3(import.meta.url)),Q=Y3($,"..","..","data","model-pricing.json");if(!_0(Q))return T$;let z=JSON.parse(I0(Q,"utf8")).pricing;if(!z||typeof z!=="object")return T$;let X={};for(let[q,K]of Object.entries(z))if(K!==null&&typeof K==="object"&&typeof K.input==="number"&&typeof K.output==="number")X[q]={input:K.input,output:K.output};for(let q of Object.keys(T$))if(!(q in X))return T$;return X}catch{return T$}}function O3($){return Math.round(($+Number.EPSILON)*1e4)/1e4}function w3($){let Q=($??A0).toLowerCase();return w0[Q]??w0[A0]}function L0($){let Q=0;for(let Z of $){if(typeof Z.cost_usd==="number"&&Number.isFinite(Z.cost_usd)){Q+=Z.cost_usd;continue}let z=w3(Z.model),X=typeof Z.input_tokens==="number"?Z.input_tokens:0,q=typeof Z.output_tokens==="number"?Z.output_tokens:0;Q+=X/1e6*z.input+q/1e6*z.output}return O3(Q)}function P0($){if(!_0($))return[];let Q=[],Z;try{Z=H3($)}catch{return[]}for(let z of Z){if(!z.endsWith(".json"))continue;let X=B3($,z);try{let q=I0(X,"utf8"),K=JSON.parse(q);if(K&&typeof K==="object")Q.push(K)}catch{}}return Q}var T$,w0,A0="sonnet";var j0=P(()=>{b();T$={fable:{input:10,output:50},opus:{input:5,output:25},sonnet:{input:3,output:15},haiku:{input:1,output:5},"gpt-5.3-codex":{input:1.5,output:12}};w0=Object.freeze(T3())});import{existsSync as b$,readdirSync as A3,readFileSync as _3,statSync as I3}from"fs";import{join as h$}from"path";function L3($){let Q=[],Z=h$($,"votes");if(!b$(Z))return Q;let z;try{z=A3(Z)}catch{return Q}for(let X of z){if(!X.startsWith("round-")||!X.endsWith(".json"))continue;try{let q=h$(Z,X);if(!I3(q).isFile())continue;let K=JSON.parse(_3(q,"utf8"));Q.push({iteration:typeof K.iteration==="number"?K.iteration:void 0,verdict:typeof K.verdict==="string"?K.verdict:void 0,complete_votes:typeof K.complete_votes==="number"?K.complete_votes:void 0,total_members:typeof K.total_members==="number"?K.total_members:void 0,threshold:typeof K.threshold==="number"?K.threshold:void 0})}catch{}}return Q}function P3(){return{iteration_count:0,total_cost_usd:0,avg_cost_per_iteration:null,total_input_tokens:0,total_output_tokens:0,total_duration_ms:0,avg_duration_ms_per_iteration:null,model_breakdown:{},phase_breakdown:{},status_breakdown:{}}}function j3(){return{council_rounds:0,unanimous_rate:null,approval_rate:null,iteration_success_rate:null}}function F3($){let Q=P3();if($.length===0)return Q;Q.iteration_count=$.length,Q.total_cost_usd=Math.round(L0($)*1e4)/1e4;for(let Z of $){if(typeof Z.input_tokens==="number")Q.total_input_tokens+=Z.input_tokens;if(typeof Z.output_tokens==="number")Q.total_output_tokens+=Z.output_tokens;let z=Z;if(typeof z.duration_ms==="number")Q.total_duration_ms+=z.duration_ms;if(typeof Z.model==="string")Q.model_breakdown[Z.model]=(Q.model_breakdown[Z.model]??0)+1;if(typeof z.phase==="string")Q.phase_breakdown[z.phase]=(Q.phase_breakdown[z.phase]??0)+1;if(typeof z.status==="string")Q.status_breakdown[z.status]=(Q.status_breakdown[z.status]??0)+1}return Q.avg_cost_per_iteration=Math.round(Q.total_cost_usd/Q.iteration_count*1e4)/1e4,Q.avg_duration_ms_per_iteration=Math.round(Q.total_duration_ms/Q.iteration_count),Q}function R3($,Q,Z){let z=j3();if(z.council_rounds=$.length,$.length>0){let X=0,q=0;for(let K of $){if(typeof K.complete_votes==="number"&&typeof K.total_members==="number"&&K.total_members>0&&K.complete_votes===K.total_members)X+=1;if(K.verdict==="COMPLETE")q+=1}z.unanimous_rate=Math.round(X/$.length*1e4)/1e4,z.approval_rate=Math.round(q/$.length*1e4)/1e4}if(Z>0)z.iteration_success_rate=Math.round(Q/Z*1e4)/1e4;return z}function F0($){let Q=[],Z=h$($,"metrics","efficiency"),z=h$($,"council"),X=b$(Z)?P0(Z):[];if(!b$(Z))Q.push("no .loki/metrics/efficiency/ dir (efficiency KPIs zeroed)");else if(X.length===0)Q.push(".loki/metrics/efficiency/ exists but no iteration files found");let q=L3(z);if(!b$(z))Q.push("no .loki/council/ dir (accuracy KPIs zeroed)");else if(q.length===0)Q.push(".loki/council/ exists but no round-N.json files found");let K=F3(X),W=K.status_breakdown.success??0,J=R3(q,W,K.iteration_count);return{schema_version:1,generated_at:new Date().toISOString(),loki_dir:$,efficiency:K,accuracy:J,notes:Q}}function R0($){return JSON.stringify($,null,2)}function k0($){let Q=[];Q.push(`Loki Mode KPIs  (snapshot at ${$.generated_at})`),Q.push(`Source: ${$.loki_dir}`),Q.push(""),Q.push("Efficiency"),Q.push(`  Iterations:           ${$.efficiency.iteration_count}`),Q.push(`  Total cost USD:       ${$.efficiency.total_cost_usd}`),Q.push(`  Avg cost per iter:    ${$.efficiency.avg_cost_per_iteration??"n/a"}`),Q.push(`  Total input tokens:   ${$.efficiency.total_input_tokens}`),Q.push(`  Total output tokens:  ${$.efficiency.total_output_tokens}`),Q.push(`  Total duration (ms):  ${$.efficiency.total_duration_ms}`),Q.push(`  Avg duration / iter:  ${$.efficiency.avg_duration_ms_per_iteration??"n/a"}`);let Z=Object.entries($.efficiency.model_breakdown).sort((q,K)=>q[0].localeCompare(K[0]));if(Z.length>0)Q.push(`  Model breakdown:      ${Z.map(([q,K])=>`${q}=${K}`).join(", ")}`);let z=Object.entries($.efficiency.phase_breakdown).sort((q,K)=>q[0].localeCompare(K[0]));if(z.length>0)Q.push(`  Phase breakdown:      ${z.map(([q,K])=>`${q}=${K}`).join(", ")}`);let X=Object.entries($.efficiency.status_breakdown).sort((q,K)=>q[0].localeCompare(K[0]));if(X.length>0)Q.push(`  Status breakdown:     ${X.map(([q,K])=>`${q}=${K}`).join(", ")}`);if(Q.push(""),Q.push("Accuracy"),Q.push(`  Council rounds:       ${$.accuracy.council_rounds}`),Q.push(`  Unanimous rate:       ${$.accuracy.unanimous_rate??"n/a"}`),Q.push(`  Approval rate:        ${$.accuracy.approval_rate??"n/a"}`),Q.push(`  Iter success rate:    ${$.accuracy.iteration_success_rate??"n/a"}`),$.notes.length>0){Q.push(""),Q.push("Notes");for(let q of $.notes)Q.push(`  - ${q}`)}return Q.push(""),Q.push("See also: loki trust  (trust trajectory across runs)"),Q.join(`
`)}var x0=P(()=>{j0()});var U1={};h(U1,{runKpis:()=>x3});function x3($,Q={}){if(Q.aliasOf)Q1(Q.aliasOf,"report kpis",$);let Z=!1;for(let X of $){if(X==="--help"||X==="-h"||X==="help")return process.stdout.write(k3),0;if(X==="--json"){Z=!0;continue}if(X==="-q"||X==="--quiet")continue;return process.stderr.write(`loki kpis: unknown arg: ${X}
Run 'loki kpis --help' for usage.
`),1}let z=F0(j());return process.stdout.write(Z?R0(z)+`
`:k0(z)+`
`),0}var k3=`loki report kpis -- accuracy + efficiency KPI snapshot (v7.5.28 MVP)

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
`;var H1=P(()=>{x0();b();Z1()});var E0={};h(E0,{delegateToBash:()=>S3});import{resolve as E3}from"path";async function S3($){let Q=E3(g,"autonomy","loki"),Z=Bun.spawn({cmd:[Q,...$],stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,LOKI_LEGACY_BASH:"1"}}),z=setTimeout(()=>{try{Z.kill("SIGKILL")}catch{}},N3);try{return await Z.exited}finally{clearTimeout(z)}}var N3=3600000;var N0=P(()=>{b()});import{existsSync as D3,mkdirSync as C3,readdirSync as b3,readFileSync as h3,statSync as y3,writeFileSync as v3}from"fs";import{join as O$}from"path";function G1($){return $&&typeof $==="object"?$:{}}function X$($){return Math.round($*1e4)/1e4}function c3($){let Q=String($??"").trim().toUpperCase();if(!Q)return null;for(let Z of D0)if(Q.startsWith(Z))return!0;return!1}function p3($){let Q=c3($.final_verdict);if(Q!==null)return Q?1:0;let Z=$.reviewers;if(Array.isArray(Z)&&Z.length>0){let z=0,X=0;for(let q of Z){if(!q||typeof q!=="object")continue;X+=1;let K=String(q.vote??"").trim().toUpperCase();if(D0.some((W)=>K.startsWith(W)))z+=1}if(X>0)return z===X?1:0}return null}function l3($){let Q=Number($.total),Z=Number($.passed);if(!Number.isFinite(Q)||!Number.isFinite(Z))return null;if(Q<=0)return null;return Math.max(0,Math.min(1,Z/Q))}function d3($){let Q;if($&&typeof $==="object")Q=$.count;else Q=$;let Z=Number(Q);if(!Number.isFinite(Z)||Z<0)return null;return Z}function o3($){let Q=G1($.council);for(let Z of[Q.interventions,$.interventions]){let z=Number(Z);if(Number.isFinite(z)&&z>=0)return z}return null}function n3($){let Q=O$($,"proofs"),Z=[];if(!D3(Q))return Z;let z;try{z=b3(Q).sort()}catch{return Z}for(let X of z){let q=O$(Q,X);try{if(!y3(q).isDirectory())continue}catch{continue}let K=null;try{K=JSON.parse(h3(O$(q,"proof.json"),"utf8"))}catch{continue}if(!K||typeof K!=="object")continue;Z.push({run_id:String(K.run_id??X),generated_at:typeof K.generated_at==="string"?K.generated_at:null,council_pass_rate:p3(G1(K.council)),gate_pass_rate:l3(G1(K.quality_gates)),iterations:d3(K.iterations),interventions:o3(K)})}return Z.sort((X,q)=>{let K=X.generated_at===null?1:0,W=q.generated_at===null?1:0;if(K!==W)return K-W;return(X.generated_at??"").localeCompare(q.generated_at??"")}),Z}function S0($){return $.reduce((Q,Z)=>Q+Z,0)/$.length}function a3($,Q){let Z=g3[$],z=f3[$],X=u3[$],q=Q.filter((M)=>M!==null),K=q.length;if(K===0)return{axis:$,label:X,available:!1,higher_is_better:Z,note:"no runs recorded this metric"};if(K<2)return{axis:$,label:X,available:!0,higher_is_better:Z,data_points:K,latest:X$(q[K-1]),direction:"flat",improving:null,delta:0,earlier_mean:X$(q[0]),later_mean:X$(q[K-1]),insufficient:!0,note:"not enough history yet (need 2+ runs with this metric)"};let W=Math.floor(K/2),J=q.slice(0,W),U=q.slice(K-W),H=S0(J),Y=S0(U),G=Y-H,B;if(Math.abs(G)<=z)B="flat";else if(G>0)B="up";else B="down";let O;if(B==="flat")O=null;else O=B==="up"===Z;return{axis:$,label:X,available:!0,higher_is_better:Z,data_points:K,latest:X$(q[K-1]),direction:B,improving:O,delta:X$(G),earlier_mean:X$(H),later_mean:X$(Y),insufficient:!1}}function C0($){let Q=n3($),Z=Q.map((J)=>({run_id:J.run_id,generated_at:J.generated_at,council_pass_rate:J.council_pass_rate,gate_pass_rate:J.gate_pass_rate,iterations:J.iterations,interventions:J.interventions})),z={};for(let J of y$)z[J]=a3(J,Q.map((U)=>U[J]));let X=Q.length<2,q=y$.filter((J)=>z[J].available&&z[J].improving===!0),K=y$.filter((J)=>z[J].available&&z[J].improving===!1),W=[];if(X)W.push(`not enough history yet: ${Q.length} run(s) recorded, need 2+ to show a trend`);if(!z.interventions.available)W.push("intervention trend unavailable: no per-run intervention count in proof.json yet (axis lights up automatically once recorded)");return{schema_version:m3,generated_at:new Date().toISOString(),loki_dir:$,runs_count:Q.length,insufficient:X,axes:z,improving_count:q.length,regressing_count:K.length,improving_axes:q,regressing_axes:K,series:Z,notes:W}}function b0($){return JSON.stringify($,null,2)}function h0($,Q){let Z=O$($,"metrics"),z=O$(Z,"trust-trajectory.json");try{return C3(Z,{recursive:!0}),v3(z,JSON.stringify(Q,null,2)),z}catch{return null}}function s3($){if($==="up")return"up";if($==="down")return"down";return"flat"}function r3($){let Q=$.label??$.axis;if(!$.available)return`  ${(Q+":").padEnd(26)} no data`;let Z;if($.insufficient)Z="(need 2+ runs)";else if($.improving===!0)Z="improving";else if($.improving===!1)Z="regressing";else Z="stable";let z=$.higher_is_better?"higher better":"lower better",X=$.latest??"n/a";return`  ${(Q+":").padEnd(26)} ${s3($.direction).padEnd(5)} latest=${String(X).padEnd(7)} ${Z.padEnd(11)} [${z}]`}function y0($){let Q=[];if(Q.push(`Loki Mode Trust Trajectory  (snapshot at ${$.generated_at})`),Q.push(`Source: ${$.loki_dir}`),Q.push(`Runs analyzed: ${$.runs_count}`),Q.push(""),$.insufficient){if(Q.push("Not enough history yet."),Q.push("Trust trajectory needs 2+ recorded runs to show a direction."),Q.push("Each `loki start` run writes a proof-of-run; come back after the next run."),$.notes.length>0){Q.push(""),Q.push("Notes");for(let X of $.notes)Q.push(`  - ${X}`)}return Q.join(`
`)}Q.push("Is the agent earning autonomy on this repo?");for(let X of y$)if($.axes[X])Q.push(r3($.axes[X]));Q.push("");let{improving_count:Z,regressing_count:z}=$;if(Z&&!z)Q.push(`Overall: trending more trustworthy (${Z} axis improving).`);else if(z&&!Z)Q.push(`Overall: trust regressing (${z} axis regressing). Review recent runs.`);else if(Z||z)Q.push(`Overall: mixed (${Z} improving / ${z} regressing).`);else Q.push("Overall: stable.");if($.notes.length>0){Q.push(""),Q.push("Notes");for(let X of $.notes)Q.push(`  - ${X}`)}return Q.join(`
`)}var m3=1,y$,g3,f3,u3,D0;var v0=P(()=>{y$=["council_pass_rate","gate_pass_rate","iterations","interventions"],g3={council_pass_rate:!0,gate_pass_rate:!0,iterations:!1,interventions:!1},f3={council_pass_rate:0.01,gate_pass_rate:0.01,iterations:0.25,interventions:0.25},u3={council_pass_rate:"Council pass rate",gate_pass_rate:"Gate pass rate",iterations:"Iterations to completion",interventions:"Human interventions"},D0=["APPROVE","APPROVED","COMPLETE","PASS","PASSED"]});var m0={};h(m0,{runTrust:()=>i3});function i3($){let Q=!1;for(let X of $){if(X==="--help"||X==="-h"||X==="help")return process.stdout.write(t3),0;if(X==="--json"){Q=!0;continue}return process.stderr.write(`loki trust: unknown arg: ${X}
Run 'loki trust --help' for usage.
`),1}let Z=j(),z=C0(Z);return h0(Z,z),process.stdout.write(Q?b0(z)+`
`:y0(z)+`
`),0}var t3=`loki trust -- visible trust trajectory (R4)

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
`;var g0=P(()=>{v0();b()});import{closeSync as B1,fstatSync as e3,lstatSync as $8,mkdirSync as f0,openSync as u0,readSync as Q8,renameSync as Z8,rmSync as c0,statSync as z8,unlinkSync as p0,writeFileSync as X8,writeSync as K8}from"fs";import{dirname as l0}from"path";function w$($,Q){f0(l0($),{recursive:!0});let Z=`${$}.tmp.${process.pid}.${++q8}`;X8(Z,`${JSON.stringify(Q,null,2)}
`),Z8(Z,$)}async function d0($,Q){let Z=v$.get($)??Promise.resolve(),z=()=>{},X=new Promise((K)=>{z=K}),q=Z.catch(()=>{}).then(()=>X);v$.set($,q);try{return await Z.catch(()=>{}),await Q()}finally{if(z(),v$.get($)===q)v$.delete($)}}function J8($){return`${$}.lock`}function W8($){if(!Number.isFinite($)||$<=0)return!1;try{return process.kill($,0),!0}catch(Q){return Q?.code==="EPERM"}}function U8($){let Q=null;try{return f0(l0($),{recursive:!0}),Q=u0($,"wx"),K8(Q,`${process.pid}
`),Q}catch(Z){if(Q!==null){try{B1(Q)}catch{}try{p0($)}catch{}}if(Z?.code==="EEXIST")return null;throw Z}}function H8($,Q){let Z;try{Z=$8($)}catch{return!0}if(Z.isSymbolicLink())try{return p0($),!0}catch{return!1}let z;try{z=u0($,"r")}catch{return!0}try{let X=e3(z);if(Date.now()-X.mtimeMs<Q)return!1;let K=NaN;try{let W=Buffer.alloc(64),J=Q8(z,W,0,64,0);K=Number.parseInt(W.subarray(0,J).toString("utf-8").trim(),10)}catch{}if(Number.isFinite(K)&&W8(K))return!1;try{if(z8($).mtimeMs>X.mtimeMs)return!1}catch{return!0}try{c0($,{force:!0})}catch{}return!0}finally{try{B1(z)}catch{}}}function A$($,Q,Z={}){let z=Z.timeoutMs??1e4,X=Z.pollMs??25,q=Z.staleMs??30000,K=J8($),W=Date.now()+z,J=null,U=0,H=new Int32Array(new SharedArrayBuffer(4));while(J===null){if(J=U8(K),J!==null)break;if(Date.now()>W)throw Error(`withFileLockSync: timed out after ${z}ms acquiring ${K}`);if(H8(K,q))continue;let Y=Math.min(X*2**Math.min(U,4),V8);U+=1,Atomics.wait(H,0,0,Y)}try{return Q()}finally{try{B1(J)}catch{}try{c0(K,{force:!0})}catch{}}}var q8=0,v$,V8=50;var m$=P(()=>{v$=new Map});import{existsSync as K$,mkdirSync as B$,copyFileSync as s0,readFileSync as T1,readdirSync as G8,statSync as B8,writeFileSync as Y8,renameSync as r0,appendFileSync as t0,rmSync as M8}from"fs";import{join as m,dirname as g$}from"path";function O8($){let Q=n0.then($,$);return n0=Q.catch((Z)=>{console.warn("[checkpoint] serialized op rejected:",Z);return}),Q}function o($){return m($,"state","checkpoints")}function i0($){return m(o($),"index.jsonl")}async function w8($){let Q=await k(["git","rev-parse","HEAD"],{cwd:$,timeoutMs:5000});if(Q.exitCode!==0)return"no-git";return Q.stdout.trim()||"no-git"}async function A8($){let Q=await k(["git","branch","--show-current"],{cwd:$,timeoutMs:5000});if(Q.exitCode!==0)return"unknown";return Q.stdout.trim()||"unknown"}async function _8($){let Q=await k(["git","diff","--quiet"],{cwd:$,timeoutMs:5000}),Z=await k(["git","diff","--cached","--quiet"],{cwd:$,timeoutMs:5000}),z=Q.exitCode===1,X=Z.exitCode===1;return z||X}function I8($){let Q=m($,"state","orchestrator.json");if(!K$(Q))return"unknown";try{let z=JSON.parse(T1(Q,"utf-8")).currentPhase;return typeof z==="string"&&z.length>0?z:"unknown"}catch{return"unknown"}}function P8($,Q){for(let Z of L8){let z=m($,Z);if(!K$(z))continue;let X=m(Q,Z);B$(g$(X),{recursive:!0});try{s0(z,X)}catch{}}}function $6($,Q){B$(g$($),{recursive:!0});let Z=`${$}.tmp.${process.pid}.${++e0}`;Y8(Z,Q),r0(Z,$)}function j8($){return JSON.stringify($,null,2)}function Q6($){return`{${[`"id": ${JSON.stringify($.id)}`,`"ts": ${JSON.stringify($.ts)}`,`"iter": ${JSON.stringify($.iter)}`,`"task": ${JSON.stringify($.task)}`,`"sha": ${JSON.stringify($.sha)}`].join(", ")}}`}async function F8($){return O8(()=>R8($))}async function R8($){let Q=$.lokiDirOverride??j(),Z=process.cwd(),z=o(Q);if(B$(z,{recursive:!0}),!$.forceCreate){if(!await _8(Z))return{created:!1,reason:"no uncommitted changes"}}let X=await w8(Z),q=await A8(Z),K=$.iteration??Number.parseInt(process.env.ITERATION_COUNT??"0",10),W=$.epochOverride??Math.floor(Date.now()/1000),J=`cp-${K}-${W}`,U=m(z,J);B$(U,{recursive:!0}),P8(Q,U);let H=new Date().toISOString().replace(/\.\d{3}Z$/,"Z"),Y=($.taskDescription??"task completed").slice(0,T8),G=$.provider??process.env.PROVIDER_NAME??"claude",B={id:J,timestamp:H,iteration:K,task_id:$.taskId??"unknown",task_description:Y,git_sha:X,git_branch:q,provider:G,phase:I8(Q)};$6(m(U,"metadata.json"),j8(B));let O={id:B.id,ts:B.timestamp,iter:B.iteration,task:B.task_description,sha:B.git_sha},M=i0(Q);return A$(M,()=>{t0(M,`${Q6(O)}
`)}),k8(Q),{created:!0,id:J,metadata:B,dir:U}}function O1($){let Q=o($);if(!K$(Q))return[];return G8(Q).filter((Z)=>Z.startsWith("cp-")).filter((Z)=>{try{return B8(m(Q,Z)).isDirectory()}catch{return!1}})}function w1($){return[...$].sort((Q,Z)=>{let z=a0(Q),X=a0(Z);return z-X})}function a0($){let Q=$.split("-");if(Q.length<3)return 0;let Z=Q[Q.length-1],z=Number.parseInt(Z??"0",10);return Number.isFinite(z)?z:0}function k8($){let Q=O1($);if(Q.length<=o0)return;let Z=w1(Q),z=Z.slice(0,Z.length-o0);for(let X of z)try{M8(m(o($),X),{recursive:!0,force:!0})}catch{}x8($)}function x8($){let Q=w1(O1($)),Z=[];for(let q of Q){let K=m(o($),q,"metadata.json"),W=m(o($),q);if(!K$(K)){Y1($,W,"missing_field","metadata.json");continue}try{let J=JSON.parse(T1(K,"utf-8")),U=z6(J,K);if(!U.ok){Y1($,W,U.reason,U.field);continue}let H=U.value;Z.push(Q6({id:H.id,ts:H.timestamp,iter:H.iteration,task:H.task_description??"",sha:H.git_sha}))}catch{Y1($,W,"invalid_type","metadata.json")}}let z=i0($),X=Z.length>0?`${Z.join(`
`)}
`:"";$6(z,X)}function Y1($,Q,Z,z){let X=m($,"events.jsonl"),q={timestamp:new Date().toISOString(),type:"checkpoint.metadata.dropped",checkpoint_dir:Q,reason:Z,field:z};try{B$(g$(X),{recursive:!0}),A$(X,()=>{t0(X,`${JSON.stringify(q)}
`)})}catch{}}function A1($){let Q=$??j(),Z=w1(O1(Q)),z=[];for(let X of Z){let q=Z6(Q,X);if(q)z.push(q)}return z}function Z6($,Q){let Z=m(o($),Q,"metadata.json");if(!K$(Z))return null;try{let z=JSON.parse(T1(Z,"utf-8"));return E8(z,Z)}catch{return null}}function E8($,Q){let Z=z6($,Q);return Z.ok?Z.value:null}function z6($,Q){if($===null||typeof $!=="object")return console.warn(`[checkpoint] invalid metadata at ${Q}: not an object`),{ok:!1,reason:"invalid_type",field:"<root>"};let Z=$,z=["id","timestamp","task_id","task_description","git_sha","git_branch","provider","phase"];for(let X of z){if(!(X in Z))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "${X}" missing`),{ok:!1,reason:"missing_field",field:X};if(typeof Z[X]!=="string")return console.warn(`[checkpoint] invalid metadata at ${Q}: field "${X}" not a string`),{ok:!1,reason:"invalid_type",field:X}}if(!Object.prototype.hasOwnProperty.call(Z,"iteration"))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "iteration" missing`),{ok:!1,reason:"missing_field",field:"iteration"};if(typeof Z.iteration!=="number"||!Number.isFinite(Z.iteration))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "iteration" not a finite number`),{ok:!1,reason:"invalid_type",field:"iteration"};for(let X of S8){let q=Z[X];if(N8.test(q))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "${X}" contains control characters`),{ok:!1,reason:"control_chars",field:X}}return{ok:!0,value:{id:Z.id,timestamp:Z.timestamp,iteration:Z.iteration,task_id:Z.task_id,task_description:Z.task_description,git_sha:Z.git_sha,git_branch:Z.git_branch,provider:Z.provider,phase:Z.phase}}}function _1($,Q){if(!D8.test($))throw new X6($);let Z=Q??j(),z=m(o(Z),$);if(!K$(z))throw new M1($);let X=Z6(Z,$);if(!X)throw new M1($);return X}function K6($,Q){let Z=_1($,Q),z=Q??j(),X=m(o(z),$),q=[];for(let K of C8){let W=m(X,K);if(!K$(W))continue;q.push({from:W,to:m(z,K)})}return{id:$,metadata:Z,restore:q}}function b8($){let Q=[],Z=0;for(let z of $.restore)try{B$(g$(z.to),{recursive:!0});let X=`${z.to}.tmp.${process.pid}.${++e0}`;s0(z.from,X),r0(X,z.to),Z+=1}catch(X){Q.push(`${z.from} -> ${z.to}: ${X.message}`)}return{restored:Z,errors:Q}}async function q6($,Q,Z=!1){let z=null;try{let q=await F8({taskDescription:`pre-rollback snapshot (before restoring ${$.id})`,taskId:"rollback",forceCreate:!0,lokiDirOverride:Q});if(q.created)z=q.id}catch(q){let K=q instanceof Error?q.message:String(q);if(!Z)throw Error("pre-rollback snapshot failed ("+K+"); aborting rollback to preserve current state. Re-run with force to roll back anyway without a safety snapshot.");console.warn("[checkpoint] pre-rollback snapshot failed; proceeding due to force:",K)}let X=b8($);return{preRollbackSnapshotId:z,restored:X.restored,errors:X.errors}}var o0=50,T8=200,n0,L8,e0=0,N8,S8,D8,M1,X6,C8;var V6=P(()=>{b();d();m$();n0=Promise.resolve();L8=["state/orchestrator.json","autonomy-state.json","queue/pending.json","queue/completed.json","queue/in-progress.json","queue/current-task.json","CONTINUITY.md"];N8=/[\x00-\x08\x0a-\x1f\x7f-\x9f]/,S8=["id","task_id","git_sha","git_branch","provider","phase"];D8=/^[a-zA-Z0-9_-]+$/;M1=class M1 extends Error{id;constructor($){super(`Checkpoint not found: ${$}`);this.id=$;this.name="CheckpointNotFoundError"}};X6=class X6 extends Error{id;constructor($){super(`Invalid checkpoint ID: must be alphanumeric, hyphens, underscores only (got: ${$})`);this.id=$;this.name="InvalidCheckpointIdError"}};C8=["state/orchestrator.json","queue/pending.json","queue/completed.json","queue/in-progress.json","queue/current-task.json","CONTINUITY.md"]});var U6={};h(U6,{runRollback:()=>h8});async function h8($){let Q=$[0],Z=$.slice(1);if(Q===void 0||Q==="help"||Q==="--help"||Q==="-h")return process.stdout.write(J6),Q===void 0?1:0;switch(Q){case"list":{let z=[...A1()].reverse();if(z.length===0)return process.stdout.write(`${_}No checkpoints found.${V}
`),0;process.stdout.write(`${x}Checkpoints${V} (${z.length}, newest first):
`);for(let X of z)process.stdout.write(`  ${I}${X.id}${V}  iter=${X.iteration}  ${X.git_branch||"(no branch)"}@${(X.git_sha||"").slice(0,7)}  ${X.timestamp}
`);return 0}case"show":{let z=Z[0];if(!z)return process.stderr.write(`${T}Missing checkpoint id.${V} Use \`loki rollback list\`.
`),2;try{let X=_1(z);return process.stdout.write(`${JSON.stringify(X,null,2)}
`),0}catch(X){return process.stderr.write(`${T}Failed to read checkpoint:${V} ${X.message}
`),1}}case"to":{let z=Z[0];if(!z)return process.stderr.write(`${T}Missing checkpoint id.${V} Use \`loki rollback list\`.
`),2;return await W6(z,Z.includes("--force"))}case"latest":{let z=A1(),X=z[z.length-1];if(!X)return process.stderr.write(`${T}No checkpoints found to roll back to.${V}
`),1;return process.stdout.write(`Rolling back to latest checkpoint: ${I}${X.id}${V}
`),await W6(X.id,Z.includes("--force"))}default:return process.stderr.write(`Unknown subcommand: ${Q}
`),process.stderr.write(J6),2}}async function W6($,Q=!1){let Z;try{Z=K6($)}catch(X){return process.stderr.write(`${T}Cannot plan rollback:${V} ${X.message}
`),1}if(Z.restore.length===0)return process.stdout.write(`${_}Checkpoint ${$} has no restorable state files; nothing to do.${V}
`),0;let z;try{z=await q6(Z,void 0,Q)}catch(X){return process.stderr.write(`${T}Rollback aborted:${V} ${X.message}
`),1}if(z.errors.length>0){for(let X of z.errors)process.stderr.write(`${T}restore error:${V} ${X}
`);return process.stderr.write(`${T}Partial rollback: ${z.restored}/${Z.restore.length} files restored.${V}
`),1}if(process.stdout.write(`${S}Rolled back ${z.restored}/${Z.restore.length} state files from ${$}.${V}
`),z.preRollbackSnapshotId)process.stdout.write(`Saved your prior state as ${I}${z.preRollbackSnapshotId}${V}; undo this rollback with \`loki rollback to ${z.preRollbackSnapshotId}\`.
`);return process.stdout.write("Run `loki start` to resume from the restored state.\n"),0}var J6=`Usage: loki rollback <subcommand>

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
`;var H6=P(()=>{V6();c()});function y8(){return process.env.LOKI_TIER||"oss"}function G6($){let Q=y8();if(Q==="oss")return{allowed:!0,notes:[]};if(!process.env.LOKI_LICENSE_KEY)return{allowed:!1,notes:[`${_}LOKI_TIER='${Q}' requested but no LOKI_LICENSE_KEY set.${V}`,`Hosted/enterprise license verification is not available yet (capability: ${$}).`,"OSS users: leave LOKI_TIER unset (or 'oss') -- everything stays free."]};return{allowed:!0,notes:[`${_}LOKI_LICENSE_KEY set but the verification backend is not available yet (R9 seam).${V}`]}}var B6=P(()=>{c()});var M6={};h(M6,{runProof:()=>t8});import{existsSync as _$,readdirSync as v8,readFileSync as Y6,mkdtempSync as m8,copyFileSync as g8,rmSync as f8}from"fs";import{join as e}from"path";import{tmpdir as u8}from"os";import{createInterface as c8}from"readline";import{readFile as p8}from"fs/promises";function $$($){return $&&typeof $==="object"?$:{}}function p($){return $===void 0||$===null?"-":String($)}function I$(){return e(j(),"proofs")}function I1($){let Q=e(I$(),$,"proof.json");if(!_$(Q))return null;try{return JSON.parse(Y6(Q,"utf8"))}catch{return{}}}function i($,Q){return $.length>=Q?$:$+" ".repeat(Q-$.length)}function d8(){let $=I$();if(!_$($))return process.stdout.write(`${_}No proofs found.${V} Run 'loki start' to generate one.
`),0;let Q=[];try{Q=v8($,{withFileTypes:!0}).filter((z)=>z.isDirectory()).map((z)=>z.name).sort()}catch{Q=[]}let Z=[];for(let z of Q){let X=e($,z,"proof.json");if(!_$(X))continue;let q={};try{q=JSON.parse(Y6(X,"utf8"))}catch{q={}}let K=p(q.run_id),W=p(q.generated_at),J=p($$(q.council).final_verdict),U=p($$(q.cost).usd),H=p($$(q.files_changed).count);Z.push(`${i(K,26)}  ${i(W,20)}  ${i(J,10)}  ${i(U,9)}  ${H}`)}if(Z.length===0)return process.stdout.write(`${_}No proofs found.${V} Run 'loki start' to generate one.
`),0;process.stdout.write(`${i("RUN_ID",26)}  ${i("GENERATED_AT",20)}  ${i("VERDICT",10)}  ${i("COST_USD",9)}  FILES
`);for(let z of Z)process.stdout.write(`${z}
`);return 0}function o8($){if(!$)return process.stderr.write(`${T}Missing proof id.${V} Use 'loki proof list'.
`),2;let Q=I1($);if(Q===null)return process.stderr.write(`${T}Proof not found: ${$}${V}
`),process.stderr.write(`Use 'loki proof list' to see available proofs.
`),1;return process.stdout.write(`${JSON.stringify(Q,null,2)}
`),0}async function n8($){if(!$)return process.stderr.write(`${T}Missing proof id.${V} Use 'loki proof list'.
`),2;let Q=e(I$(),$,"index.html");if(!_$(Q))return process.stderr.write(`${T}Proof page not found: ${$}/index.html${V}
`),process.stderr.write(`Use 'loki proof list' to see available proofs.
`),1;process.stdout.write(`${S}Opening proof: ${Q}${V}
`);for(let Z of["open","xdg-open","start"])try{if((await k([Z,Q],{timeoutMs:5000})).exitCode===0)return 0}catch{}return process.stdout.write(`
Could not detect browser opener.
`),process.stdout.write(`Please open in browser: ${Q}
`),0}function a8($){return new Promise((Q)=>{let Z=c8({input:process.stdin,output:process.stdout});Z.question($,(z)=>{Z.close();let X=z.trim().toLowerCase();Q(X==="y"||X==="yes")})})}async function s8($,Q,Z){let z=G6("hosted_publish");for(let G of z.notes)process.stderr.write(`${G}
`);let X=process.env.LOKI_HOSTED_ENDPOINT||"";if(!X)return process.stderr.write(`${_}Hosted publishing backend not available.${V}
`),process.stderr.write(`There is no official Loki hosted service yet (R9 ships the seam, not a live backend).
`),process.stderr.write(`To publish to your own hosted endpoint, set LOKI_HOSTED_ENDPOINT to its URL.
`),process.stderr.write(`Or publish to a GitHub Gist instead: loki proof share ${$}
`),1;let q=I1($);if(q){if($$(q.redaction).applied!==!0)return process.stderr.write(`${T}Refusing to publish: proof redaction was not confirmed applied.${V}
`),process.stderr.write(`Regenerate the proof (LOKI_PROOF=1) so the redactor runs, then retry.
`),1}process.stdout.write(`${x}Publishing proof '${$}' to hosted endpoint${V}
`),process.stdout.write(`  endpoint: ${X}
`),process.stdout.write(`  payload:  ${Q} (already redacted by the generator)

`);let K;try{K=await p8(Q)}catch{return process.stderr.write(`${T}Could not read proof page: ${Q}${V}
`),1}let W={"Content-Type":"text/html","X-Loki-Proof-Id":$},J=process.env.LOKI_LICENSE_KEY||"";if(J)W.Authorization=`Bearer ${J}`;let U;try{U=await fetch(X,{method:"POST",headers:W,body:new Uint8Array(K)})}catch(G){return process.stderr.write(`${T}Failed to reach hosted endpoint: ${String(G.message||G)}${V}
`),process.stderr.write(`Check LOKI_HOSTED_ENDPOINT or publish to a gist: loki proof share ${$}
`),1}let H=await U.text();if(!U.ok){if(process.stderr.write(`${T}Hosted endpoint returned HTTP ${U.status}.${V}
`),H)process.stderr.write(`Response:
`),process.stderr.write(`${H.slice(0,500)}
`);return process.stderr.write(`Nothing was published. Or publish to a gist: loki proof share ${$}
`),1}let Y="";try{let G=JSON.parse(H);if(G&&typeof G==="object"){let B=G.url??G.public_url;if(typeof B==="string")Y=B}}catch{}if(Y)process.stdout.write(`${S}Published: ${Y}${V}
`);else process.stdout.write(`${S}Published to ${X} (HTTP ${U.status}).${V}
`),process.stdout.write(`The endpoint did not return a 'url' field; check your endpoint's response.
`);return 0}async function r8($){let Q="",Z=!1,z="--public",X=!1;for(let M of $)if(M==="--yes"||M==="-y")Z=!0;else if(M==="--private")z="";else if(M==="--public")z="--public";else if(M==="--hosted")X=!0;else if(M.startsWith("-"))return process.stderr.write(`${T}Unknown option: ${M}${V}
`),1;else Q=M;if(!Q)return process.stderr.write(`${T}Missing proof id.${V} Use 'loki proof list'.
`),2;let q=e(I$(),Q,"index.html");if(!_$(q))return process.stderr.write(`${T}Proof page not found: ${Q}/index.html${V}
`),process.stderr.write(`Use 'loki proof list' to see available proofs.
`),1;if(X)return s8(Q,q,e(I$(),Q,"proof.json"));if((await k(["gh","--version"],{timeoutMs:5000})).exitCode!==0)return process.stderr.write(`${T}gh CLI not found${V}
`),process.stderr.write(`Install the GitHub CLI to publish a proof:
`),process.stderr.write(`  brew install gh        # macOS
`),process.stderr.write(`  sudo apt install gh    # Ubuntu/Debian
`),process.stderr.write(`  https://cli.github.com # Other platforms
`),1;if((await k(["gh","auth","status"],{timeoutMs:1e4})).exitCode!==0)return process.stderr.write(`${T}GitHub CLI not authenticated${V}
`),process.stderr.write(`Run 'gh auth login' to authenticate, then try again.
`),1;let J=z===""?"secret":"public";process.stdout.write(`${x}Publishing proof '${Q}' as a ${J} GitHub Gist${V}

`),process.stdout.write(`What will be shared:
`),process.stdout.write(`  - ${q}
`);let U=I1(Q);if(U){let M=p($$(U.cost).usd),L=p($$(U.files_changed).count),F=p($$(U.council).final_verdict),C=$$(U.redaction);process.stdout.write(`  - cost.usd:        ${M}
`),process.stdout.write(`  - files_changed:   ${L}
`),process.stdout.write(`  - council verdict: ${F}
`),process.stdout.write(`  - redaction:       applied=${p(C.applied)} rules_version=${p(C.rules_version)} redactions_count=${p(C.redactions_count)}
`)}if(process.stdout.write(`
${_}Secrets, API keys, tokens, env values, and absolute paths have already been stripped by the generator.${V}

`),!Z){if(!await a8(`Publish this proof to a ${J} gist? [y/N] `))return process.stdout.write(`Aborted. Nothing was published.
`),0}let H=m8(e(u8(),"loki-proof-")),Y=e(H,"index.html");g8(q,Y),process.stdout.write(`Uploading proof page...
`);let G=`Loki Mode proof-of-run ${Q}`,B=["gh","gist","create",Y,"--desc",G];if(z!=="")B.push(z);let O=await k(B,{timeoutMs:60000});try{f8(H,{recursive:!0,force:!0})}catch{}if(O.exitCode!==0)return process.stderr.write(`${T}Failed to create gist${V}
`),process.stderr.write(`${O.stdout}${O.stderr}
`),1;return process.stdout.write(`${S}Shared: ${O.stdout.trim()}${V}
`),0}async function t8($){let Q=$[0],Z=$.slice(1);if(Q===void 0||Q==="help"||Q==="--help"||Q==="-h")return process.stdout.write(l8),Q===void 0?1:0;switch(Q){case"list":return d8();case"show":return o8(Z[0]);case"open":return n8(Z[0]);case"share":return r8(Z);default:return process.stderr.write(`${T}Unknown subcommand: ${Q}${V}
`),process.stderr.write(`Run 'loki proof --help' for usage.
`),1}}var l8;var T6=P(()=>{b();d();c();B6();l8=`${x}loki proof${V} - inspect and share proof-of-run artifacts

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
`});var L6={};h(L6,{runCrash:()=>q7});import{existsSync as w6,readdirSync as i8,readFileSync as e8}from"fs";import{join as A6}from"path";function L$($){return $===void 0||$===null?"-":String($)}function f$($,Q){return $.length>=Q?$:$+" ".repeat(Q-$.length)}function _6(){return A6(j(),"crash")}function L1(){let $=_6();if(!w6($))return[];try{return i8($,{withFileTypes:!0}).filter((Q)=>Q.isFile()&&Q.name.endsWith(".json")).map((Q)=>Q.name.slice(0,-5)).sort()}catch{return[]}}function Q7($){if($.length===0)return!1;if($.includes("/")||$.includes("\\"))return!1;if($.includes(".."))return!1;return!0}function u$($){if(!Q7($))return null;let Q=A6(_6(),`${$}.json`);if(!w6(Q))return null;try{return JSON.parse(e8(Q,"utf8"))}catch{return{}}}function Z7(){let $=L1();if($.length===0)return process.stdout.write(`${_}No crash reports found.${V} Nothing has been captured in .loki/crash/.
`),0;process.stdout.write(`${f$("ID",40)}  ${f$("CAPTURED_AT",22)}  ERROR_CLASS
`);for(let Q of $){let Z=u$(Q)??{},z=L$(Z.fingerprint),X=L$(Z.captured_at),q=L$(Z.error_class),K=z!=="-"?z:Q;process.stdout.write(`${f$(K,40)}  ${f$(X,22)}  ${q}
`)}return process.stdout.write(`
${$.length} report(s). Run 'loki crash show <id>' to inspect, 'loki crash submit' to get a prefilled GitHub issue URL.
`),0}function I6($){let Q=u$($);if(Q!==null)return{id:$,report:Q};for(let Z of L1()){let z=u$(Z);if(z&&String(z.fingerprint??"")===$)return{id:Z,report:z}}return null}function z7($){if(!$)return process.stderr.write(`${T}Missing crash id.${V} Use 'loki crash' to list reports.
`),2;let Q=I6($);if(Q===null)return process.stderr.write(`${T}Crash report not found: ${$}${V}
`),process.stderr.write(`Use 'loki crash' to see available reports.
`),1;return process.stdout.write(`${JSON.stringify(Q.report,null,2)}
`),0}function X7($){let Q=L$($.error_class),Z=L$($.fingerprint),z=Z!=="-"?Z.slice(0,12):"unknown",X=`crash: ${Q} (${z})`,K=["Anonymous crash report captured by Loki Mode (scrubbed, whitelist-only).","","Scrubbed payload:","```json",JSON.stringify($,null,2),"```","","Nothing was sent automatically. This issue is submitted manually by me."].join(`
`),W=new URLSearchParams({title:X,body:K});return`${$7}?${W.toString()}`}function K7($){let Q;if($){if(Q=I6($),Q===null)return process.stderr.write(`${T}Crash report not found: ${$}${V}
`),process.stderr.write(`Use 'loki crash' to see available reports.
`),1}else{let Z=L1();if(Z.length===0)return process.stdout.write(`${_}No crash reports found.${V} Nothing to submit.
`),0;let z=Z[Z.length-1],X=u$(z)??{};Q={id:z,report:X}}return process.stdout.write(`${x}Scrubbed payload (this is the ENTIRE report):${V}
`),process.stdout.write(`${JSON.stringify(Q.report,null,2)}

`),process.stdout.write(`${_}Nothing is sent automatically in this version.${V} Loki Mode never transmits crash data on its own.
`),process.stdout.write(`To submit manually, open this prefilled GitHub issue and review it first:

`),process.stdout.write(`  ${I}${X7(Q.report)}${V}

`),process.stdout.write(`${S}The payload above is exactly what the URL contains.${V}
`),process.stdout.write(`See docs/PRIVACY.md for what is and is not collected.
`),0}async function q7($){let Q=$[0];switch(Q){case void 0:case"list":return Z7();case"--help":case"-h":case"help":return process.stdout.write(O6),0;case"show":return z7($[1]);case"submit":return K7($[1]);default:return process.stderr.write(`${T}Unknown crash subcommand: ${Q}${V}
`),process.stdout.write(O6),2}}var $7="https://github.com/asklokesh/loki-mode/issues/new",O6;var P6=P(()=>{b();c();O6=`${x}loki crash${V} - inspect and manually submit local crash reports

Usage: loki crash [subcommand] [args]

Subcommands:
  (none) | list        List crash reports in .loki/crash/
  show <id>            Pretty-print one scrubbed crash report
  submit [<id>]        Print the scrubbed payload and a prefilled GitHub
                       issue URL for manual submission

Crash reports are anonymous, scrubbed, and stored locally only. Nothing is
sent automatically in this version. See docs/PRIVACY.md.
`});var k6={};h(k6,{runWiki:()=>H7});import{existsSync as P1,readFileSync as j6}from"fs";import{join as j1,resolve as V7}from"path";function W7(){return j1(process.cwd(),".loki","wiki")}function U7($){let Q="";for(let X of $){if(X==="--help"||X==="-h")return process.stdout.write(`Usage: loki wiki show [section]
Sections: architecture, modules, data-flow
`),0;if(X.startsWith("-"))return process.stderr.write(`${T}Unknown option: ${X}${V}
`),1;Q=X}let Z=W7();if(!P1(Z))return process.stderr.write(`${_}No wiki found. Run 'loki wiki generate' first.${V}
`),1;if(Q){if(!J7.has(Q))return process.stderr.write(`${T}No such section: ${Q} (try: architecture, modules, data-flow)${V}
`),1;let X=j1(Z,`${Q}.md`);if(!P1(X))return process.stderr.write(`${T}Section not generated: ${Q}${V}
`),1;return process.stdout.write(j6(X,"utf8")),0}let z=j1(Z,"index.md");if(!P1(z))return process.stderr.write(`${T}Wiki index not found. Run 'loki wiki generate'.${V}
`),1;return process.stdout.write(j6(z,"utf8")),0}async function R6($,Q){let Z=V7(g,"autonomy","loki"),z=3600000,X=Bun.spawn({cmd:[Z,"wiki",$,...Q],stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,LOKI_LEGACY_BASH:"1"}}),q=setTimeout(()=>{try{X.kill("SIGKILL")}catch{}},3600000);try{return await X.exited}finally{clearTimeout(q)}}async function H7($){let Q=$[0],Z=$.slice(1);switch(Q){case void 0:case"help":case"--help":case"-h":return process.stdout.write(F6),0;case"show":return U7(Z);case"generate":return R6("generate",Z);case"ask":return R6("ask",Z);default:return process.stderr.write(`${T}Unknown wiki command: ${Q}${V}
`),process.stdout.write(F6),1}}var F6,J7;var x6=P(()=>{b();c();F6=`${x}loki wiki${V} - Auto-generated, cited codebase wiki + Q&A

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
`,J7=new Set(["architecture","modules","data-flow"])});var R1={};h(R1,{renderFindingsForPrompt:()=>T7,loadPreviousFindings:()=>F1,findLatestReviewDir:()=>C6,_parseReviewerOutputForTests:()=>O7});import{existsSync as N6,readFileSync as E6,readdirSync as S6,statSync as G7}from"fs";import{join as c$}from"path";function M7($){let Q=$.toLowerCase();if(Q==="critical")return"Critical";if(Q==="high")return"High";if(Q==="medium")return"Medium";return"Low"}function D6($,Q,Z,z){let X=[],q=$.split(/\r?\n/);for(let K of q){let W=K.trim();if(W.length===0)continue;let J=W.replace(/^[-*]\s*/,""),U=B7.exec(J);if(!U||!U[1]||!U[2])continue;let H=M7(U[1]),Y=U[2].trim(),G=Y7.exec(Y),B=G&&G[1]?G[1]:null,O=G&&G[2]?Number.parseInt(G[2],10):null;X.push({reviewId:Z,iteration:z,reviewer:Q,severity:H,description:Y,file:B,line:Number.isFinite(O)?O:null,raw:W})}return X}function C6($,Q){let Z=c$($,"quality","reviews");if(!N6(Z))return null;let z;try{z=S6(Z)}catch{return null}let X=Q===void 0?z.filter((W)=>W.startsWith("review-")):z.filter((W)=>W.endsWith(`-${Q}`)&&W.startsWith("review-"));if(X.length===0)return null;X.sort();let q=X[X.length-1];if(!q)return null;let K=c$(Z,q);try{if(!G7(K).isDirectory())return null}catch{return null}return K}function F1($,Q){let Z=C6($,Q);if(Z===null)return{reviewDir:null,reviewId:null,iteration:null,findings:[]};let z=null,X=null,q=c$(Z,"aggregate.json");if(N6(q))try{let U=E6(q,"utf-8"),H=JSON.parse(U);if(typeof H.review_id==="string")z=H.review_id;if(typeof H.iteration==="number")X=H.iteration}catch{}let K;try{K=S6(Z)}catch{return{reviewDir:Z,reviewId:z,iteration:X,findings:[]}}let W=new Set(["diff.txt","files.txt","anti-sycophancy.txt"]),J=[];for(let U of K){if(!U.endsWith(".txt"))continue;if(W.has(U))continue;if(U.endsWith("-prompt.txt"))continue;let H=U.replace(/\.txt$/,""),Y;try{Y=E6(c$(Z,U),"utf-8")}catch{continue}J.push(...D6(Y,H,z??"",X??-1))}return{reviewDir:Z,reviewId:z,iteration:X,findings:J}}function T7($){if($.length===0)return"";let Q=["Critical","High","Medium","Low"],Z=new Map;for(let X of Q)Z.set(X,[]);for(let X of $){let q=Z.get(X.severity);if(q)q.push(X)}let z=[];z.push("PREVIOUS REVIEWER FINDINGS (must address each, or supply counter-evidence in .loki/state/counter-evidence-<iter>.json):");for(let X of Q){let q=Z.get(X)??[];if(q.length===0)continue;z.push(`  [${X}] (${q.length}):`);for(let K of q){let W=K.file?` (${K.file}${K.line!==null?":"+K.line:""})`:"";z.push(`    - ${K.description}${W} -- via ${K.reviewer}`)}}return z.join(`
`)}function O7($,Q,Z="review-test",z=0){return D6($,Q,Z,z)}var B7,Y7;var p$=P(()=>{B7=/\[(Critical|High|Medium|Low)\]\s*(.+)/i,Y7=/([\w.\-/]+\.[a-zA-Z]+):(\d+)/});import{existsSync as w7}from"fs";import{join as A7}from"path";async function b6($,Q){let Z=A7($,"memory");if(!w7(Z))return{stored:!1,reason:"memory dir not initialized"};let z=Math.max(0,Math.floor(Q.durationSeconds??0)),X={_LOKI_PROJECT_DIR:g,_LOKI_TARGET_DIR:process.cwd(),_LOKI_TASK_ID:Q.taskId,_LOKI_OUTCOME:Q.outcome,_LOKI_PHASE:Q.phase,_LOKI_GOAL:Q.goal,_LOKI_DURATION:String(z),_LOKI_LOKI_DIR:$},K=await z$(`
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
`,{env:X,timeoutMs:15000});if(K.exitCode===127)return{stored:!1,reason:"python3 not found"};let W=K.stdout.trim();if(W==="OK")return{stored:!0,reason:"stored"};if(W.startsWith("ERR:"))return{stored:!1,reason:W.replace(/^ERR:/,"")};return{stored:!1,reason:K.stderr.trim()||"unknown"}}var h6=P(()=>{V$();b()});var g6={};h(g6,{loadLearnings:()=>k1,appendLearning:()=>P$,appendFromGateFailure:()=>k7});import{existsSync as _7,readFileSync as I7}from"fs";import{join as y6}from"path";import{createHash as L7}from"crypto";function v6($){return y6($,P7)}function j7($){if($===null||typeof $!=="object")return!1;let Q=$;return typeof Q.id==="string"&&typeof Q.timestamp==="string"&&typeof Q.iteration==="number"&&typeof Q.trigger==="string"&&typeof Q.rootCause==="string"&&typeof Q.fix==="string"&&typeof Q.preventInFuture==="string"&&typeof Q.evidence==="object"&&Q.evidence!==null}function m6($){if(!_7($))return{version:1,learnings:[]};try{let Q=I7($,"utf-8"),Z=JSON.parse(Q);if(Z.version===1&&Array.isArray(Z.learnings))return{version:1,learnings:Z.learnings.filter(j7)}}catch{}return{version:1,learnings:[]}}function F7($,Q,Z){return L7("sha256").update(`${$} ${Q} ${Z??""}`).digest("hex").slice(0,16)}async function P$($,Q,Z={}){let z=F7(Q.trigger,Q.rootCause,Q.evidence.file),X=new Date().toISOString(),q={id:z,timestamp:X,...Q},K=v6($);if(await d0(K,()=>{A$(K,()=>{let J=m6(K),U=J.learnings.findIndex((H)=>H.id===z);if(U>=0){let H=J.learnings[U];J.learnings[U]={...H,timestamp:X,iteration:q.iteration}}else J.learnings.push(q);w$(K,J)})}),Z.episodeBridge!==null&&(Z.episodeBridge!==void 0||process.env.LOKI_AUTO_LEARNINGS_EPISODE==="1")){let J=Z.episodeBridge??b6,U=Z.bridgeFailureLog??R7;try{let H=await J($,{taskId:`learning-${z}`,outcome:"failure",phase:"VERIFY",goal:`${Q.trigger}: ${Q.rootCause}`});if(H&&!H.stored){if(!new Set(["memory dir not initialized","stub"]).has(H.reason))U(`episode_bridge skipped: ${H.reason}`)}}catch(H){U(`episode_bridge threw: ${H.message}`)}}return q}function R7($){process.stderr.write(`[learnings_writer] ${$}
`)}async function k7($,Q,Z,z={}){let X=`[${Z.severity}] ${Z.description}`;return P$($,{iteration:Q,trigger:"gate_failure",rootCause:X,fix:"pending: dev agent must address in next iteration or supply counter-evidence",preventInFuture:"if this finding recurs, lower its severity threshold or add a regression test",evidence:{reviewId:Z.reviewId,file:Z.file??void 0,line:Z.line??void 0,severity:Z.severity,reviewer:Z.reviewer}},z)}function k1($){return m6(v6($))}var P7;var l$=P(()=>{m$();h6();P7=y6("state","relevant-learnings.json")});var u6={};h(u6,{runOverrideCouncil:()=>C7,recordOverrideOutcome:()=>b7,loadCounterEvidence:()=>D7,canonicalFindingId:()=>d$,DEFAULT_OVERRIDE_JUDGES:()=>f6});import{existsSync as x7,readFileSync as E7}from"fs";import{join as N7}from"path";function D7($,Q){let Z=N7($,"state",`counter-evidence-${Q}.json`);if(!x7(Z))return null;try{let z=E7(Z,"utf-8"),X=JSON.parse(z);if(typeof X.iteration!=="number")return null;let q=Array.isArray(X.evidence)?X.evidence:[],K=[];for(let W of q){if(typeof W!=="object"||W===null)continue;let J=W;if(typeof J.findingId!=="string")continue;if(typeof J.claim!=="string")continue;let U=J.proofType;if(typeof U!=="string"||!S7.has(U))continue;let H=U,Y=Array.isArray(J.artifacts)?J.artifacts:[];K.push({findingId:J.findingId,claim:J.claim,proofType:H,artifacts:Y.filter((G)=>typeof G==="string")})}return{iteration:X.iteration,evidence:K}}catch{return null}}async function C7($,Q,Z,z={}){let X=z.judges??f6,q=new Set,K=new Set,W={},J=new Map;for(let H of Q.evidence)J.set(H.findingId,H);let U=new Map;for(let H of $){let Y=d$(H);U.set(Y,(U.get(Y)??0)+1)}for(let H of $){let Y=d$(H);if((U.get(Y)??0)>1){K.add(Y);continue}let G=J.get(Y);if(!G){K.add(Y);continue}let B=await Promise.all(X.map((M)=>Z({finding:H,evidence:G,judge:M})));if(W[Y]=B,B.filter((M)=>M.verdict==="APPROVE_OVERRIDE").length>=2)q.add(Y);else K.add(Y)}return{approvedFindingIds:q,rejectedFindingIds:K,votes:W}}function d$($){let Q=$.raw.slice(0,80).replace(/\s+/g," ").trim();return`${$.reviewer}::${Q}`}async function b7($,Q,Z,z,X={}){let q={episodeBridge:X.episodeBridge===void 0?null:X.episodeBridge};for(let K of z){let W=d$(K);if(Z.approvedFindingIds.has(W))await P$($,{iteration:Q,trigger:"override_approved",rootCause:`[${K.severity}] ${K.description}`,fix:"override council approved counter-evidence; finding lifted",preventInFuture:"if this reviewer/file pair recurs, narrow the reviewer's selector OR add a baseline doc",evidence:{findingId:W,reviewId:K.reviewId,file:K.file??void 0,line:K.line??void 0,severity:K.severity,reviewer:K.reviewer}},q);else if(Z.rejectedFindingIds.has(W))await P$($,{iteration:Q,trigger:"override_rejected",rootCause:`[${K.severity}] ${K.description}`,fix:"override council rejected -- dev agent must fix the finding",preventInFuture:"address this finding in the next iteration",evidence:{findingId:W,reviewId:K.reviewId,file:K.file??void 0,line:K.line??void 0,severity:K.severity,reviewer:K.reviewer}},q)}}var S7,f6;var c6=P(()=>{l$();S7=new Set(["file-exists","test-passes","grep-miss","reviewer-misread","duplicate-code-path","out-of-scope"]);f6=["judge-primary","judge-secondary","judge-tertiary"]});var d6={};h(d6,{writeEscalationHandoff:()=>o7,renderHandoff:()=>p6,readLatestHandoff:()=>n7});import{existsSync as h7,mkdirSync as y7,readdirSync as v7,readFileSync as m7,renameSync as g7,writeFileSync as f7}from"fs";import{dirname as u7,join as o$}from"path";function c7(){return new Date().toISOString()}function p7($){let Q=$.file?` (${$.file}${$.line!==null?":"+$.line:""})`:"";return`  - [${$.severity}] ${$.description}${Q} -- ${$.reviewer}`}function l7($){let Q=$.evidence,Z=Q.file?` ${Q.file}${Q.line!==void 0?":"+Q.line:""}`:"";return`  - **${$.trigger}** (iter ${$.iteration})${Z}: ${$.rootCause}`}function p6($,Q,Z){let z=[];if(z.push(`# Loki escalation handoff -- ${c7()}`),z.push(""),z.push(`Gate **${$.gateName}** has failed ${$.consecutiveFailures} consecutive times at iteration ${$.iteration}.`),z.push(""),z.push(`Reason: ${$.detail}`),z.push(""),Q.length>0){z.push(`## Outstanding findings (${Q.length})`),z.push("");for(let X of Q)z.push(p7(X));z.push("")}else z.push("## Outstanding findings"),z.push(""),z.push("(no per-finding records captured -- gate failed without populating reviewer outputs)"),z.push("");if(Z.length>0){z.push(`## Recent learnings (${Math.min(Z.length,10)})`),z.push("");for(let X of Z.slice(-10))z.push(l7(X));z.push("")}return z.push("## What the human must decide"),z.push(""),z.push("- Approve override? Write `.loki/state/counter-evidence-<iter>.json` with one entry per finding to dispute, then `rm .loki/PAUSE` to resume."),z.push("- Disable a gate? Set `LOKI_GATE_<NAME>=false` in env (see skills/quality-gates.md)."),z.push("- Tweak escalation? Set `LOKI_GATE_PAUSE_LIMIT` or `LOKI_GATE_ESCALATE_LIMIT`."),z.push("- Roll back? Switch to `LOKI_LEGACY_BASH=1` and re-run; the bash route does not consult this handoff doc."),z.push(""),z.push("To resume: address the findings (or supply counter-evidence) and `rm .loki/PAUSE`."),z.join(`
`)}function d7($,Q){y7(u7($),{recursive:!0});let Z=`${$}.tmp.${process.pid}.${++l6}`;f7(Z,Q),g7(Z,$)}function o7($,Q,Z={}){let z=Z.findings??F1($,Q.iteration).findings,X=Z.learnings??k1($).learnings,q=p6(Q,z,X),K=(Z.now?.()??new Date).toISOString().replace(/[-:.]/g,""),W=o$($,"escalations"),J=++l6,U=o$(W,`handoff-${K}-${process.pid}-${J}-${Q.gateName}.md`);return d7(U,q),{path:U,bytes:q.length}}function n7($){let Q=o$($,"escalations");if(!h7(Q))return null;let Z;try{Z=v7(Q).filter((q)=>q.endsWith(".md"))}catch{return null}if(Z.length===0)return null;Z.sort();let z=Z[Z.length-1];if(!z)return null;let X=o$(Q,z);try{return{path:X,body:m7(X,"utf-8")}}catch{return null}}var l6=0;var o6=P(()=>{p$();l$()});var a6={};h(a6,{runInternalPhase1Hooks:()=>e7,_resolveForTests:()=>i7,_internalPhase1HooksHelp:()=>zZ,__testAppendHook:()=>n6});import{existsSync as a7,mkdirSync as s7,readdirSync as r7,statSync as t7}from"fs";import{join as j$,resolve as i7}from"path";async function e7($){let[Q,...Z]=$;switch(Q){case void 0:case"help":case"--help":case"-h":return process.stdout.write(x1),Q===void 0?1:0;case"reflect":return $Z(Z);case"override":return QZ(Z);case"handoff":return ZZ(Z);default:return process.stderr.write(`Unknown subcommand: ${Q}
`),process.stderr.write(x1),2}}async function $Z($){let Q=E1($[0]);if(Q===null)return process.stderr.write(`reflect: missing or invalid <iter>
`),2;let Z=j();try{let X=(await Promise.resolve().then(() => (p$(),R1))).loadPreviousFindings(Z,Q);if(X.findings.length===0)return process.stdout.write(`reflect: no findings for iter ${Q} (nothing to do)
`),0;let q=j$(Z,"state");s7(q,{recursive:!0}),w$(j$(q,`findings-${Q}.json`),{review_id:X.reviewId,iteration:Q,findings:X.findings});let K=await Promise.resolve().then(() => (l$(),g6)),W=0,J=0;if(process.env.LOKI_AUTO_LEARNINGS!=="0"){let H=X.findings.filter((G)=>G.severity==="Critical"||G.severity==="High"),Y=n6.fn??K.appendFromGateFailure;for(let G of H)try{await Y(Z,Q,G,{episodeBridge:null}),W+=1}catch(B){J+=1,process.stderr.write(`reflect: learning append failed for finding ${G.reviewer}/${G.severity}: ${B.message}
`)}if(J>0&&W===0)return process.stderr.write(`reflect: all ${J} learning appends failed (iter ${Q})
`),1}let U=J>0?` (${J} failed)`:"";return process.stdout.write(`reflect: persisted ${X.findings.length} findings + ${W} learnings${U} (iter ${Q})
`),0}catch(z){return process.stderr.write(`reflect: ${z.message}
`),1}}async function QZ($){let Q=E1($[0]);if(Q===null)return process.stderr.write(`override: missing or invalid <iter>
`),2;let Z=j();try{let z=await Promise.resolve().then(() => (c6(),u6)),X=z.loadCounterEvidence(Z,Q);if(X===null||X.evidence.length===0)return process.stdout.write(`override: no counter-evidence for iter ${Q} (skip)
`),0;let K=(await Promise.resolve().then(() => (p$(),R1))).loadPreviousFindings(Z,Q),W=K.findings.filter((M)=>M.severity==="Critical"||M.severity==="High");if(W.length===0)return process.stdout.write(`override: no blocking findings for iter ${Q} (skip)
`),0;let J=new Set(["duplicate-code-path","file-exists","test-passes","grep-miss","out-of-scope"]),U=async(M)=>{let L=M.evidence.artifacts.some((C)=>C.trim().length>0),F=J.has(M.evidence.proofType)&&L;return{judge:M.judge,verdict:F?"APPROVE_OVERRIDE":"REJECT_OVERRIDE",reasoning:F?`[stub] proofType=${M.evidence.proofType} trusted with artifact`:!L&&J.has(M.evidence.proofType)?`[stub] proofType=${M.evidence.proofType} trusted but no artifact supplied`:`[stub] proofType=${M.evidence.proofType} requires manual review`}},H=await z.runOverrideCouncil(W,X,U);await z.recordOverrideOutcome(Z,Q,H,W);let Y=j$(Z,"quality","reviews");if(a7(Y))try{let M=r7(Y).filter((F)=>F.startsWith("review-")).sort(),L=M[M.length-1];if(L&&t7(j$(Y,L)).isDirectory())w$(j$(Y,L,`override-${Q}.json`),{review_id:K.reviewId,iteration:Q,approved_finding_ids:Array.from(H.approvedFindingIds),rejected_finding_ids:Array.from(H.rejectedFindingIds),votes:H.votes})}catch{}let G=H.approvedFindingIds.size,B=H.rejectedFindingIds.size;if(B===0&&G>0)process.stdout.write(`override: LIFTED -- ${G} approved, ${B} rejected
`);else process.stdout.write(`override: BLOCKED -- ${G} approved, ${B} rejected
`);return 0}catch(z){return process.stderr.write(`override: ${z.message}
`),1}}async function ZZ($){let Q=$[0],Z=Number.parseInt($[1]??"0",10),z=E1($[2]);if(!Q||!Number.isFinite(Z)||z===null)return process.stderr.write(`handoff: usage: handoff <gate> <consecutive-failures> <iter>
`),2;let X=j();try{let K=(await Promise.resolve().then(() => (o6(),d6))).writeEscalationHandoff(X,{gateName:Q,iteration:z,consecutiveFailures:Z,detail:`${Q} hit PAUSE_LIMIT (${Z} consecutive failures)`});return process.stdout.write(`handoff: wrote ${K.path} (${K.bytes}B)
`),0}catch(q){return process.stderr.write(`handoff: ${q.message}
`),1}}function E1($){if($===void 0)return null;let Q=Number.parseInt($,10);return Number.isFinite(Q)&&Q>=0?Q:null}var n6,x1=`loki internal phase1-hooks <subcommand>

Subcommands:
  reflect <iter>                    Persist structured findings + auto-learnings.
  override <iter>                   Run override council if counter-evidence present.
  handoff <gate> <count> <iter>     Write structured handoff doc before PAUSE.

This command is invoked by autonomy/run.sh between iterations. Users
should not run it directly -- run \`loki start\` instead.
`,zZ;var s6=P(()=>{b();m$();n6={fn:null};zZ=x1});t$();function C1(){return process.stdout.write(`Loki Mode v${R$()}
`),0}d();c();b();import{readFileSync as HQ,existsSync as GQ}from"fs";import{resolve as BQ}from"path";var YQ=["claude","codex","cline","aider"];function h1(){let $=BQ(j(),"state","provider");if(!GQ($))return"";try{return HQ($,"utf-8").trim()}catch{return""}}function MQ($,Q){return $||Q||process.env.LOKI_PROVIDER||"claude"}function TQ($){let Q=h1(),Z=MQ($,Q);switch(process.stdout.write(`${x}Current Provider${V}
`),process.stdout.write(`
`),process.stdout.write(`${I}Provider:${V} ${Z}
`),Z){case"claude":process.stdout.write(`${S}Status:${V}   Full features (subagents, parallel, MCP)
`);break;case"cline":process.stdout.write(`${S}Status:${V}   Near-full mode (subagents, MCP, 12+ providers)
`);break;case"codex":case"aider":process.stdout.write(`${_}Status:${V}   Degraded mode (sequential only)
`);break;default:break}if(Q)process.stdout.write(`${y}(saved in .loki/state/provider)${V}
`);else process.stdout.write(`${y}(default - not explicitly set)${V}
`);return process.stdout.write(`
`),process.stdout.write(`Switch provider: ${I}loki provider set <name>${V}
`),process.stdout.write(`Available:       ${I}loki provider list${V}
`),0}async function OQ(){let Q=h1()||process.env.LOKI_PROVIDER||"claude";process.stdout.write(`${x}Available Providers${V}
`),process.stdout.write(`
`);let Z=await Promise.all(YQ.map(async(q)=>[q,await f(q)!==null])),z=new Map;for(let[q,K]of Z)z.set(q,K?`${S}installed${V}`:`${T}not installed${V}`);let X=[["claude","claude  - Claude Code (Anthropic)    "],["codex","codex   - Codex CLI (OpenAI)         "],["cline","cline   - Cline (multi-provider)     "],["aider","aider   - Aider (terminal pair prog) "]];for(let[q,K]of X){let W=Q===q?` ${I}(current)${V}`:"";process.stdout.write(`  ${K} ${z.get(q)}${W}
`)}return process.stdout.write(`
`),process.stdout.write(`Set provider: ${I}loki provider set <name>${V}
`),0}function wQ(){return process.stdout.write(`${x}Loki Mode Provider Management${V}
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
`),0}async function y1($){let Q=$[0]??"show",Z=$.slice(1);switch(Q){case"show":case"current":return TQ(Z[0]);case"list":return OQ();case"set":case"info":case"models":return AQ(["provider",Q,...Z]);default:return wQ()}}async function AQ($){let{run:Q}=await Promise.resolve().then(() => (d(),b1)),{resolve:Z}=await import("path"),{REPO_ROOT:z}=await Promise.resolve().then(() => (b(),D1)),X=Z(z,"autonomy","loki"),q=await Q([X,...$],{env:{LOKI_LEGACY_BASH:"1"},timeoutMs:3600000});return process.stdout.write(q.stdout),process.stderr.write(q.stderr),q.exitCode}c();b();V$();import{existsSync as v1,readFileSync as IQ}from"fs";import{resolve as J$}from"path";import{mkdir as LQ}from"fs/promises";var M$=J$(r$(),"learnings");function e$($){if(!v1($))return 0;try{let Q=IQ($,"utf-8"),Z=0;for(let z of Q.split(`
`))if(z.includes('"description"'))Z++;return Z}catch{return 0}}async function PQ(){await LQ(M$,{recursive:!0});let $=e$(J$(M$,"patterns.jsonl")),Q=e$(J$(M$,"mistakes.jsonl")),Z=e$(J$(M$,"successes.jsonl"));return process.stdout.write(`${x}Cross-Project Learnings${V}
`),process.stdout.write(`
`),process.stdout.write(`  Patterns:  ${S}${$}${V}
`),process.stdout.write(`  Mistakes:  ${_}${Q}${V}
`),process.stdout.write(`  Successes: ${I}${Z}${V}
`),process.stdout.write(`
`),process.stdout.write(`Location: ${M$}
`),process.stdout.write(`
`),process.stdout.write(`Use 'loki memory show <type>' to view entries
`),0}async function jQ($){if($){let z=`
try:
    from memory.layers import IndexLayer
    layer = IndexLayer('.loki/memory')
    layer.update([])
    print('Index rebuilt')
except ImportError:
    print('Error: memory.layers module not found')
except Exception as e:
    print(f'Error: {e}')
`.trim(),X=await z$(z,{cwd:g});return process.stdout.write(X.stdout),0}let Q=J$(j(),"memory","index.json");if(!v1(Q))return process.stdout.write(`No index found
`),0;let Z=await z$(`import json, sys; sys.stdout.write(json.dumps(json.load(open(${JSON.stringify(Q)})), indent=4) + "\\n")`);if(Z.exitCode!==0)return process.stdout.write(`No index found
`),0;return process.stdout.write(Z.stdout),0}async function m1($){switch($[0]??"list"){case"list":case"ls":return PQ();case"index":return jQ($[1]==="rebuild");default:{let Z=J$(g,"autonomy","loki"),z=3600000,X=Bun.spawn({cmd:[Z,"memory",...$],stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,LOKI_LEGACY_BASH:"1"}}),q=setTimeout(()=>{try{X.kill("SIGKILL")}catch{}},3600000);try{return await X.exited}finally{clearTimeout(q)}}}}b();V$();d();import{resolve as FQ,join as RQ}from"path";import{existsSync as $1,readFileSync as kQ}from"fs";import{homedir as xQ}from"os";import{spawnSync as c1}from"child_process";var p1=3000;function EQ(){let $=(process.env.LOKI_TELEMETRY??"").toLowerCase();if($==="off")return!1;if(process.env.LOKI_TELEMETRY_DISABLED==="true")return!1;if(process.env.DO_NOT_TRACK==="1")return!1;let Q=!1,Z=!1;try{let z=RQ(xQ(),".loki","config");if($1(z)){let X=kQ(z,"utf8");for(let q of X.split(`
`)){let K=q.replace(/\r$/,"");if(K==="TELEMETRY_DISABLED=true")Q=!0;if(K==="TELEMETRY_ENABLED=true")Z=!0}}}catch{}if(Q)return!1;if($==="on"||Z)return!0;return!1}var k$=!1;function NQ(){return FQ(g,"autonomy","lib","crash_capture.py")}function SQ($,Q){let Z=[$,"--error-class",Q.errorClass,"--message",Q.message];if(Q.stack!==void 0)Z.push("--stack",Q.stack);if(Q.rarvPhase!==void 0)Z.push("--rarv-phase",Q.rarvPhase);if(Q.exitCode!==void 0)Z.push("--exit-code",String(Q.exitCode));if(Q.frictionKind!==void 0)Z.push("--friction-kind",Q.frictionKind);return Z.push("--target-dir",Q.targetDir??process.cwd()),Z}function DQ(){if($1("/opt/homebrew/bin/python3.12"))return"/opt/homebrew/bin/python3.12";for(let Q of["python3.12","python3"])try{let Z=c1("sh",["-c",`command -v ${Q}`],{timeout:p1,encoding:"utf8"});if(Z.status===0){let z=(Z.stdout||"").trim();if(z)return z}}catch{}return null}function g1($){try{if(!EQ())return;let Q=NQ();if(!$1(Q))return;let Z=DQ();if(!Z)return;let z=SQ(Q,$);c1(Z,z,{timeout:p1,stdio:"ignore"})}catch{}}function f1($,Q){if($ instanceof Error){let z={errorClass:$.name&&$.name.length>0?$.name:Q,message:$.message};if($.stack)z.stack=$.stack;return z}return{errorClass:Q,message:String($)}}var u1=!1;function l1(){if(u1)return;u1=!0,process.on("uncaughtException",($)=>{if(!k$){k$=!0;let Q=f1($,"UncaughtException");g1({errorClass:Q.errorClass,message:Q.message,...Q.stack!==void 0?{stack:Q.stack}:{},exitCode:1})}try{process.stderr.write(`${$&&$.stack||String($)}
`)}catch{}process.exit(1)}),process.on("unhandledRejection",($)=>{if(!k$){k$=!0;let Q=f1($,"UnhandledRejection");g1({errorClass:Q.errorClass,message:Q.message,...Q.stack!==void 0?{stack:Q.stack}:{},exitCode:1})}try{let Q=$ instanceof Error?$.stack||$.message:String($);process.stderr.write(`Unhandled promise rejection: ${Q}
`)}catch{}process.exit(1)})}var r6=`Loki Mode (TypeScript port, Phase 2 of bash->Bun migration)

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
`)}async function KZ($){XZ();let Q=$[0],Z=$.slice(1);switch(Q){case void 0:case"help":case"--help":case"-h":return process.stdout.write(r6),0;case"version":case"--version":case"-v":return C1();case"provider":return y1(Z);case"memory":return m1(Z);case"status":{let{runStatus:z}=await Promise.resolve().then(() => ($0(),e1));return z(Z)}case"stats":{let{runStats:z}=await Promise.resolve().then(() => (V0(),q0));return z(Z)}case"doctor":{let{runDoctor:z}=await Promise.resolve().then(() => (O0(),T0));return z(Z)}case"kpis":{let{runKpis:z}=await Promise.resolve().then(() => (H1(),U1));return z(Z,{aliasOf:"kpis"})}case"report":{if(Z.find((q)=>!q.startsWith("-"))==="kpis"){let{runKpis:q}=await Promise.resolve().then(() => (H1(),U1)),K=!1,W=Z.filter((J)=>{if(!K&&J==="kpis")return K=!0,!1;return!0});return q(W)}let{delegateToBash:X}=await Promise.resolve().then(() => (N0(),E0));return X(["report",...Z])}case"trust":{let{runTrust:z}=await Promise.resolve().then(() => (g0(),m0));return z(Z)}case"rollback":{let{runRollback:z}=await Promise.resolve().then(() => (H6(),U6));return z(Z)}case"proof":{let{runProof:z}=await Promise.resolve().then(() => (T6(),M6));return z(Z)}case"crash":{let{runCrash:z}=await Promise.resolve().then(() => (P6(),L6));return z(Z)}case"wiki":{let{runWiki:z}=await Promise.resolve().then(() => (x6(),k6));return z(Z)}case"internal":{let z=Z[0];if(!z||z==="--help"||z==="-h"||z==="help"){let q=["loki internal -- runtime hooks driven by autonomy/run.sh","","Subcommands:","  phase1-hooks    Persist structured findings, run override council,","                  append learnings, and write the escalation handoff","                  doc once per iteration. Driven by run.sh; not","                  intended for direct invocation.","","Phase 1 (RARV-C closure) env vars:","  LOKI_INJECT_FINDINGS=1   Persist structured reviewer findings to","                           .loki/state/findings-<iter>.json so the","                           next iteration can address them.","  LOKI_OVERRIDE_COUNCIL=1  Allow a 3-LLM override panel to lift a","                           BLOCK when counter-evidence is presented.","                           See LOKI_OVERRIDE_JUDGES (csv),","                           LOKI_OVERRIDE_PANEL_SIZE,","                           LOKI_OVERRIDE_REAL_JUDGE.","  LOKI_AUTO_LEARNINGS=1    Append failure rootcauses to","                           .loki/state/relevant-learnings.json via","                           the episodic memory bridge.","  LOKI_HANDOFF_MD=1        Write a structured human handoff doc to","                           .loki/escalations/<ts>.md before PAUSE.","","All four are default-on as of v7.5.3. Set to 0 to disable.","Reference: CHANGELOG.md (search 'Phase 1') and skills/healing.md.","","These commands are wired into the autonomous loop and may change","without notice. Do not script against them.",""].join(`
`);return process.stdout.write(`${q}
`),0}if(z==="phase1-hooks"){let{runInternalPhase1Hooks:q}=await Promise.resolve().then(() => (s6(),a6));return q(Z.slice(1))}return process.stderr.write(`Unknown internal subcommand: ${z}
`),process.stderr.write(`Run 'loki internal --help' for the supported list.
`),2}default:return process.stderr.write(`Unknown command: ${Q}
`),process.stderr.write(r6),2}}l1();process.on("SIGINT",()=>process.exit(130));process.on("SIGTERM",()=>process.exit(143));var qZ=await KZ(Bun.argv.slice(2));process.exit(qZ);

//# debugId=BBA47536FE0B2AB264756E2164756E21
