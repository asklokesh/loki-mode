// @bun
var r6=Object.defineProperty;var t6=($)=>$;function i6($,Q){this[$]=t6.bind(null,Q)}var b=($,Q)=>{for(var Z in Q)r6($,Z,{get:Q[Z],enumerable:!0,configurable:!0,set:i6.bind(Q,Z)})};var P=($,Q)=>()=>($&&(Q=$($=0)),Q);var q$=import.meta.require;var D1={};b(D1,{lokiDir:()=>j,homeLokiDir:()=>a$,findRepoRootForVersion:()=>n$,REPO_ROOT:()=>g});import{resolve as a,dirname as o$}from"path";import{fileURLToPath as e6}from"url";import{existsSync as j$}from"fs";import{homedir as $Q}from"os";function QQ(){let $=S1;for(let Q=0;Q<6;Q++){if(j$(a($,"VERSION"))&&j$(a($,"autonomy/run.sh")))return $;let Z=o$($);if(Z===$)break;$=Z}return a(S1,"..","..","..")}function n$($){let Q=$;for(let Z=0;Z<6;Z++){if(j$(a(Q,"VERSION"))&&j$(a(Q,"autonomy/run.sh")))return Q;let z=o$(Q);if(z===Q)break;Q=z}return a($,"..","..","..")}function j(){return process.env.LOKI_DIR??a(process.cwd(),".loki")}function a$(){return a($Q(),".loki")}var S1,g;var C=P(()=>{S1=o$(e6(import.meta.url));g=QQ()});import{readFileSync as ZQ}from"fs";import{resolve as zQ,dirname as XQ}from"path";import{fileURLToPath as KQ}from"url";function F$(){if(Q$!==null)return Q$;let $="7.63.1";if(typeof $==="string"&&$.length>0)return Q$=$,Q$;try{let Q=XQ(KQ(import.meta.url)),Z=n$(Q);Q$=ZQ(zQ(Z,"VERSION"),"utf-8").trim()}catch{Q$="unknown"}return Q$}var Q$=null;var s$=P(()=>{C()});var b1={};b(b1,{runOrThrow:()=>qQ,run:()=>k,commandVersion:()=>JQ,commandExists:()=>f,ShellError:()=>r$});async function k($,Q={}){let Z=Bun.spawn({cmd:[...$],stdout:"pipe",stderr:"pipe",env:Q.env?{...process.env,...Q.env}:process.env,cwd:Q.cwd}),z,X;if(Q.timeoutMs&&Q.timeoutMs>0)z=setTimeout(()=>{try{Z.kill("SIGTERM")}catch{}X=setTimeout(()=>{try{Z.kill("SIGKILL")}catch{}},2000)},Q.timeoutMs);try{let[q,K,W]=await Promise.all([new Response(Z.stdout).text(),new Response(Z.stderr).text(),Z.exited]);return{stdout:q,stderr:K,exitCode:W}}finally{if(z)clearTimeout(z);if(X)clearTimeout(X)}}async function qQ($,Q={}){let Z=await k($,Q);if(Z.exitCode!==0)throw new r$(`command failed (${Z.exitCode}): ${$.join(" ")}`,Z.exitCode,Z.stdout,Z.stderr);return Z}async function f($){let Q=VQ($),Z=await k(["sh","-c",`command -v ${Q}`],{timeoutMs:5000});if(Z.exitCode===0)return Z.stdout.trim()||null;return null}function VQ($){if(!/^[A-Za-z0-9._/-]+$/.test($))throw Error(`refused to shell-escape suspect token: ${$}`);return $}async function JQ($,Q="--version"){if(!await f($))return null;let z=await k([$,Q],{timeoutMs:5000});if(z.exitCode!==0)return null;return((z.stdout||z.stderr).split(/\r?\n/)[0]?.trim()??"")||null}var r$;var d=P(()=>{r$=class r$ extends Error{message;exitCode;stdout;stderr;constructor($,Q,Z,z){super($);this.message=$;this.exitCode=Q;this.stdout=Z;this.stderr=z;this.name="ShellError"}}});function s($){return WQ?"":$}var WQ,T,S,_,wZ,I,R,h,V;var c=P(()=>{WQ=(process.env.NO_COLOR??"").length>0;T=s("\x1B[0;31m"),S=s("\x1B[0;32m"),_=s("\x1B[1;33m"),wZ=s("\x1B[0;34m"),I=s("\x1B[0;36m"),R=s("\x1B[1m"),h=s("\x1B[2m"),V=s("\x1B[0m")});import{existsSync as wQ}from"fs";async function Z$(){if(Y$!==void 0)return Y$;let $="/opt/homebrew/bin/python3.12";if(wQ($))return Y$=$,$;let Q=await f("python3.12");if(Q)return Y$=Q,Q;let Z=await f("python3");return Y$=Z,Z}async function z$($,Q={}){let Z=await Z$();if(!Z)return{stdout:"",stderr:"python3 not found",exitCode:127};return k([Z,"-c",$],Q)}var Y$;var V$=P(()=>{d()});var e1={};b(e1,{runStatus:()=>uQ});import{existsSync as y,readFileSync as W$,readdirSync as d1,statSync as o1}from"fs";import{resolve as D,basename as DQ}from"path";import{homedir as CQ}from"os";function n1($){let Q=Math.trunc($);if(Q>=1e6)return`${(Math.trunc(Q/1e6*10)/10).toFixed(1)}M`;if(Q>=1000)return`${(Math.trunc(Q/1000*10)/10).toFixed(1)}K`;return String(Q)}function a1($,Q,Z){if(Q===0)return null;let z=Math.trunc($*100/Q),X=Math.trunc($*R$/Q);if(X>R$)X=R$;let q=R$-X,K=S;if(z>=80)K=T;else if(z>=50)K=_;let W="=".repeat(Math.max(0,X))+" ".repeat(Math.max(0,q)),J=n1($),U=n1(Q);return`  ${R}${Z}${V} ${K}[${W}]${V} ${z}% (${J} / ${U})`}async function hQ(){if(await f("jq"))return!0;return process.stdout.write(`${T}Error: jq is required but not installed.${V}
`),process.stdout.write(`Install with:
`),process.stdout.write(`  brew install jq    (macOS)
`),process.stdout.write(`  apt install jq     (Debian/Ubuntu)
`),process.stdout.write(`  yum install jq     (RHEL/CentOS)
`),!1}function x$($){if(!Number.isFinite($)||$<=0)return!1;try{return process.kill($,0),!0}catch{return!1}}function E$($){if(!y($))return null;try{let Q=W$($,"utf-8").trim();if(!Q)return null;let Z=Number.parseInt(Q,10);return Number.isFinite(Z)?Z:null}catch{return null}}function yQ($){let Q=[],Z=E$(D($,"loki.pid"));if(Z!==null&&x$(Z))Q.push(`global:${Z}`);let z=D($,"sessions");if(y(z)){let X=[];try{X=d1(z)}catch{X=[]}for(let q of X){let K=D(z,q);try{if(!o1(K).isDirectory())continue}catch{continue}let W=D(K,"loki.pid"),J=E$(W);if(J!==null&&x$(J))Q.push(`${q}:${J}`)}}if(y($)){let X=[];try{X=d1($)}catch{X=[]}for(let q of X){if(!q.startsWith("run-")||!q.endsWith(".pid"))continue;let K=D($,q);try{if(!o1(K).isFile())continue}catch{continue}let W=DQ(q,".pid").slice(4),J=E$(K);if(J!==null&&x$(J)){if(!Q.some((H)=>H.startsWith(`${W}:`)))Q.push(`${W}:${J}`)}}}return Q}async function s1($,Q){let Z=await k(["jq","-r",$,Q]);if(Z.exitCode!==0)return null;return Z.stdout.trim()}function r1($,Q){try{let Z=W$($,"utf-8"),X=JSON.parse(Z)[Q];if(typeof X==="number"){if(Q==="budget_used"){let q=Math.round(X*100)/100;if(Number.isInteger(q))return String(q);return String(q)}return String(X)}if(X===void 0||X===null)return"0";return String(X)}catch{return"0"}}function t1($,Q,Z){try{let z=W$($,"utf-8"),q=JSON.parse(z)[Q];if(typeof q==="number"&&Number.isFinite(q))return q;return Z}catch{return Z}}async function vQ(){let $=j();if(!await hQ())return 1;if(!y($))return process.stdout.write(`${R}Loki Mode Status${V}
`),process.stdout.write(`
`),process.stdout.write(`${_}No active session found.${V}
`),process.stdout.write(`Loki Mode has not been initialized in this directory.
`),process.stdout.write(`
`),process.stdout.write(`To start a session:
`),process.stdout.write(`  loki start <prd>              - Start with a PRD file
`),process.stdout.write(`  loki start                    - Start without a PRD
`),process.stdout.write(`
`),process.stdout.write(`${h}Current directory: ${process.cwd()}${V}
`),0;process.stdout.write(`${R}Loki Mode Status${V}
`),process.stdout.write(`
`);let Q="",Z=D($,"state","provider");if(y(Z))try{Q=W$(Z,"utf-8").trim()}catch{Q=""}let z=Q||process.env.LOKI_PROVIDER||"claude",X="full features";switch(z){case"codex":case"aider":X="degraded mode";break;case"cline":X="near-full mode";break;default:X="full features";break}process.stdout.write(`${I}Provider:${V} ${z} (${X})
`),process.stdout.write(`${h}  Switch with: loki provider set <claude|codex|cline|aider>${V}
`),process.stdout.write(`
`);let q=yQ($);if(q.length>0){process.stdout.write(`${S}Active Sessions: ${q.length}${V}
`);for(let G of q){let O=G.indexOf(":"),M=O>=0?G.slice(0,O):G,L=O>=0?G.slice(O+1):"";if(M==="global")process.stdout.write(`  ${I}[global]${V} PID ${L}
`);else process.stdout.write(`  ${I}[#${M}]${V} PID ${L}
`)}process.stdout.write(`
`),process.stdout.write(`${h}  Stop specific: loki stop <session-id>${V}
`),process.stdout.write(`${h}  Stop all:      loki stop${V}
`),process.stdout.write(`
`)}if(y(D($,"PAUSE")))process.stdout.write(`${_}Status: PAUSED${V}
`),process.stdout.write(`${h}  Resume with: loki resume${V}
`),process.stdout.write(`
`);else if(y(D($,"STOP")))process.stdout.write(`${T}Status: STOPPED${V}
`),process.stdout.write(`${h}  Clear with: loki resume${V}
`),process.stdout.write(`
`);let K=D($,"STATUS.txt");if(y(K)){process.stdout.write(`${I}Session Info:${V}
`);try{process.stdout.write(W$(K,"utf-8"))}catch{}process.stdout.write(`
`)}let W=D($,"state","orchestrator.json");if(y(W)){process.stdout.write(`${I}Orchestrator State:${V}
`);let G=await s1('.currentPhase // "unknown"',W);process.stdout.write(`${G??"unknown"}
`)}let J=D($,"queue","pending.json");if(y(J)){let G=await s1('if type == "array" then length elif .tasks then .tasks | length else 0 end',J);process.stdout.write(`${I}Pending Tasks:${V} ${G??"0"}
`)}let U=D($,"metrics","budget.json");if(y(U)){let G=r1(U,"budget_limit"),O=r1(U,"budget_used");if(G!=="0"){process.stdout.write(`${I}Budget:${V} $${O} / $${G}
`);let M=Math.trunc((Number.parseFloat(O)||0)*100),L=Number.parseFloat(G),x=Number.isFinite(L)&&L!==0?Math.trunc(L*100):100,v=a1(M,x,"Budget");if(v!==null)process.stdout.write(`${v}
`)}else process.stdout.write(`${I}Cost:${V} $${O} (no limit)
`)}let H=D($,"state","context-usage.json");if(y(H)){let G=t1(H,"window_size",200000),O=t1(H,"used_tokens",0),M=a1(O,G,"Context");if(M!==null)process.stdout.write(`${M}
`)}let B=[D($,"dashboard","dashboard.pid"),D(CQ(),".loki","dashboard","dashboard.pid")].find((G)=>y(G))??"";if(B&&y(B)){let G=E$(B);if(G!==null&&x$(G)){let O=D(B,".."),M=(u,w)=>{let E=D(O,u);try{return y(E)?W$(E,"utf-8").trim()||w:w}catch{return w}},L=M("scheme","http"),x=M("host","127.0.0.1"),v=M("port",process.env.LOKI_DASHBOARD_PORT||"57374");if(x==="0.0.0.0")x="127.0.0.1";process.stdout.write(`${I}Dashboard:${V} ${L}://${x}:${v}/
`)}}return await mQ($),process.stdout.write(`
`),process.stdout.write(`${h}  Tip: loki analyze context show   - detailed token breakdown${V}
`),process.stdout.write(`${h}  Tip: loki analyze code overview  - codebase intelligence${V}
`),0}async function mQ($){let Q=D($,"state"),Z=gQ(Q),z=D(Q,"relevant-learnings.json"),X=D($,"escalations"),q=Z.length>0,K=y(z),W=y(X);if(!q&&!K&&!W)return;if(process.stdout.write(`
${I}Phase 1 artifacts:${V}
`),q){let J=Z[Z.length-1],U=i1(J);if(U&&Array.isArray(U.findings)){let H={Critical:0,High:0,Medium:0,Low:0};for(let B of U.findings){let G=String(B.severity??"");if(G in H)H[G]=(H[G]??0)+1}let Y=Object.entries(H).filter(([,B])=>B>0).map(([B,G])=>`${G} ${B.toLowerCase()}`).join(", ");process.stdout.write(`  Findings (iter ${U.iteration??"?"}): ${Y||"none"} -- ${U.findings.length} total
`)}}if(K){let J=i1(z);if(J&&Array.isArray(J.learnings)&&J.learnings.length>0){let U=new Map;for(let Y of J.learnings){let B=String(Y.trigger??"unknown");U.set(B,(U.get(B)??0)+1)}let H=[...U.entries()].sort((Y,B)=>B[1]-Y[1]).slice(0,3).map(([Y,B])=>`${B} ${Y}`).join(", ");process.stdout.write(`  Learnings: ${J.learnings.length} total (${H})
`)}}if(W){let J=0,U="";try{let Y=(await import("fs")).readdirSync(X).filter((B)=>B.endsWith(".md"));if(J=Y.length,Y.length>0)Y.sort(),U=Y[Y.length-1]??""}catch{}if(J>0)process.stdout.write(`  Escalations: ${J} handoff doc${J===1?"":"s"} (latest: ${U})
`)}}function gQ($){if(!y($))return[];try{return q$("fs").readdirSync($).filter((z)=>/^findings-\d+\.json$/.test(z)).sort((z,X)=>{let q=Number.parseInt(z.replace(/[^0-9]/g,""),10)||0,K=Number.parseInt(X.replace(/[^0-9]/g,""),10)||0;return q-K}).map((z)=>D($,z))}catch{return[]}}function i1($){try{let Q=q$("fs");return JSON.parse(Q.readFileSync($,"utf-8"))}catch{return null}}async function fQ(){let $=await Z$();if(!$)return process.stderr.write(`{"error": "Failed to generate JSON status. Ensure python3 is available."}
`),1;let Q=g,Z=j(),z=process.env.LOKI_DASHBOARD_PORT||"57374",X=process.env.LOKI_PROVIDER||"claude",q=await k([$,"-c",bQ,Q,Z,z,X],{timeoutMs:30000});if(q.exitCode!==0)return process.stderr.write(`{"error": "Failed to generate JSON status. Ensure python3 is available."}
`),1;return process.stdout.write(q.stdout),0}async function uQ($){let Q=[...$];while(Q.length>0){let Z=Q[0];if(Z==="--json")return fQ();if(Z==="--help"||Z==="-h")return process.stdout.write(`Usage: loki status [--json]
`),0;return process.stdout.write(`${T}Unknown flag: ${Z}${V}
`),process.stdout.write(`Usage: loki status [--json]
`),1}return vQ()}var R$=30,bQ=`
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
`;var $0=P(()=>{d();V$();c();C()});var Z0={};b(Z0,{emitDeprecatedAlias:()=>e$,deprecatedAliasShouldSuppress:()=>Q0});function Q0($){let Q=$[0];if(Q!==void 0&&pQ.has(Q))return!0;for(let Z of $)if(cQ.has(Z))return!0;return!1}function e$($,Q,Z){if(Q0(Z))return;process.stderr.write(`note: 'loki ${$}' is now 'loki ${Q}'. The old form still works.
`)}var cQ,pQ;var $1=P(()=>{cQ=new Set(["--json","-q","--quiet"]),pQ=new Set(["json","csv","timeline"])});var q0={};b(q0,{runStats:()=>sQ,computeStats:()=>K0});import{readdirSync as z0,readFileSync as lQ,statSync as X0}from"fs";import{join as r}from"path";function U$($){try{if(!X0($).isFile())return null;return JSON.parse(lQ($,"utf-8"))}catch{return null}}function z1($){try{return X0($).isDirectory()}catch{return!1}}function dQ($){if(!z1($))return[];try{let Q=z0($).filter((Z)=>Z.startsWith("iteration-")&&Z.endsWith(".json"));return Q.sort(),Q.map((Z)=>r($,Z))}catch{return[]}}function H$($){return Math.trunc($).toLocaleString("en-US")}function Q1($){let Q=Math.trunc($);if(Q<60)return`${Q}s`;let Z=Math.trunc(Q/3600),z=Math.trunc(Q%3600/60),X=Q%60;if(Z>0)return`${Z}h ${String(z).padStart(2,"0")}m`;return`${z}m ${String(X).padStart(2,"0")}s`}function t($,Q=0){let Z=Math.pow(10,Q);return Math.round($*Z)/Z}function B$($,Q){return $.toFixed(Q)}function Z1($,Q){return $.length>=Q?$:$+" ".repeat(Q-$.length)}function oQ($){let Q="N/A",Z=0,z=U$(r($,"state","orchestrator.json"));if(z&&typeof z==="object"){if(typeof z.currentPhase==="string")Q=z.currentPhase;if(typeof z.currentIteration==="number")Z=z.currentIteration}let X=r($,"metrics","efficiency"),q=dQ(X),K=[];for(let F of q){let N=U$(F);if(N&&typeof N==="object")K.push(N)}if(K.length>0)Z=Math.max(Z,K.length);let W=K.reduce((F,N)=>F+(N.input_tokens??0),0),J=K.reduce((F,N)=>F+(N.output_tokens??0),0),U=W+J,H=K.reduce((F,N)=>F+(N.cost_usd??0),0),Y=K.reduce((F,N)=>F+(N.duration_seconds??0),0),B=0,G=0,O=U$(r($,"metrics","budget.json"));if(O&&typeof O==="object"){if(typeof O.budget_limit==="number")B=O.budget_limit;if(typeof O.budget_used==="number")G=O.budget_used}let M=0,L=0,x=U$(r($,"state","quality-gates.json"));if(x&&typeof x==="object"){if(Array.isArray(x)){for(let F of x)if(L+=1,F===!0)M+=1;else if(F&&typeof F==="object"){let N=F;if(N.passed===!0||N.status==="passed")M+=1}}else for(let F of Object.values(x))if(typeof F==="boolean"){if(L+=1,F)M+=1}else if(F&&typeof F==="object"){L+=1;let N=F;if(N.passed===!0||N.status==="passed")M+=1}}let v={},u=U$(r($,"quality","gate-failure-count.json"));if(u&&typeof u==="object"&&!Array.isArray(u)){let F={};for(let[N,l]of Object.entries(u))if(typeof l==="number")F[N]=l;v=F}let w=0,E=0,n=0,d$=r($,"quality");if(z1(d$)){let F=[];try{F=z0(d$)}catch{F=[]}for(let N of F){if(!N.endsWith(".json")||N==="gate-failure-count.json")continue;let l=U$(r(d$,N));if(!l||typeof l!=="object")continue;if(!(("verdict"in l)||("approved"in l)||("reviewers"in l)))continue;w+=1;let N1=(l.verdict??"").toString().toLowerCase();if(l.approved===!0||["approved","approve","pass"].includes(N1))E+=1;else if(["revision","revise","changes_requested","reject"].includes(N1))n+=1}}return{phase:Q,iterationCount:Z,iterations:K,totalInput:W,totalOutput:J,totalTokens:U,totalCost:H,totalDuration:Y,budgetLimit:B,budgetUsed:G,gatesPassed:M,gatesTotal:L,gateFailures:v,reviewsTotal:w,reviewsApproved:E,reviewsRevision:n}}function nQ($,Q){let Z=$.iterationCount,z={session:{iterations:Z,duration_seconds:$.totalDuration,phase:$.phase},tokens:{input:$.totalInput,output:$.totalOutput,total:$.totalTokens,cost_usd:t($.totalCost,2)},quality:{gates_passed:$.gatesPassed,gates_total:$.gatesTotal,reviews_total:$.reviewsTotal,reviews_approved:$.reviewsApproved,reviews_revision:$.reviewsRevision,gate_failures:$.gateFailures},efficiency:{avg_tokens_per_iteration:Z>0?t($.totalTokens/Z,0):0,avg_cost_per_iteration:Z>0?t($.totalCost/Z,2):0,avg_duration_per_iteration:Z>0?t($.totalDuration/Z,1):0},budget:{used:t($.budgetUsed,2),limit:$.budgetLimit,percent:$.budgetLimit>0?t($.budgetUsed/$.budgetLimit*100,1):0}};if(Q)z.iterations=$.iterations.map((K,W)=>({number:W+1,input_tokens:K.input_tokens??0,output_tokens:K.output_tokens??0,cost_usd:t(K.cost_usd??0,2),duration_seconds:K.duration_seconds??0}));let X=JSON.stringify(z,null,2);function q(K,W){if(!W)return;let J=new RegExp(`("${K}": )(-?\\d+)(,?)$`,"m");X=X.replace(J,(U,H,Y,B)=>`${H}${Y}.0${B}`)}if(q("avg_duration_per_iteration",Z>0&&Number.isInteger(z.efficiency.avg_duration_per_iteration)),q("percent",$.budgetLimit>0&&Number.isInteger(z.budget.percent)),q("cost_usd",Z>0&&Number.isInteger(z.tokens.cost_usd)),Q)X=X.replace(/("cost_usd": )(-?\d+)(,?)$/gm,(K,W,J,U)=>`${W}${J}.0${U}`);return X}function aQ($,Q){let Z=[];if(Z.push("Loki Mode Session Statistics"),Z.push("============================"),Z.push(""),Z.push("Session"),Z.push(`  Iterations completed: ${$.iterationCount}`),Z.push(`  Duration: ${Q1($.totalDuration)}`),Z.push(`  Current phase: ${$.phase}`),Z.push(""),Z.push("Token Usage"),$.iterations.length>0)Z.push(`  Input tokens:  ${H$($.totalInput)}`),Z.push(`  Output tokens: ${H$($.totalOutput)}`),Z.push(`  Total tokens:  ${H$($.totalTokens)}`),Z.push(`  Estimated cost: $${B$($.totalCost,2)}`);else Z.push("  N/A (no iteration metrics found)");if(Z.push(""),Z.push("Quality Gates"),$.gatesTotal>0){let z=Math.round($.gatesPassed/$.gatesTotal*100);Z.push(`  Gates passed: ${$.gatesPassed}/${$.gatesTotal} (${z}%)`)}else Z.push("  Gates passed: N/A");if($.reviewsTotal>0){let z=[];if($.reviewsApproved>0)z.push(`${$.reviewsApproved} approved`);if($.reviewsRevision>0)z.push(`${$.reviewsRevision} revision requested`);let X=z.length>0?z.join(", "):"N/A";Z.push(`  Code reviews: ${$.reviewsTotal} (${X})`)}if(Object.keys($.gateFailures).length>0){let z=Object.entries($.gateFailures).filter(([,X])=>X>0).map(([X,q])=>`${X} (${q})`);if(z.length>0)Z.push(`  Gate failures: ${z.join(", ")}`)}if(Z.push(""),Z.push("Efficiency"),$.iterationCount>0&&$.iterations.length>0){let z=Math.round($.totalTokens/$.iterationCount),X=$.totalCost/$.iterationCount,q=$.totalDuration/$.iterationCount;Z.push(`  Avg tokens/iteration: ${H$(z)}`),Z.push(`  Avg cost/iteration: $${B$(X,2)}`),Z.push(`  Avg duration/iteration: ${Q1(q)}`)}else Z.push("  N/A (no iteration metrics found)");if(Z.push(""),Z.push("Budget"),$.budgetLimit>0){let z=t($.budgetUsed/$.budgetLimit*100,1),X=Number.isInteger(z)?`${z}.0`:`${z}`;Z.push(`  Used: $${B$($.budgetUsed,2)} / $${B$($.budgetLimit,2)} (${X}%)`)}else if($.budgetUsed>0)Z.push(`  Used: $${B$($.budgetUsed,2)} (no limit set)`);else Z.push("  N/A");if(Q&&$.iterations.length>0)Z.push(""),Z.push("Per-Iteration Breakdown"),$.iterations.forEach((z,X)=>{let q=X+1,K=Z1(H$(z.input_tokens??0),10),W=Z1(H$(z.output_tokens??0),10),J=z.cost_usd??0,U=Q1(z.duration_seconds??0),H=Z1(`${q}`,3);Z.push(`  #${H} input: ${K} output: ${W} cost: $${B$(J,2)}  time: ${U}`)});return Z.join(`
`)}function K0($){let Q=!1,Z=!1;for(let K of $)if(K==="--json")Q=!0;else if(K==="--efficiency")Z=!0;let z=j();if(!z1(z)){if(Q)return{exitCode:0,stdout:'{"error": "No active session"}'};return{exitCode:0,stdout:`${_}No active session found.${V}
Start a session with: loki start <prd>`}}let X=oQ(z);return{exitCode:0,stdout:Q?nQ(X,Z):aQ(X,Z)}}async function sQ($){let{emitDeprecatedAlias:Q}=await Promise.resolve().then(() => ($1(),Z0));Q("stats","report session",$);let Z=K0($);return console.log(Z.stdout),Z.exitCode}var V0=P(()=>{C();c()});var T0={};b(T0,{runDoctor:()=>W3,pythonImportOk:()=>V1,httpReachable:()=>K1,checkTool:()=>B0,checkSkills:()=>G0,checkDisk:()=>q1,buildDoctorJson:()=>M0,_setPythonImportOkForTest:()=>Z3});import{existsSync as J0,lstatSync as rQ,readlinkSync as tQ,statfsSync as iQ}from"fs";import{spawnSync as eQ}from"child_process";import{homedir as W0}from"os";import{resolve as X1}from"path";function Q3($){let Q=$.match($3);return Q?Q[1]:null}async function U0($){try{let Q=await k([$,"--version"],{timeoutMs:5000}),Z=(Q.stdout||Q.stderr||"").trim();return Q3(Z)}catch{return null}}function H0($,Q){let Z=$.split(".").map((X)=>parseInt(X,10)),z=Q.split(".").map((X)=>parseInt(X,10));while(Z.length<2)Z.push(0);while(z.length<2)z.push(0);for(let X=0;X<2;X++){let q=Z[X]??0,K=z[X]??0;if(Number.isNaN(q)||Number.isNaN(K))return 0;if(q!==K)return q-K}return 0}async function B0($,Q,Z,z=null){let X=await f(Q),q=X!==null,K=q?await U0(Q):null,W="pass";if(!q)W=Z==="required"?"fail":"warn";else if(z&&K){if(H0(K,z)<0)W=Z==="required"?"fail":"warn"}return{name:$,command:Q,found:q,version:K,required:Z,min_version:z,status:W,path:X}}function q1(){let $=null;try{let Z=iQ(W0()),z=Number(Z.bavail)*Number(Z.bsize);$=Math.round(z/1073741824*10)/10}catch{$=null}let Q="pass";if($!==null){if($<1)Q="fail";else if($<5)Q="warn"}return{available_gb:$,status:Q}}async function K1($,Q=2000){try{return(await fetch($,{signal:AbortSignal.timeout(Q)})).ok}catch{return!1}}async function V1($,Q=!1){let Z=`import ${$}`,z=Q?30000:5000;if(!Q)return(await z$(Z,{timeoutMs:z})).exitCode===0;let X=await Z$();if(!X)return!1;return(await k([X,"-c",Z],{timeoutMs:z})).exitCode===0}function Z3($){D$.fn=$??V1}function G0(){let $=W0();return z3.map(({name:Q,dir:Z})=>{let z=X1($,Z),X=z,q=X1(z,"SKILL.md");if(J0(q))return{name:Q,path:X,status:"pass",detail:""};try{if(rQ(z).isSymbolicLink()){let W="unknown";try{W=tQ(z)}catch{}return{name:Q,path:X,status:"fail",detail:`(broken symlink -> ${W})`}}}catch{}return{name:Q,path:X,status:"warn",detail:"(not found - run 'loki setup-skill')"}})}async function Y0(){return Promise.all(X3.map(async($)=>{return{...await B0($.jsonName,$.cmd,$.required,$.min??null),displayName:$.displayName}}))}async function K3(){let Q=await f("sentrux")!==null,Z=Q?await U0("sentrux"):null;return{found:Q,version:Z,status:Q?"pass":"warn",required:"optional"}}async function q3(){let{openSync:$,statSync:Q,readSync:Z,closeSync:z,existsSync:X}=await import("fs"),{join:q}=await import("path"),K=65536,W=process.env.LOKI_DIR??".loki",J=q(W,"memory",".errors.log"),U=[],H=!1;try{if(X(J)){H=!0;let Y=Q(J).size,B=Math.max(0,Y-65536),G=Y-B,O=Buffer.alloc(G),M=$(J,"r");try{Z(M,O,0,G,B)}finally{z(M)}let x=O.toString("utf-8").split(`
`);if(B>0&&x.length>0)x=x.slice(1);x=x.map((v)=>v.trim()).filter((v)=>v.length>0),U=x.slice(-5)}}catch{U=[]}return{errors_log_path:H?J:null,recent_errors:U,recent_error_count:U.length,status:U.length===0?"pass":"warn"}}async function M0(){let Q=(await Y0()).map(({displayName:J,...U})=>U),Z=q1(),z=await K3(),X=await q3(),q=0,K=0,W=0;for(let J of Q)if(J.status==="pass")q++;else if(J.status==="fail")K++;else W++;if(Z.status==="pass")q++;else if(Z.status==="fail")K++;else W++;return{loki_mode_version:F$(),checks:Q,disk:Z,sentrux:z,memory:X,summary:{passed:q,failed:K,warnings:W,ok:K===0}}}function A($){switch($){case"pass":return`${S}PASS${V}`;case"fail":return`${T}FAIL${V}`;case"warn":return`${_}WARN${V}`}}function N$($){let Q=$.version?` (v${$.version})`:"",Z=$.displayName;if(!$.found){let z=$.required==="required"?"not found":$.required==="recommended"?"not found (recommended)":"not found (optional)";return`  ${A($.status)}  ${Z} - ${z}`}if($.min_version&&$.version&&H0($.version,$.min_version)<0){let z=$.required==="required"?"requires":"recommended";return`  ${A($.status)}  ${Z}${Q} - ${z} >= ${$.min_version}`}return`  ${A($.status)}  ${Z}${Q}`}function S$($,Q){if(Q==="pass")$.pass++;else if(Q==="fail")$.fail++;else $.warn++}function V3(){process.stdout.write(`${R}loki doctor${V} - Check system prerequisites

`),process.stdout.write(`Usage: loki doctor [--json]

`),process.stdout.write(`Options:
`),process.stdout.write(`  --json    Output machine-readable JSON

`),process.stdout.write(`Checks: node, python3, jq, git, curl, bash version,
`),process.stdout.write(`        claude/codex CLIs, and disk space.
`)}async function J3(){process.stdout.write(`${R}Loki Mode Doctor${V}

`),process.stdout.write(`Checking system prerequisites...

`);let $={pass:0,fail:0,warn:0},Q=await Y0(),Z=new Map(Q.map((w)=>[w.command,w]));process.stdout.write(`${I}Required:${V}
`);for(let w of["node","python3","jq","git","curl"]){let E=Z.get(w);process.stdout.write(N$(E)+`
`),S$($,E.status)}process.stdout.write(`
`),process.stdout.write(`${I}AI Providers:${V}
`);let z=["claude","codex","cline","aider"],X={claude:"npm install -g @anthropic-ai/claude-code",codex:"npm install -g @openai/codex",cline:"npm install -g cline",aider:"pip install aider-chat"},q=!1;for(let w of z){let E=Z.get(w);if(process.stdout.write(N$(E)+`
`),!E.found&&X[w])process.stderr.write(`         ${_}Install: ${X[w]}${V}
`);if(S$($,E.status),E.found)q=!0}if(!q){if(process.stdout.write(`  ${A("fail")}  No AI provider CLI installed -- at least one is required
`),process.stdout.write(`         ${_}Install: npm install -g @anthropic-ai/claude-code${V}
`),$.fail++,process.stdout.isTTY){let w=X1(g,"autonomy/provider-offer.sh");if(J0(w))eQ("bash",[w,"report"],{stdio:"inherit"})}}process.stdout.write(`
`),process.stdout.write(`${I}API Keys:${V}
`);let K=Z.get("claude")?.found??!1,W=Z.get("codex")?.found??!1,J=process.env;if(J.ANTHROPIC_API_KEY)process.stdout.write(`  ${A("pass")}  ANTHROPIC_API_KEY is set
`),$.pass++;else if(K)process.stdout.write(`  ${h}  --  ${V}  ANTHROPIC_API_KEY not set (Claude CLI uses its own login)
`);if(J.OPENAI_API_KEY)process.stdout.write(`  ${A("pass")}  OPENAI_API_KEY is set
`),$.pass++;else if(W)process.stdout.write(`  ${h}  --  ${V}  OPENAI_API_KEY not set (Codex CLI uses its own login)
`);if(J.ANTHROPIC_BASE_URL){let w=J.ANTHROPIC_BASE_URL;if(process.stdout.write(`  ${A("pass")}  ANTHROPIC_BASE_URL: ${w}
`),$.pass++,!J.LOKI_MODEL_OVERRIDE)process.stdout.write(`  ${A("warn")}  LOKI_MODEL_OVERRIDE not set -- opus/sonnet/haiku aliases may not resolve on alt-provider
`),$.warn++;else process.stdout.write(`  ${A("pass")}  LOKI_MODEL_OVERRIDE: ${J.LOKI_MODEL_OVERRIDE}
`),$.pass++}process.stdout.write(`
`),process.stdout.write(`${I}Skills:${V}
`);for(let w of G0())if(w.status==="pass")process.stdout.write(`  ${A("pass")}  ${w.name}  ${h}${w.path}${V}
`),$.pass++;else if(w.status==="fail")process.stdout.write(`  ${A("fail")}  ${w.name}  ${h}${w.detail}${V}
`),process.stdout.write(`         ${_}Fix: loki setup-skill${V}
`),$.fail++;else process.stdout.write(`  ${A("warn")}  ${w.name}  ${h}${w.detail}${V}
`),$.warn++;process.stdout.write(`
`),process.stdout.write(`${I}Integrations:${V}
`);let[U,H,Y]=await Promise.all([D$.fn("mcp"),D$.fn("numpy",!0),D$.fn("sentence_transformers",!0)]);if(U)process.stdout.write(`  ${A("pass")}  MCP SDK (Python)
`),$.pass++;else process.stdout.write(`  ${A("warn")}  MCP SDK - not installed (pip3 install mcp)
`),$.warn++;if(H)process.stdout.write(`  ${A("pass")}  numpy (vector search)
`),$.pass++;else process.stdout.write(`  ${A("warn")}  numpy - not installed (pip3 install numpy)
`),$.warn++;if(Y)process.stdout.write(`  ${A("pass")}  sentence-transformers (embeddings)
`),$.pass++;else process.stdout.write(`  ${A("warn")}  sentence-transformers - not installed (loki memory vectors setup)
`),$.warn++;if(await K1("http://localhost:8100/api/v2/heartbeat"))process.stdout.write(`  ${A("pass")}  ChromaDB server (port 8100)
`),$.pass++;else process.stdout.write(`  ${A("warn")}  ChromaDB - not running (docker start loki-chroma)
`),$.warn++;{let w=["pyright-langserver","pylsp","typescript-language-server","gopls","rust-analyzer","jdtls"],E=[];for(let n of w)if(await f(n))E.push(n);if(E.length>0)process.stdout.write(`  ${A("pass")}  LSP servers detected (${E.length}): ${E.join(", ")}
`),$.pass++;else process.stdout.write(`  ${A("warn")}  LSP servers - none on PATH (install for symbol grounding: npm i -g pyright typescript-language-server; brew install gopls)
`),$.warn++}let B=process.env.LOKI_MIROFISH_URL;if(B)if(await K1(`${B}/health`))process.stdout.write(`  ${A("pass")}  MiroFish server (${B})
`),$.pass++;else process.stdout.write(`  ${A("warn")}  MiroFish - not running (loki start --mirofish-docker <image>)
`),$.warn++;if(process.env.LOKI_OTEL_ENDPOINT)process.stdout.write(`  ${A("pass")}  OTEL endpoint: ${process.env.LOKI_OTEL_ENDPOINT}
`),$.pass++;else process.stdout.write(`  ${A("warn")}  OTEL - not configured (set LOKI_OTEL_ENDPOINT)
`),$.warn++;if(await f("sentrux")){let w="unknown";try{let n=(await k(["sentrux","--version"],{timeoutMs:2000})).stdout.split(/\s+/).filter(Boolean).pop();if(n)w=n.replace(/^v/,"")}catch{}process.stdout.write(`  ${A("pass")}  sentrux ${w} (architectural drift gate: loki sentrux help)
`),$.pass++}else process.stdout.write(`  ${A("warn")}  sentrux - not installed (optional, brew install sentrux/tap/sentrux)
`),$.warn++;process.stdout.write(`
`),process.stdout.write(`${I}System:${V}
`);let G=Z.get("bash");process.stdout.write(N$(G)+`
`),S$($,G.status);let O=Z.get("bun");if(O)process.stdout.write(N$(O)+`
`),S$($,O.status);let M=q1(),L=M.available_gb===null?null:Math.floor(M.available_gb);if(L===null)process.stdout.write(`  ${A("warn")}  Disk space: unable to determine
`),$.warn++;else if(M.status==="fail")process.stdout.write(`  ${A("fail")}  Disk space: ${L}GB available (need >= 1GB)
`),$.fail++;else if(M.status==="warn")process.stdout.write(`  ${A("warn")}  Disk space: ${L}GB available (low)
`),$.warn++;else process.stdout.write(`  ${A("pass")}  Disk space: ${L}GB available
`),$.pass++;process.stdout.write(`
`),process.stdout.write(`${I}Runtime route:${V}
`);let x=process.versions.bun!==void 0,v=process.argv[0]??"(unknown)";if(process.stdout.write(`  ${A("pass")}  Active runtime: ${x?"Bun":"Node"} (${v})
`),process.env.LOKI_LEGACY_BASH==="1"||process.env.LOKI_LEGACY_BASH==="true")process.stdout.write(`  ${A("warn")}  LOKI_LEGACY_BASH set: shim routes every command to autonomy/loki (bash)
`);if(process.env.LOKI_TS_ENTRY)process.stdout.write(`  ${A("pass")}  LOKI_TS_ENTRY override: ${process.env.LOKI_TS_ENTRY}
`);if(process.env.BUN_FROM_SOURCE==="1"||process.env.BUN_FROM_SOURCE==="true")process.stdout.write(`  ${A("pass")}  BUN_FROM_SOURCE set: shim prefers loki-ts/src/ over dist/
`);let u=await Z$();if(u!==null){let E=(await k([u,"-c","import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"],{timeoutMs:5000})).stdout.trim();if(E.startsWith("3.12"))process.stdout.write(`  ${A("pass")}  Python 3.12 (chromadb / sentence-transformers): ${E} at ${u}
`);else if(E)process.stdout.write(`  ${A("warn")}  Python 3.12 NOT found -- using ${E} at ${u}; chromadb / sentence-transformers may fail. Install python3.12 (brew install python@3.12 / apt install python3.12).
`);else process.stdout.write(`  ${A("warn")}  Python 3 found at ${u} but version probe failed; chromadb may not work.
`)}else process.stdout.write(`  ${A("warn")}  Python 3 not on PATH -- memory + MCP integrations disabled.
`);if(process.stdout.write(`
`),process.stdout.write(`${R}Summary:${V} ${S}${$.pass} passed${V}, ${T}${$.fail} failed${V}, ${_}${$.warn} warnings${V}

`),$.fail>0)return process.stdout.write(`${T}Some required prerequisites are missing.${V}
`),process.stdout.write(`Install missing dependencies and run 'loki doctor' again.
`),1;if($.warn>0)return process.stdout.write(`${_}All required checks passed with some warnings.${V}
`),0;return process.stdout.write(`${S}All checks passed. System is ready for Loki Mode.${V}
`),0}async function W3($){let Q=!1;for(let Z of $)if(Z==="--json")Q=!0;else if(Z==="--help"||Z==="-h")return V3(),0;else return process.stderr.write(`${T}Unknown option: ${Z}${V}
`),process.stderr.write(`Usage: loki doctor [--json]
`),1;if(Q){let Z=await M0();return process.stdout.write(JSON.stringify(Z,null,2)+`
`),0}return J3()}var $3,D$,z3,X3;var O0=P(()=>{C();d();V$();c();s$();$3=/(\d+\.\d+(?:\.\d+)*)/;D$={fn:V1};z3=[{name:"Claude Code",dir:".claude/skills/loki-mode"},{name:"Codex CLI",dir:".codex/skills/loki-mode"},{name:"Cline CLI",dir:".cline/skills/loki-mode"},{name:"Aider CLI",dir:".aider/skills/loki-mode"}];X3=[{displayName:"Node.js (>= 18)",jsonName:"Node.js",cmd:"node",required:"required",min:"18.0"},{displayName:"Python 3 (>= 3.8)",jsonName:"Python 3",cmd:"python3",required:"required",min:"3.8"},{displayName:"jq",jsonName:"jq",cmd:"jq",required:"required"},{displayName:"git",jsonName:"git",cmd:"git",required:"required"},{displayName:"curl",jsonName:"curl",cmd:"curl",required:"required"},{displayName:"bash (>= 4.0)",jsonName:"bash",cmd:"bash",required:"recommended",min:"4.0"},{displayName:"Bun (>= 1.3)",jsonName:"Bun",cmd:"bun",required:"recommended",min:"1.3"},{displayName:"Claude CLI",jsonName:"Claude CLI",cmd:"claude",required:"optional"},{displayName:"Codex CLI",jsonName:"Codex CLI",cmd:"codex",required:"optional"},{displayName:"Cline CLI",jsonName:"Cline CLI",cmd:"cline",required:"optional"},{displayName:"Aider CLI",jsonName:"Aider CLI",cmd:"aider",required:"optional"}]});import{existsSync as _0,mkdirSync as B9,readdirSync as U3,readFileSync as I0,renameSync as G9,writeFileSync as Y9}from"fs";import{dirname as H3,join as B3,resolve as G3}from"path";import{fileURLToPath as Y3}from"url";function M3(){try{let $=H3(Y3(import.meta.url)),Q=G3($,"..","..","data","model-pricing.json");if(!_0(Q))return T$;let z=JSON.parse(I0(Q,"utf8")).pricing;if(!z||typeof z!=="object")return T$;let X={};for(let[q,K]of Object.entries(z))if(K!==null&&typeof K==="object"&&typeof K.input==="number"&&typeof K.output==="number")X[q]={input:K.input,output:K.output};for(let q of Object.keys(T$))if(!(q in X))return T$;return X}catch{return T$}}function T3($){return Math.round(($+Number.EPSILON)*1e4)/1e4}function O3($){let Q=($??w0).toLowerCase();return A0[Q]??A0[w0]}function L0($){let Q=0;for(let Z of $){if(typeof Z.cost_usd==="number"&&Number.isFinite(Z.cost_usd)){Q+=Z.cost_usd;continue}let z=O3(Z.model),X=typeof Z.input_tokens==="number"?Z.input_tokens:0,q=typeof Z.output_tokens==="number"?Z.output_tokens:0;Q+=X/1e6*z.input+q/1e6*z.output}return T3(Q)}function P0($){if(!_0($))return[];let Q=[],Z;try{Z=U3($)}catch{return[]}for(let z of Z){if(!z.endsWith(".json"))continue;let X=B3($,z);try{let q=I0(X,"utf8"),K=JSON.parse(q);if(K&&typeof K==="object")Q.push(K)}catch{}}return Q}var T$,A0,w0="sonnet";var j0=P(()=>{C();T$={fable:{input:10,output:50},opus:{input:5,output:25},sonnet:{input:3,output:15},haiku:{input:1,output:5},"gpt-5.3-codex":{input:1.5,output:12}};A0=Object.freeze(M3())});import{existsSync as C$,readdirSync as A3,readFileSync as w3,statSync as _3}from"fs";import{join as b$}from"path";function I3($){let Q=[],Z=b$($,"votes");if(!C$(Z))return Q;let z;try{z=A3(Z)}catch{return Q}for(let X of z){if(!X.startsWith("round-")||!X.endsWith(".json"))continue;try{let q=b$(Z,X);if(!_3(q).isFile())continue;let K=JSON.parse(w3(q,"utf8"));Q.push({iteration:typeof K.iteration==="number"?K.iteration:void 0,verdict:typeof K.verdict==="string"?K.verdict:void 0,complete_votes:typeof K.complete_votes==="number"?K.complete_votes:void 0,total_members:typeof K.total_members==="number"?K.total_members:void 0,threshold:typeof K.threshold==="number"?K.threshold:void 0})}catch{}}return Q}function L3(){return{iteration_count:0,total_cost_usd:0,avg_cost_per_iteration:null,total_input_tokens:0,total_output_tokens:0,total_duration_ms:0,avg_duration_ms_per_iteration:null,model_breakdown:{},phase_breakdown:{},status_breakdown:{}}}function P3(){return{council_rounds:0,unanimous_rate:null,approval_rate:null,iteration_success_rate:null}}function j3($){let Q=L3();if($.length===0)return Q;Q.iteration_count=$.length,Q.total_cost_usd=Math.round(L0($)*1e4)/1e4;for(let Z of $){if(typeof Z.input_tokens==="number")Q.total_input_tokens+=Z.input_tokens;if(typeof Z.output_tokens==="number")Q.total_output_tokens+=Z.output_tokens;let z=Z;if(typeof z.duration_ms==="number")Q.total_duration_ms+=z.duration_ms;if(typeof Z.model==="string")Q.model_breakdown[Z.model]=(Q.model_breakdown[Z.model]??0)+1;if(typeof z.phase==="string")Q.phase_breakdown[z.phase]=(Q.phase_breakdown[z.phase]??0)+1;if(typeof z.status==="string")Q.status_breakdown[z.status]=(Q.status_breakdown[z.status]??0)+1}return Q.avg_cost_per_iteration=Math.round(Q.total_cost_usd/Q.iteration_count*1e4)/1e4,Q.avg_duration_ms_per_iteration=Math.round(Q.total_duration_ms/Q.iteration_count),Q}function F3($,Q,Z){let z=P3();if(z.council_rounds=$.length,$.length>0){let X=0,q=0;for(let K of $){if(typeof K.complete_votes==="number"&&typeof K.total_members==="number"&&K.total_members>0&&K.complete_votes===K.total_members)X+=1;if(K.verdict==="COMPLETE")q+=1}z.unanimous_rate=Math.round(X/$.length*1e4)/1e4,z.approval_rate=Math.round(q/$.length*1e4)/1e4}if(Z>0)z.iteration_success_rate=Math.round(Q/Z*1e4)/1e4;return z}function F0($){let Q=[],Z=b$($,"metrics","efficiency"),z=b$($,"council"),X=C$(Z)?P0(Z):[];if(!C$(Z))Q.push("no .loki/metrics/efficiency/ dir (efficiency KPIs zeroed)");else if(X.length===0)Q.push(".loki/metrics/efficiency/ exists but no iteration files found");let q=I3(z);if(!C$(z))Q.push("no .loki/council/ dir (accuracy KPIs zeroed)");else if(q.length===0)Q.push(".loki/council/ exists but no round-N.json files found");let K=j3(X),W=K.status_breakdown.success??0,J=F3(q,W,K.iteration_count);return{schema_version:1,generated_at:new Date().toISOString(),loki_dir:$,efficiency:K,accuracy:J,notes:Q}}function k0($){return JSON.stringify($,null,2)}function R0($){let Q=[];Q.push(`Loki Mode KPIs  (snapshot at ${$.generated_at})`),Q.push(`Source: ${$.loki_dir}`),Q.push(""),Q.push("Efficiency"),Q.push(`  Iterations:           ${$.efficiency.iteration_count}`),Q.push(`  Total cost USD:       ${$.efficiency.total_cost_usd}`),Q.push(`  Avg cost per iter:    ${$.efficiency.avg_cost_per_iteration??"n/a"}`),Q.push(`  Total input tokens:   ${$.efficiency.total_input_tokens}`),Q.push(`  Total output tokens:  ${$.efficiency.total_output_tokens}`),Q.push(`  Total duration (ms):  ${$.efficiency.total_duration_ms}`),Q.push(`  Avg duration / iter:  ${$.efficiency.avg_duration_ms_per_iteration??"n/a"}`);let Z=Object.entries($.efficiency.model_breakdown).sort((q,K)=>q[0].localeCompare(K[0]));if(Z.length>0)Q.push(`  Model breakdown:      ${Z.map(([q,K])=>`${q}=${K}`).join(", ")}`);let z=Object.entries($.efficiency.phase_breakdown).sort((q,K)=>q[0].localeCompare(K[0]));if(z.length>0)Q.push(`  Phase breakdown:      ${z.map(([q,K])=>`${q}=${K}`).join(", ")}`);let X=Object.entries($.efficiency.status_breakdown).sort((q,K)=>q[0].localeCompare(K[0]));if(X.length>0)Q.push(`  Status breakdown:     ${X.map(([q,K])=>`${q}=${K}`).join(", ")}`);if(Q.push(""),Q.push("Accuracy"),Q.push(`  Council rounds:       ${$.accuracy.council_rounds}`),Q.push(`  Unanimous rate:       ${$.accuracy.unanimous_rate??"n/a"}`),Q.push(`  Approval rate:        ${$.accuracy.approval_rate??"n/a"}`),Q.push(`  Iter success rate:    ${$.accuracy.iteration_success_rate??"n/a"}`),$.notes.length>0){Q.push(""),Q.push("Notes");for(let q of $.notes)Q.push(`  - ${q}`)}return Q.push(""),Q.push("See also: loki trust  (trust trajectory across runs)"),Q.join(`
`)}var x0=P(()=>{j0()});var J1={};b(J1,{runKpis:()=>R3});function R3($,Q={}){if(Q.aliasOf)e$(Q.aliasOf,"report kpis",$);let Z=!1;for(let X of $){if(X==="--help"||X==="-h"||X==="help")return process.stdout.write(k3),0;if(X==="--json"){Z=!0;continue}if(X==="-q"||X==="--quiet")continue;return process.stderr.write(`loki kpis: unknown arg: ${X}
Run 'loki kpis --help' for usage.
`),1}let z=F0(j());return process.stdout.write(Z?k0(z)+`
`:R0(z)+`
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
`;var W1=P(()=>{x0();C();$1()});var E0={};b(E0,{delegateToBash:()=>N3});import{resolve as x3}from"path";async function N3($){let Q=x3(g,"autonomy","loki"),Z=Bun.spawn({cmd:[Q,...$],stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,LOKI_LEGACY_BASH:"1"}}),z=setTimeout(()=>{try{Z.kill("SIGKILL")}catch{}},E3);try{return await Z.exited}finally{clearTimeout(z)}}var E3=3600000;var N0=P(()=>{C()});import{existsSync as S3,mkdirSync as D3,readdirSync as C3,readFileSync as b3,statSync as h3,writeFileSync as y3}from"fs";import{join as O$}from"path";function U1($){return $&&typeof $==="object"?$:{}}function X$($){return Math.round($*1e4)/1e4}function u3($){let Q=String($??"").trim().toUpperCase();if(!Q)return null;for(let Z of D0)if(Q.startsWith(Z))return!0;return!1}function c3($){let Q=u3($.final_verdict);if(Q!==null)return Q?1:0;let Z=$.reviewers;if(Array.isArray(Z)&&Z.length>0){let z=0,X=0;for(let q of Z){if(!q||typeof q!=="object")continue;X+=1;let K=String(q.vote??"").trim().toUpperCase();if(D0.some((W)=>K.startsWith(W)))z+=1}if(X>0)return z===X?1:0}return null}function p3($){let Q=Number($.total),Z=Number($.passed);if(!Number.isFinite(Q)||!Number.isFinite(Z))return null;if(Q<=0)return null;return Math.max(0,Math.min(1,Z/Q))}function l3($){let Q;if($&&typeof $==="object")Q=$.count;else Q=$;let Z=Number(Q);if(!Number.isFinite(Z)||Z<0)return null;return Z}function d3($){let Q=U1($.council);for(let Z of[Q.interventions,$.interventions]){let z=Number(Z);if(Number.isFinite(z)&&z>=0)return z}return null}function o3($){let Q=O$($,"proofs"),Z=[];if(!S3(Q))return Z;let z;try{z=C3(Q).sort()}catch{return Z}for(let X of z){let q=O$(Q,X);try{if(!h3(q).isDirectory())continue}catch{continue}let K=null;try{K=JSON.parse(b3(O$(q,"proof.json"),"utf8"))}catch{continue}if(!K||typeof K!=="object")continue;Z.push({run_id:String(K.run_id??X),generated_at:typeof K.generated_at==="string"?K.generated_at:null,council_pass_rate:c3(U1(K.council)),gate_pass_rate:p3(U1(K.quality_gates)),iterations:l3(K.iterations),interventions:d3(K)})}return Z.sort((X,q)=>{let K=X.generated_at===null?1:0,W=q.generated_at===null?1:0;if(K!==W)return K-W;return(X.generated_at??"").localeCompare(q.generated_at??"")}),Z}function S0($){return $.reduce((Q,Z)=>Q+Z,0)/$.length}function n3($,Q){let Z=m3[$],z=g3[$],X=f3[$],q=Q.filter((M)=>M!==null),K=q.length;if(K===0)return{axis:$,label:X,available:!1,higher_is_better:Z,note:"no runs recorded this metric"};if(K<2)return{axis:$,label:X,available:!0,higher_is_better:Z,data_points:K,latest:X$(q[K-1]),direction:"flat",improving:null,delta:0,earlier_mean:X$(q[0]),later_mean:X$(q[K-1]),insufficient:!0,note:"not enough history yet (need 2+ runs with this metric)"};let W=Math.floor(K/2),J=q.slice(0,W),U=q.slice(K-W),H=S0(J),Y=S0(U),B=Y-H,G;if(Math.abs(B)<=z)G="flat";else if(B>0)G="up";else G="down";let O;if(G==="flat")O=null;else O=G==="up"===Z;return{axis:$,label:X,available:!0,higher_is_better:Z,data_points:K,latest:X$(q[K-1]),direction:G,improving:O,delta:X$(B),earlier_mean:X$(H),later_mean:X$(Y),insufficient:!1}}function C0($){let Q=o3($),Z=Q.map((J)=>({run_id:J.run_id,generated_at:J.generated_at,council_pass_rate:J.council_pass_rate,gate_pass_rate:J.gate_pass_rate,iterations:J.iterations,interventions:J.interventions})),z={};for(let J of h$)z[J]=n3(J,Q.map((U)=>U[J]));let X=Q.length<2,q=h$.filter((J)=>z[J].available&&z[J].improving===!0),K=h$.filter((J)=>z[J].available&&z[J].improving===!1),W=[];if(X)W.push(`not enough history yet: ${Q.length} run(s) recorded, need 2+ to show a trend`);if(!z.interventions.available)W.push("intervention trend unavailable: no per-run intervention count in proof.json yet (axis lights up automatically once recorded)");return{schema_version:v3,generated_at:new Date().toISOString(),loki_dir:$,runs_count:Q.length,insufficient:X,axes:z,improving_count:q.length,regressing_count:K.length,improving_axes:q,regressing_axes:K,series:Z,notes:W}}function b0($){return JSON.stringify($,null,2)}function h0($,Q){let Z=O$($,"metrics"),z=O$(Z,"trust-trajectory.json");try{return D3(Z,{recursive:!0}),y3(z,JSON.stringify(Q,null,2)),z}catch{return null}}function a3($){if($==="up")return"up";if($==="down")return"down";return"flat"}function s3($){let Q=$.label??$.axis;if(!$.available)return`  ${(Q+":").padEnd(26)} no data`;let Z;if($.insufficient)Z="(need 2+ runs)";else if($.improving===!0)Z="improving";else if($.improving===!1)Z="regressing";else Z="stable";let z=$.higher_is_better?"higher better":"lower better",X=$.latest??"n/a";return`  ${(Q+":").padEnd(26)} ${a3($.direction).padEnd(5)} latest=${String(X).padEnd(7)} ${Z.padEnd(11)} [${z}]`}function y0($){let Q=[];if(Q.push(`Loki Mode Trust Trajectory  (snapshot at ${$.generated_at})`),Q.push(`Source: ${$.loki_dir}`),Q.push(`Runs analyzed: ${$.runs_count}`),Q.push(""),$.insufficient){if(Q.push("Not enough history yet."),Q.push("Trust trajectory needs 2+ recorded runs to show a direction."),Q.push("Each `loki start` run writes a proof-of-run; come back after the next run."),$.notes.length>0){Q.push(""),Q.push("Notes");for(let X of $.notes)Q.push(`  - ${X}`)}return Q.join(`
`)}Q.push("Is the agent earning autonomy on this repo?");for(let X of h$)if($.axes[X])Q.push(s3($.axes[X]));Q.push("");let{improving_count:Z,regressing_count:z}=$;if(Z&&!z)Q.push(`Overall: trending more trustworthy (${Z} axis improving).`);else if(z&&!Z)Q.push(`Overall: trust regressing (${z} axis regressing). Review recent runs.`);else if(Z||z)Q.push(`Overall: mixed (${Z} improving / ${z} regressing).`);else Q.push("Overall: stable.");if($.notes.length>0){Q.push(""),Q.push("Notes");for(let X of $.notes)Q.push(`  - ${X}`)}return Q.join(`
`)}var v3=1,h$,m3,g3,f3,D0;var v0=P(()=>{h$=["council_pass_rate","gate_pass_rate","iterations","interventions"],m3={council_pass_rate:!0,gate_pass_rate:!0,iterations:!1,interventions:!1},g3={council_pass_rate:0.01,gate_pass_rate:0.01,iterations:0.25,interventions:0.25},f3={council_pass_rate:"Council pass rate",gate_pass_rate:"Gate pass rate",iterations:"Iterations to completion",interventions:"Human interventions"},D0=["APPROVE","APPROVED","COMPLETE","PASS","PASSED"]});var m0={};b(m0,{runTrust:()=>t3});function t3($){let Q=!1;for(let X of $){if(X==="--help"||X==="-h"||X==="help")return process.stdout.write(r3),0;if(X==="--json"){Q=!0;continue}return process.stderr.write(`loki trust: unknown arg: ${X}
Run 'loki trust --help' for usage.
`),1}let Z=j(),z=C0(Z);return h0(Z,z),process.stdout.write(Q?b0(z)+`
`:y0(z)+`
`),0}var r3=`loki trust -- visible trust trajectory (R4)

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
`;var g0=P(()=>{v0();C()});import{closeSync as H1,fstatSync as i3,lstatSync as e3,mkdirSync as f0,openSync as u0,readSync as $8,renameSync as Q8,rmSync as c0,statSync as Z8,unlinkSync as p0,writeFileSync as z8,writeSync as X8}from"fs";import{dirname as l0}from"path";function A$($,Q){f0(l0($),{recursive:!0});let Z=`${$}.tmp.${process.pid}.${++K8}`;z8(Z,`${JSON.stringify(Q,null,2)}
`),Q8(Z,$)}async function d0($,Q){let Z=y$.get($)??Promise.resolve(),z=()=>{},X=new Promise((K)=>{z=K}),q=Z.catch(()=>{}).then(()=>X);y$.set($,q);try{return await Z.catch(()=>{}),await Q()}finally{if(z(),y$.get($)===q)y$.delete($)}}function V8($){return`${$}.lock`}function J8($){if(!Number.isFinite($)||$<=0)return!1;try{return process.kill($,0),!0}catch(Q){return Q?.code==="EPERM"}}function W8($){let Q=null;try{return f0(l0($),{recursive:!0}),Q=u0($,"wx"),X8(Q,`${process.pid}
`),Q}catch(Z){if(Q!==null){try{H1(Q)}catch{}try{p0($)}catch{}}if(Z?.code==="EEXIST")return null;throw Z}}function U8($,Q){let Z;try{Z=e3($)}catch{return!0}if(Z.isSymbolicLink())try{return p0($),!0}catch{return!1}let z;try{z=u0($,"r")}catch{return!0}try{let X=i3(z);if(Date.now()-X.mtimeMs<Q)return!1;let K=NaN;try{let W=Buffer.alloc(64),J=$8(z,W,0,64,0);K=Number.parseInt(W.subarray(0,J).toString("utf-8").trim(),10)}catch{}if(Number.isFinite(K)&&J8(K))return!1;try{if(Z8($).mtimeMs>X.mtimeMs)return!1}catch{return!0}try{c0($,{force:!0})}catch{}return!0}finally{try{H1(z)}catch{}}}function B1($,Q,Z={}){let z=Z.timeoutMs??1e4,X=Z.pollMs??25,q=Z.staleMs??30000,K=V8($),W=Date.now()+z,J=null,U=0,H=new Int32Array(new SharedArrayBuffer(4));while(J===null){if(J=W8(K),J!==null)break;if(Date.now()>W)throw Error(`withFileLockSync: timed out after ${z}ms acquiring ${K}`);if(U8(K,q))continue;let Y=Math.min(X*2**Math.min(U,4),q8);U+=1,Atomics.wait(H,0,0,Y)}try{return Q()}finally{try{H1(J)}catch{}try{c0(K,{force:!0})}catch{}}}var K8=0,y$,q8=50;var v$=P(()=>{y$=new Map});import{existsSync as K$,mkdirSync as G$,copyFileSync as s0,readFileSync as M1,readdirSync as H8,statSync as B8,writeFileSync as G8,renameSync as r0,appendFileSync as t0,rmSync as Y8}from"fs";import{join as m,dirname as m$}from"path";function T8($){let Q=n0.then($,$);return n0=Q.catch((Z)=>{console.warn("[checkpoint] serialized op rejected:",Z);return}),Q}function o($){return m($,"state","checkpoints")}function i0($){return m(o($),"index.jsonl")}async function O8($){let Q=await k(["git","rev-parse","HEAD"],{cwd:$,timeoutMs:5000});if(Q.exitCode!==0)return"no-git";return Q.stdout.trim()||"no-git"}async function A8($){let Q=await k(["git","branch","--show-current"],{cwd:$,timeoutMs:5000});if(Q.exitCode!==0)return"unknown";return Q.stdout.trim()||"unknown"}async function w8($){let Q=await k(["git","diff","--quiet"],{cwd:$,timeoutMs:5000}),Z=await k(["git","diff","--cached","--quiet"],{cwd:$,timeoutMs:5000}),z=Q.exitCode===1,X=Z.exitCode===1;return z||X}function _8($){let Q=m($,"state","orchestrator.json");if(!K$(Q))return"unknown";try{let z=JSON.parse(M1(Q,"utf-8")).currentPhase;return typeof z==="string"&&z.length>0?z:"unknown"}catch{return"unknown"}}function L8($,Q){for(let Z of I8){let z=m($,Z);if(!K$(z))continue;let X=m(Q,Z);G$(m$(X),{recursive:!0});try{s0(z,X)}catch{}}}function $6($,Q){G$(m$($),{recursive:!0});let Z=`${$}.tmp.${process.pid}.${++e0}`;G8(Z,Q),r0(Z,$)}function P8($){return JSON.stringify($,null,2)}function Q6($){return`{${[`"id": ${JSON.stringify($.id)}`,`"ts": ${JSON.stringify($.ts)}`,`"iter": ${JSON.stringify($.iter)}`,`"task": ${JSON.stringify($.task)}`,`"sha": ${JSON.stringify($.sha)}`].join(", ")}}`}async function j8($){return T8(()=>F8($))}async function F8($){let Q=$.lokiDirOverride??j(),Z=process.cwd(),z=o(Q);if(G$(z,{recursive:!0}),!$.forceCreate){if(!await w8(Z))return{created:!1,reason:"no uncommitted changes"}}let X=await O8(Z),q=await A8(Z),K=$.iteration??Number.parseInt(process.env.ITERATION_COUNT??"0",10),W=$.epochOverride??Math.floor(Date.now()/1000),J=`cp-${K}-${W}`,U=m(z,J);G$(U,{recursive:!0}),L8(Q,U);let H=new Date().toISOString().replace(/\.\d{3}Z$/,"Z"),Y=($.taskDescription??"task completed").slice(0,M8),B=$.provider??process.env.PROVIDER_NAME??"claude",G={id:J,timestamp:H,iteration:K,task_id:$.taskId??"unknown",task_description:Y,git_sha:X,git_branch:q,provider:B,phase:_8(Q)};$6(m(U,"metadata.json"),P8(G));let O={id:G.id,ts:G.timestamp,iter:G.iteration,task:G.task_description,sha:G.git_sha},M=i0(Q);return B1(M,()=>{t0(M,`${Q6(O)}
`)}),k8(Q),{created:!0,id:J,metadata:G,dir:U}}function T1($){let Q=o($);if(!K$(Q))return[];return H8(Q).filter((Z)=>Z.startsWith("cp-")).filter((Z)=>{try{return B8(m(Q,Z)).isDirectory()}catch{return!1}})}function O1($){return[...$].sort((Q,Z)=>{let z=a0(Q),X=a0(Z);return z-X})}function a0($){let Q=$.split("-");if(Q.length<3)return 0;let Z=Q[Q.length-1],z=Number.parseInt(Z??"0",10);return Number.isFinite(z)?z:0}function k8($){let Q=T1($);if(Q.length<=o0)return;let Z=O1(Q),z=Z.slice(0,Z.length-o0);for(let X of z)try{Y8(m(o($),X),{recursive:!0,force:!0})}catch{}R8($)}function R8($){let Q=O1(T1($)),Z=[];for(let q of Q){let K=m(o($),q,"metadata.json"),W=m(o($),q);if(!K$(K)){G1($,W,"missing_field","metadata.json");continue}try{let J=JSON.parse(M1(K,"utf-8")),U=z6(J,K);if(!U.ok){G1($,W,U.reason,U.field);continue}let H=U.value;Z.push(Q6({id:H.id,ts:H.timestamp,iter:H.iteration,task:H.task_description??"",sha:H.git_sha}))}catch{G1($,W,"invalid_type","metadata.json")}}let z=i0($),X=Z.length>0?`${Z.join(`
`)}
`:"";$6(z,X)}function G1($,Q,Z,z){let X=m($,"events.jsonl"),q={timestamp:new Date().toISOString(),type:"checkpoint.metadata.dropped",checkpoint_dir:Q,reason:Z,field:z};try{G$(m$(X),{recursive:!0}),B1(X,()=>{t0(X,`${JSON.stringify(q)}
`)})}catch{}}function A1($){let Q=$??j(),Z=O1(T1(Q)),z=[];for(let X of Z){let q=Z6(Q,X);if(q)z.push(q)}return z}function Z6($,Q){let Z=m(o($),Q,"metadata.json");if(!K$(Z))return null;try{let z=JSON.parse(M1(Z,"utf-8"));return x8(z,Z)}catch{return null}}function x8($,Q){let Z=z6($,Q);return Z.ok?Z.value:null}function z6($,Q){if($===null||typeof $!=="object")return console.warn(`[checkpoint] invalid metadata at ${Q}: not an object`),{ok:!1,reason:"invalid_type",field:"<root>"};let Z=$,z=["id","timestamp","task_id","task_description","git_sha","git_branch","provider","phase"];for(let X of z){if(!(X in Z))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "${X}" missing`),{ok:!1,reason:"missing_field",field:X};if(typeof Z[X]!=="string")return console.warn(`[checkpoint] invalid metadata at ${Q}: field "${X}" not a string`),{ok:!1,reason:"invalid_type",field:X}}if(!Object.prototype.hasOwnProperty.call(Z,"iteration"))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "iteration" missing`),{ok:!1,reason:"missing_field",field:"iteration"};if(typeof Z.iteration!=="number"||!Number.isFinite(Z.iteration))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "iteration" not a finite number`),{ok:!1,reason:"invalid_type",field:"iteration"};for(let X of N8){let q=Z[X];if(E8.test(q))return console.warn(`[checkpoint] invalid metadata at ${Q}: field "${X}" contains control characters`),{ok:!1,reason:"control_chars",field:X}}return{ok:!0,value:{id:Z.id,timestamp:Z.timestamp,iteration:Z.iteration,task_id:Z.task_id,task_description:Z.task_description,git_sha:Z.git_sha,git_branch:Z.git_branch,provider:Z.provider,phase:Z.phase}}}function w1($,Q){if(!S8.test($))throw new X6($);let Z=Q??j(),z=m(o(Z),$);if(!K$(z))throw new Y1($);let X=Z6(Z,$);if(!X)throw new Y1($);return X}function K6($,Q){let Z=w1($,Q),z=Q??j(),X=m(o(z),$),q=[];for(let K of D8){let W=m(X,K);if(!K$(W))continue;q.push({from:W,to:m(z,K)})}return{id:$,metadata:Z,restore:q}}function C8($){let Q=[],Z=0;for(let z of $.restore)try{G$(m$(z.to),{recursive:!0});let X=`${z.to}.tmp.${process.pid}.${++e0}`;s0(z.from,X),r0(X,z.to),Z+=1}catch(X){Q.push(`${z.from} -> ${z.to}: ${X.message}`)}return{restored:Z,errors:Q}}async function q6($,Q,Z=!1){let z=null;try{let q=await j8({taskDescription:`pre-rollback snapshot (before restoring ${$.id})`,taskId:"rollback",forceCreate:!0,lokiDirOverride:Q});if(q.created)z=q.id}catch(q){let K=q instanceof Error?q.message:String(q);if(!Z)throw Error("pre-rollback snapshot failed ("+K+"); aborting rollback to preserve current state. Re-run with force to roll back anyway without a safety snapshot.");console.warn("[checkpoint] pre-rollback snapshot failed; proceeding due to force:",K)}let X=C8($);return{preRollbackSnapshotId:z,restored:X.restored,errors:X.errors}}var o0=50,M8=200,n0,I8,e0=0,E8,N8,S8,Y1,X6,D8;var V6=P(()=>{C();d();v$();n0=Promise.resolve();I8=["state/orchestrator.json","autonomy-state.json","queue/pending.json","queue/completed.json","queue/in-progress.json","queue/current-task.json","CONTINUITY.md"];E8=/[\x00-\x08\x0a-\x1f\x7f-\x9f]/,N8=["id","task_id","git_sha","git_branch","provider","phase"];S8=/^[a-zA-Z0-9_-]+$/;Y1=class Y1 extends Error{id;constructor($){super(`Checkpoint not found: ${$}`);this.id=$;this.name="CheckpointNotFoundError"}};X6=class X6 extends Error{id;constructor($){super(`Invalid checkpoint ID: must be alphanumeric, hyphens, underscores only (got: ${$})`);this.id=$;this.name="InvalidCheckpointIdError"}};D8=["state/orchestrator.json","queue/pending.json","queue/completed.json","queue/in-progress.json","queue/current-task.json","CONTINUITY.md"]});var U6={};b(U6,{runRollback:()=>b8});async function b8($){let Q=$[0],Z=$.slice(1);if(Q===void 0||Q==="help"||Q==="--help"||Q==="-h")return process.stdout.write(J6),Q===void 0?1:0;switch(Q){case"list":{let z=[...A1()].reverse();if(z.length===0)return process.stdout.write(`${_}No checkpoints found.${V}
`),0;process.stdout.write(`${R}Checkpoints${V} (${z.length}, newest first):
`);for(let X of z)process.stdout.write(`  ${I}${X.id}${V}  iter=${X.iteration}  ${X.git_branch||"(no branch)"}@${(X.git_sha||"").slice(0,7)}  ${X.timestamp}
`);return 0}case"show":{let z=Z[0];if(!z)return process.stderr.write(`${T}Missing checkpoint id.${V} Use \`loki rollback list\`.
`),2;try{let X=w1(z);return process.stdout.write(`${JSON.stringify(X,null,2)}
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
`;var H6=P(()=>{V6();c()});function h8(){return process.env.LOKI_TIER||"oss"}function B6($){let Q=h8();if(Q==="oss")return{allowed:!0,notes:[]};if(!process.env.LOKI_LICENSE_KEY)return{allowed:!1,notes:[`${_}LOKI_TIER='${Q}' requested but no LOKI_LICENSE_KEY set.${V}`,`Hosted/enterprise license verification is not available yet (capability: ${$}).`,"OSS users: leave LOKI_TIER unset (or 'oss') -- everything stays free."]};return{allowed:!0,notes:[`${_}LOKI_LICENSE_KEY set but the verification backend is not available yet (R9 seam).${V}`]}}var G6=P(()=>{c()});var M6={};b(M6,{runProof:()=>r8});import{existsSync as w$,readdirSync as y8,readFileSync as Y6,mkdtempSync as v8,copyFileSync as m8,rmSync as g8}from"fs";import{join as e}from"path";import{tmpdir as f8}from"os";import{createInterface as u8}from"readline";import{readFile as c8}from"fs/promises";function $$($){return $&&typeof $==="object"?$:{}}function p($){return $===void 0||$===null?"-":String($)}function _$(){return e(j(),"proofs")}function _1($){let Q=e(_$(),$,"proof.json");if(!w$(Q))return null;try{return JSON.parse(Y6(Q,"utf8"))}catch{return{}}}function i($,Q){return $.length>=Q?$:$+" ".repeat(Q-$.length)}function l8(){let $=_$();if(!w$($))return process.stdout.write(`${_}No proofs found.${V} Run 'loki start' to generate one.
`),0;let Q=[];try{Q=y8($,{withFileTypes:!0}).filter((z)=>z.isDirectory()).map((z)=>z.name).sort()}catch{Q=[]}let Z=[];for(let z of Q){let X=e($,z,"proof.json");if(!w$(X))continue;let q={};try{q=JSON.parse(Y6(X,"utf8"))}catch{q={}}let K=p(q.run_id),W=p(q.generated_at),J=p($$(q.council).final_verdict),U=p($$(q.cost).usd),H=p($$(q.files_changed).count);Z.push(`${i(K,26)}  ${i(W,20)}  ${i(J,10)}  ${i(U,9)}  ${H}`)}if(Z.length===0)return process.stdout.write(`${_}No proofs found.${V} Run 'loki start' to generate one.
`),0;process.stdout.write(`${i("RUN_ID",26)}  ${i("GENERATED_AT",20)}  ${i("VERDICT",10)}  ${i("COST_USD",9)}  FILES
`);for(let z of Z)process.stdout.write(`${z}
`);return 0}function d8($){if(!$)return process.stderr.write(`${T}Missing proof id.${V} Use 'loki proof list'.
`),2;let Q=_1($);if(Q===null)return process.stderr.write(`${T}Proof not found: ${$}${V}
`),process.stderr.write(`Use 'loki proof list' to see available proofs.
`),1;return process.stdout.write(`${JSON.stringify(Q,null,2)}
`),0}async function o8($){if(!$)return process.stderr.write(`${T}Missing proof id.${V} Use 'loki proof list'.
`),2;let Q=e(_$(),$,"index.html");if(!w$(Q))return process.stderr.write(`${T}Proof page not found: ${$}/index.html${V}
`),process.stderr.write(`Use 'loki proof list' to see available proofs.
`),1;process.stdout.write(`${S}Opening proof: ${Q}${V}
`);for(let Z of["open","xdg-open","start"])try{if((await k([Z,Q],{timeoutMs:5000})).exitCode===0)return 0}catch{}return process.stdout.write(`
Could not detect browser opener.
`),process.stdout.write(`Please open in browser: ${Q}
`),0}function n8($){return new Promise((Q)=>{let Z=u8({input:process.stdin,output:process.stdout});Z.question($,(z)=>{Z.close();let X=z.trim().toLowerCase();Q(X==="y"||X==="yes")})})}async function a8($,Q,Z){let z=B6("hosted_publish");for(let B of z.notes)process.stderr.write(`${B}
`);let X=process.env.LOKI_HOSTED_ENDPOINT||"";if(!X)return process.stderr.write(`${_}Hosted publishing backend not available.${V}
`),process.stderr.write(`There is no official Loki hosted service yet (R9 ships the seam, not a live backend).
`),process.stderr.write(`To publish to your own hosted endpoint, set LOKI_HOSTED_ENDPOINT to its URL.
`),process.stderr.write(`Or publish to a GitHub Gist instead: loki proof share ${$}
`),1;let q=_1($);if(q){if($$(q.redaction).applied!==!0)return process.stderr.write(`${T}Refusing to publish: proof redaction was not confirmed applied.${V}
`),process.stderr.write(`Regenerate the proof (LOKI_PROOF=1) so the redactor runs, then retry.
`),1}process.stdout.write(`${R}Publishing proof '${$}' to hosted endpoint${V}
`),process.stdout.write(`  endpoint: ${X}
`),process.stdout.write(`  payload:  ${Q} (already redacted by the generator)

`);let K;try{K=await c8(Q)}catch{return process.stderr.write(`${T}Could not read proof page: ${Q}${V}
`),1}let W={"Content-Type":"text/html","X-Loki-Proof-Id":$},J=process.env.LOKI_LICENSE_KEY||"";if(J)W.Authorization=`Bearer ${J}`;let U;try{U=await fetch(X,{method:"POST",headers:W,body:new Uint8Array(K)})}catch(B){return process.stderr.write(`${T}Failed to reach hosted endpoint: ${String(B.message||B)}${V}
`),process.stderr.write(`Check LOKI_HOSTED_ENDPOINT or publish to a gist: loki proof share ${$}
`),1}let H=await U.text();if(!U.ok){if(process.stderr.write(`${T}Hosted endpoint returned HTTP ${U.status}.${V}
`),H)process.stderr.write(`Response:
`),process.stderr.write(`${H.slice(0,500)}
`);return process.stderr.write(`Nothing was published. Or publish to a gist: loki proof share ${$}
`),1}let Y="";try{let B=JSON.parse(H);if(B&&typeof B==="object"){let G=B.url??B.public_url;if(typeof G==="string")Y=G}}catch{}if(Y)process.stdout.write(`${S}Published: ${Y}${V}
`);else process.stdout.write(`${S}Published to ${X} (HTTP ${U.status}).${V}
`),process.stdout.write(`The endpoint did not return a 'url' field; check your endpoint's response.
`);return 0}async function s8($){let Q="",Z=!1,z="--public",X=!1;for(let M of $)if(M==="--yes"||M==="-y")Z=!0;else if(M==="--private")z="";else if(M==="--public")z="--public";else if(M==="--hosted")X=!0;else if(M.startsWith("-"))return process.stderr.write(`${T}Unknown option: ${M}${V}
`),1;else Q=M;if(!Q)return process.stderr.write(`${T}Missing proof id.${V} Use 'loki proof list'.
`),2;let q=e(_$(),Q,"index.html");if(!w$(q))return process.stderr.write(`${T}Proof page not found: ${Q}/index.html${V}
`),process.stderr.write(`Use 'loki proof list' to see available proofs.
`),1;if(X)return a8(Q,q,e(_$(),Q,"proof.json"));if((await k(["gh","--version"],{timeoutMs:5000})).exitCode!==0)return process.stderr.write(`${T}gh CLI not found${V}
`),process.stderr.write(`Install the GitHub CLI to publish a proof:
`),process.stderr.write(`  brew install gh        # macOS
`),process.stderr.write(`  sudo apt install gh    # Ubuntu/Debian
`),process.stderr.write(`  https://cli.github.com # Other platforms
`),1;if((await k(["gh","auth","status"],{timeoutMs:1e4})).exitCode!==0)return process.stderr.write(`${T}GitHub CLI not authenticated${V}
`),process.stderr.write(`Run 'gh auth login' to authenticate, then try again.
`),1;let J=z===""?"secret":"public";process.stdout.write(`${R}Publishing proof '${Q}' as a ${J} GitHub Gist${V}

`),process.stdout.write(`What will be shared:
`),process.stdout.write(`  - ${q}
`);let U=_1(Q);if(U){let M=p($$(U.cost).usd),L=p($$(U.files_changed).count),x=p($$(U.council).final_verdict),v=$$(U.redaction);process.stdout.write(`  - cost.usd:        ${M}
`),process.stdout.write(`  - files_changed:   ${L}
`),process.stdout.write(`  - council verdict: ${x}
`),process.stdout.write(`  - redaction:       applied=${p(v.applied)} rules_version=${p(v.rules_version)} redactions_count=${p(v.redactions_count)}
`)}if(process.stdout.write(`
${_}Secrets, API keys, tokens, env values, and absolute paths have already been stripped by the generator.${V}

`),!Z){if(!await n8(`Publish this proof to a ${J} gist? [y/N] `))return process.stdout.write(`Aborted. Nothing was published.
`),0}let H=v8(e(f8(),"loki-proof-")),Y=e(H,"index.html");m8(q,Y),process.stdout.write(`Uploading proof page...
`);let B=`Loki Mode proof-of-run ${Q}`,G=["gh","gist","create",Y,"--desc",B];if(z!=="")G.push(z);let O=await k(G,{timeoutMs:60000});try{g8(H,{recursive:!0,force:!0})}catch{}if(O.exitCode!==0)return process.stderr.write(`${T}Failed to create gist${V}
`),process.stderr.write(`${O.stdout}${O.stderr}
`),1;return process.stdout.write(`${S}Shared: ${O.stdout.trim()}${V}
`),0}async function r8($){let Q=$[0],Z=$.slice(1);if(Q===void 0||Q==="help"||Q==="--help"||Q==="-h")return process.stdout.write(p8),Q===void 0?1:0;switch(Q){case"list":return l8();case"show":return d8(Z[0]);case"open":return o8(Z[0]);case"share":return s8(Z);default:return process.stderr.write(`${T}Unknown subcommand: ${Q}${V}
`),process.stderr.write(`Run 'loki proof --help' for usage.
`),1}}var p8;var T6=P(()=>{C();d();c();G6();p8=`${R}loki proof${V} - inspect and share proof-of-run artifacts

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
`});var L6={};b(L6,{runCrash:()=>K7});import{existsSync as A6,readdirSync as t8,readFileSync as i8}from"fs";import{join as w6}from"path";function I$($){return $===void 0||$===null?"-":String($)}function g$($,Q){return $.length>=Q?$:$+" ".repeat(Q-$.length)}function _6(){return w6(j(),"crash")}function I1(){let $=_6();if(!A6($))return[];try{return t8($,{withFileTypes:!0}).filter((Q)=>Q.isFile()&&Q.name.endsWith(".json")).map((Q)=>Q.name.slice(0,-5)).sort()}catch{return[]}}function $7($){if($.length===0)return!1;if($.includes("/")||$.includes("\\"))return!1;if($.includes(".."))return!1;return!0}function f$($){if(!$7($))return null;let Q=w6(_6(),`${$}.json`);if(!A6(Q))return null;try{return JSON.parse(i8(Q,"utf8"))}catch{return{}}}function Q7(){let $=I1();if($.length===0)return process.stdout.write(`${_}No crash reports found.${V} Nothing has been captured in .loki/crash/.
`),0;process.stdout.write(`${g$("ID",40)}  ${g$("CAPTURED_AT",22)}  ERROR_CLASS
`);for(let Q of $){let Z=f$(Q)??{},z=I$(Z.fingerprint),X=I$(Z.captured_at),q=I$(Z.error_class),K=z!=="-"?z:Q;process.stdout.write(`${g$(K,40)}  ${g$(X,22)}  ${q}
`)}return process.stdout.write(`
${$.length} report(s). Run 'loki crash show <id>' to inspect, 'loki crash submit' to get a prefilled GitHub issue URL.
`),0}function I6($){let Q=f$($);if(Q!==null)return{id:$,report:Q};for(let Z of I1()){let z=f$(Z);if(z&&String(z.fingerprint??"")===$)return{id:Z,report:z}}return null}function Z7($){if(!$)return process.stderr.write(`${T}Missing crash id.${V} Use 'loki crash' to list reports.
`),2;let Q=I6($);if(Q===null)return process.stderr.write(`${T}Crash report not found: ${$}${V}
`),process.stderr.write(`Use 'loki crash' to see available reports.
`),1;return process.stdout.write(`${JSON.stringify(Q.report,null,2)}
`),0}function z7($){let Q=I$($.error_class),Z=I$($.fingerprint),z=Z!=="-"?Z.slice(0,12):"unknown",X=`crash: ${Q} (${z})`,K=["Anonymous crash report captured by Loki Mode (scrubbed, whitelist-only).","","Scrubbed payload:","```json",JSON.stringify($,null,2),"```","","Nothing was sent automatically. This issue is submitted manually by me."].join(`
`),W=new URLSearchParams({title:X,body:K});return`${e8}?${W.toString()}`}function X7($){let Q;if($){if(Q=I6($),Q===null)return process.stderr.write(`${T}Crash report not found: ${$}${V}
`),process.stderr.write(`Use 'loki crash' to see available reports.
`),1}else{let Z=I1();if(Z.length===0)return process.stdout.write(`${_}No crash reports found.${V} Nothing to submit.
`),0;let z=Z[Z.length-1],X=f$(z)??{};Q={id:z,report:X}}return process.stdout.write(`${R}Scrubbed payload (this is the ENTIRE report):${V}
`),process.stdout.write(`${JSON.stringify(Q.report,null,2)}

`),process.stdout.write(`${_}Nothing is sent automatically in this version.${V} Loki Mode never transmits crash data on its own.
`),process.stdout.write(`To submit manually, open this prefilled GitHub issue and review it first:

`),process.stdout.write(`  ${I}${z7(Q.report)}${V}

`),process.stdout.write(`${S}The payload above is exactly what the URL contains.${V}
`),process.stdout.write(`See docs/PRIVACY.md for what is and is not collected.
`),0}async function K7($){let Q=$[0];switch(Q){case void 0:case"list":return Q7();case"--help":case"-h":case"help":return process.stdout.write(O6),0;case"show":return Z7($[1]);case"submit":return X7($[1]);default:return process.stderr.write(`${T}Unknown crash subcommand: ${Q}${V}
`),process.stdout.write(O6),2}}var e8="https://github.com/asklokesh/loki-mode/issues/new",O6;var P6=P(()=>{C();c();O6=`${R}loki crash${V} - inspect and manually submit local crash reports

Usage: loki crash [subcommand] [args]

Subcommands:
  (none) | list        List crash reports in .loki/crash/
  show <id>            Pretty-print one scrubbed crash report
  submit [<id>]        Print the scrubbed payload and a prefilled GitHub
                       issue URL for manual submission

Crash reports are anonymous, scrubbed, and stored locally only. Nothing is
sent automatically in this version. See docs/PRIVACY.md.
`});var R6={};b(R6,{runWiki:()=>U7});import{existsSync as L1,readFileSync as j6}from"fs";import{join as P1,resolve as q7}from"path";function J7(){return P1(process.cwd(),".loki","wiki")}function W7($){let Q="";for(let X of $){if(X==="--help"||X==="-h")return process.stdout.write(`Usage: loki wiki show [section]
Sections: architecture, modules, data-flow
`),0;if(X.startsWith("-"))return process.stderr.write(`${T}Unknown option: ${X}${V}
`),1;Q=X}let Z=J7();if(!L1(Z))return process.stderr.write(`${_}No wiki found. Run 'loki wiki generate' first.${V}
`),1;if(Q){if(!V7.has(Q))return process.stderr.write(`${T}No such section: ${Q} (try: architecture, modules, data-flow)${V}
`),1;let X=P1(Z,`${Q}.md`);if(!L1(X))return process.stderr.write(`${T}Section not generated: ${Q}${V}
`),1;return process.stdout.write(j6(X,"utf8")),0}let z=P1(Z,"index.md");if(!L1(z))return process.stderr.write(`${T}Wiki index not found. Run 'loki wiki generate'.${V}
`),1;return process.stdout.write(j6(z,"utf8")),0}async function k6($,Q){let Z=q7(g,"autonomy","loki"),z=3600000,X=Bun.spawn({cmd:[Z,"wiki",$,...Q],stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,LOKI_LEGACY_BASH:"1"}}),q=setTimeout(()=>{try{X.kill("SIGKILL")}catch{}},3600000);try{return await X.exited}finally{clearTimeout(q)}}async function U7($){let Q=$[0],Z=$.slice(1);switch(Q){case void 0:case"help":case"--help":case"-h":return process.stdout.write(F6),0;case"show":return W7(Z);case"generate":return k6("generate",Z);case"ask":return k6("ask",Z);default:return process.stderr.write(`${T}Unknown wiki command: ${Q}${V}
`),process.stdout.write(F6),1}}var F6,V7;var x6=P(()=>{C();c();F6=`${R}loki wiki${V} - Auto-generated, cited codebase wiki + Q&A

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
`,V7=new Set(["architecture","modules","data-flow"])});var F1={};b(F1,{renderFindingsForPrompt:()=>M7,loadPreviousFindings:()=>j1,findLatestReviewDir:()=>C6,_parseReviewerOutputForTests:()=>T7});import{existsSync as N6,readFileSync as E6,readdirSync as S6,statSync as H7}from"fs";import{join as u$}from"path";function Y7($){let Q=$.toLowerCase();if(Q==="critical")return"Critical";if(Q==="high")return"High";if(Q==="medium")return"Medium";return"Low"}function D6($,Q,Z,z){let X=[],q=$.split(/\r?\n/);for(let K of q){let W=K.trim();if(W.length===0)continue;let J=W.replace(/^[-*]\s*/,""),U=B7.exec(J);if(!U||!U[1]||!U[2])continue;let H=Y7(U[1]),Y=U[2].trim(),B=G7.exec(Y),G=B&&B[1]?B[1]:null,O=B&&B[2]?Number.parseInt(B[2],10):null;X.push({reviewId:Z,iteration:z,reviewer:Q,severity:H,description:Y,file:G,line:Number.isFinite(O)?O:null,raw:W})}return X}function C6($,Q){let Z=u$($,"quality","reviews");if(!N6(Z))return null;let z;try{z=S6(Z)}catch{return null}let X=Q===void 0?z.filter((W)=>W.startsWith("review-")):z.filter((W)=>W.endsWith(`-${Q}`)&&W.startsWith("review-"));if(X.length===0)return null;X.sort();let q=X[X.length-1];if(!q)return null;let K=u$(Z,q);try{if(!H7(K).isDirectory())return null}catch{return null}return K}function j1($,Q){let Z=C6($,Q);if(Z===null)return{reviewDir:null,reviewId:null,iteration:null,findings:[]};let z=null,X=null,q=u$(Z,"aggregate.json");if(N6(q))try{let U=E6(q,"utf-8"),H=JSON.parse(U);if(typeof H.review_id==="string")z=H.review_id;if(typeof H.iteration==="number")X=H.iteration}catch{}let K;try{K=S6(Z)}catch{return{reviewDir:Z,reviewId:z,iteration:X,findings:[]}}let W=new Set(["diff.txt","files.txt","anti-sycophancy.txt"]),J=[];for(let U of K){if(!U.endsWith(".txt"))continue;if(W.has(U))continue;if(U.endsWith("-prompt.txt"))continue;let H=U.replace(/\.txt$/,""),Y;try{Y=E6(u$(Z,U),"utf-8")}catch{continue}J.push(...D6(Y,H,z??"",X??-1))}return{reviewDir:Z,reviewId:z,iteration:X,findings:J}}function M7($){if($.length===0)return"";let Q=["Critical","High","Medium","Low"],Z=new Map;for(let X of Q)Z.set(X,[]);for(let X of $){let q=Z.get(X.severity);if(q)q.push(X)}let z=[];z.push("PREVIOUS REVIEWER FINDINGS (must address each, or supply counter-evidence in .loki/state/counter-evidence-<iter>.json):");for(let X of Q){let q=Z.get(X)??[];if(q.length===0)continue;z.push(`  [${X}] (${q.length}):`);for(let K of q){let W=K.file?` (${K.file}${K.line!==null?":"+K.line:""})`:"";z.push(`    - ${K.description}${W} -- via ${K.reviewer}`)}}return z.join(`
`)}function T7($,Q,Z="review-test",z=0){return D6($,Q,Z,z)}var B7,G7;var c$=P(()=>{B7=/\[(Critical|High|Medium|Low)\]\s*(.+)/i,G7=/([\w.\-/]+\.[a-zA-Z]+):(\d+)/});import{existsSync as O7}from"fs";import{join as A7}from"path";async function b6($,Q){let Z=A7($,"memory");if(!O7(Z))return{stored:!1,reason:"memory dir not initialized"};let z=Math.max(0,Math.floor(Q.durationSeconds??0)),X={_LOKI_PROJECT_DIR:g,_LOKI_TARGET_DIR:process.cwd(),_LOKI_TASK_ID:Q.taskId,_LOKI_OUTCOME:Q.outcome,_LOKI_PHASE:Q.phase,_LOKI_GOAL:Q.goal,_LOKI_DURATION:String(z),_LOKI_LOKI_DIR:$},K=await z$(`
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
`,{env:X,timeoutMs:15000});if(K.exitCode===127)return{stored:!1,reason:"python3 not found"};let W=K.stdout.trim();if(W==="OK")return{stored:!0,reason:"stored"};if(W.startsWith("ERR:"))return{stored:!1,reason:W.replace(/^ERR:/,"")};return{stored:!1,reason:K.stderr.trim()||"unknown"}}var h6=P(()=>{V$();C()});var g6={};b(g6,{loadLearnings:()=>k1,appendLearning:()=>L$,appendFromGateFailure:()=>k7});import{existsSync as w7,readFileSync as _7}from"fs";import{join as y6}from"path";import{createHash as I7}from"crypto";function v6($){return y6($,L7)}function P7($){if($===null||typeof $!=="object")return!1;let Q=$;return typeof Q.id==="string"&&typeof Q.timestamp==="string"&&typeof Q.iteration==="number"&&typeof Q.trigger==="string"&&typeof Q.rootCause==="string"&&typeof Q.fix==="string"&&typeof Q.preventInFuture==="string"&&typeof Q.evidence==="object"&&Q.evidence!==null}function m6($){if(!w7($))return{version:1,learnings:[]};try{let Q=_7($,"utf-8"),Z=JSON.parse(Q);if(Z.version===1&&Array.isArray(Z.learnings))return{version:1,learnings:Z.learnings.filter(P7)}}catch{}return{version:1,learnings:[]}}function j7($,Q){return I7("sha256").update(`${$}\x00${Q}`).digest("hex").slice(0,16)}async function L$($,Q,Z={}){let z=j7(Q.trigger,Q.rootCause),X=new Date().toISOString(),q={id:z,timestamp:X,...Q},K=v6($);if(await d0(K,()=>{let J=m6(K),U=J.learnings.findIndex((H)=>H.id===z);if(U>=0){let H=J.learnings[U];J.learnings[U]={...H,timestamp:X,iteration:q.iteration}}else J.learnings.push(q);A$(K,J)}),Z.episodeBridge!==null&&(Z.episodeBridge!==void 0||process.env.LOKI_AUTO_LEARNINGS_EPISODE==="1")){let J=Z.episodeBridge??b6,U=Z.bridgeFailureLog??F7;try{let H=await J($,{taskId:`learning-${z}`,outcome:"failure",phase:"VERIFY",goal:`${Q.trigger}: ${Q.rootCause}`});if(H&&!H.stored){if(!new Set(["memory dir not initialized","stub"]).has(H.reason))U(`episode_bridge skipped: ${H.reason}`)}}catch(H){U(`episode_bridge threw: ${H.message}`)}}return q}function F7($){process.stderr.write(`[learnings_writer] ${$}
`)}async function k7($,Q,Z,z={}){let X=`[${Z.severity}] ${Z.description}`;return L$($,{iteration:Q,trigger:"gate_failure",rootCause:X,fix:"pending: dev agent must address in next iteration or supply counter-evidence",preventInFuture:"if this finding recurs, lower its severity threshold or add a regression test",evidence:{reviewId:Z.reviewId,file:Z.file??void 0,line:Z.line??void 0,severity:Z.severity,reviewer:Z.reviewer}},z)}function k1($){return m6(v6($))}var L7;var p$=P(()=>{v$();h6();L7=y6("state","relevant-learnings.json")});var u6={};b(u6,{runOverrideCouncil:()=>D7,recordOverrideOutcome:()=>C7,loadCounterEvidence:()=>S7,canonicalFindingId:()=>R1,DEFAULT_OVERRIDE_JUDGES:()=>f6});import{existsSync as R7,readFileSync as x7}from"fs";import{join as E7}from"path";function S7($,Q){let Z=E7($,"state",`counter-evidence-${Q}.json`);if(!R7(Z))return null;try{let z=x7(Z,"utf-8"),X=JSON.parse(z);if(typeof X.iteration!=="number")return null;let q=Array.isArray(X.evidence)?X.evidence:[],K=[];for(let W of q){if(typeof W!=="object"||W===null)continue;let J=W;if(typeof J.findingId!=="string")continue;if(typeof J.claim!=="string")continue;let U=J.proofType;if(typeof U!=="string"||!N7.has(U))continue;let H=U,Y=Array.isArray(J.artifacts)?J.artifacts:[];K.push({findingId:J.findingId,claim:J.claim,proofType:H,artifacts:Y.filter((B)=>typeof B==="string")})}return{iteration:X.iteration,evidence:K}}catch{return null}}async function D7($,Q,Z,z={}){let X=z.judges??f6,q=new Set,K=new Set,W={},J=new Map;for(let U of Q.evidence)J.set(U.findingId,U);for(let U of $){let H=R1(U),Y=J.get(H);if(!Y){K.add(H);continue}let B=await Promise.all(X.map((O)=>Z({finding:U,evidence:Y,judge:O})));if(W[H]=B,B.filter((O)=>O.verdict==="APPROVE_OVERRIDE").length>=2)q.add(H);else K.add(H)}return{approvedFindingIds:q,rejectedFindingIds:K,votes:W}}function R1($){let Q=$.raw.slice(0,80).replace(/\s+/g," ").trim();return`${$.reviewer}::${Q}`}async function C7($,Q,Z,z,X={}){let q={episodeBridge:X.episodeBridge===void 0?null:X.episodeBridge};for(let K of z){let W=R1(K);if(Z.approvedFindingIds.has(W))await L$($,{iteration:Q,trigger:"override_approved",rootCause:`[${K.severity}] ${K.description}`,fix:"override council approved counter-evidence; finding lifted",preventInFuture:"if this reviewer/file pair recurs, narrow the reviewer's selector OR add a baseline doc",evidence:{findingId:W,reviewId:K.reviewId,file:K.file??void 0,line:K.line??void 0,severity:K.severity,reviewer:K.reviewer}},q);else if(Z.rejectedFindingIds.has(W))await L$($,{iteration:Q,trigger:"override_rejected",rootCause:`[${K.severity}] ${K.description}`,fix:"override council rejected -- dev agent must fix the finding",preventInFuture:"address this finding in the next iteration",evidence:{findingId:W,reviewId:K.reviewId,file:K.file??void 0,line:K.line??void 0,severity:K.severity,reviewer:K.reviewer}},q)}}var N7,f6;var c6=P(()=>{p$();N7=new Set(["file-exists","test-passes","grep-miss","reviewer-misread","duplicate-code-path","out-of-scope"]);f6=["judge-primary","judge-secondary","judge-tertiary"]});var d6={};b(d6,{writeEscalationHandoff:()=>d7,renderHandoff:()=>p6,readLatestHandoff:()=>o7});import{existsSync as b7,mkdirSync as h7,readdirSync as y7,readFileSync as v7,renameSync as m7,writeFileSync as g7}from"fs";import{dirname as f7,join as l$}from"path";function u7(){return new Date().toISOString()}function c7($){let Q=$.file?` (${$.file}${$.line!==null?":"+$.line:""})`:"";return`  - [${$.severity}] ${$.description}${Q} -- ${$.reviewer}`}function p7($){let Q=$.evidence,Z=Q.file?` ${Q.file}${Q.line!==void 0?":"+Q.line:""}`:"";return`  - **${$.trigger}** (iter ${$.iteration})${Z}: ${$.rootCause}`}function p6($,Q,Z){let z=[];if(z.push(`# Loki escalation handoff -- ${u7()}`),z.push(""),z.push(`Gate **${$.gateName}** has failed ${$.consecutiveFailures} consecutive times at iteration ${$.iteration}.`),z.push(""),z.push(`Reason: ${$.detail}`),z.push(""),Q.length>0){z.push(`## Outstanding findings (${Q.length})`),z.push("");for(let X of Q)z.push(c7(X));z.push("")}else z.push("## Outstanding findings"),z.push(""),z.push("(no per-finding records captured -- gate failed without populating reviewer outputs)"),z.push("");if(Z.length>0){z.push(`## Recent learnings (${Math.min(Z.length,10)})`),z.push("");for(let X of Z.slice(-10))z.push(p7(X));z.push("")}return z.push("## What the human must decide"),z.push(""),z.push("- Approve override? Write `.loki/state/counter-evidence-<iter>.json` with one entry per finding to dispute, then `rm .loki/PAUSE` to resume."),z.push("- Disable a gate? Set `LOKI_GATE_<NAME>=false` in env (see skills/quality-gates.md)."),z.push("- Tweak escalation? Set `LOKI_GATE_PAUSE_LIMIT` or `LOKI_GATE_ESCALATE_LIMIT`."),z.push("- Roll back? Switch to `LOKI_LEGACY_BASH=1` and re-run; the bash route does not consult this handoff doc."),z.push(""),z.push("To resume: address the findings (or supply counter-evidence) and `rm .loki/PAUSE`."),z.join(`
`)}function l7($,Q){h7(f7($),{recursive:!0});let Z=`${$}.tmp.${process.pid}.${++l6}`;g7(Z,Q),m7(Z,$)}function d7($,Q,Z={}){let z=Z.findings??j1($,Q.iteration).findings,X=Z.learnings??k1($).learnings,q=p6(Q,z,X),K=(Z.now?.()??new Date).toISOString().replace(/[-:.]/g,""),W=l$($,"escalations"),J=++l6,U=l$(W,`handoff-${K}-${process.pid}-${J}-${Q.gateName}.md`);return l7(U,q),{path:U,bytes:q.length}}function o7($){let Q=l$($,"escalations");if(!b7(Q))return null;let Z;try{Z=y7(Q).filter((q)=>q.endsWith(".md"))}catch{return null}if(Z.length===0)return null;Z.sort();let z=Z[Z.length-1];if(!z)return null;let X=l$(Q,z);try{return{path:X,body:v7(X,"utf-8")}}catch{return null}}var l6=0;var o6=P(()=>{c$();p$()});var n6={};b(n6,{runInternalPhase1Hooks:()=>i7,_resolveForTests:()=>t7,_internalPhase1HooksHelp:()=>ZZ});import{existsSync as n7,mkdirSync as a7,readdirSync as s7,statSync as r7}from"fs";import{join as P$,resolve as t7}from"path";async function i7($){let[Q,...Z]=$;switch(Q){case void 0:case"help":case"--help":case"-h":return process.stdout.write(x1),Q===void 0?1:0;case"reflect":return e7(Z);case"override":return $Z(Z);case"handoff":return QZ(Z);default:return process.stderr.write(`Unknown subcommand: ${Q}
`),process.stderr.write(x1),2}}async function e7($){let Q=E1($[0]);if(Q===null)return process.stderr.write(`reflect: missing or invalid <iter>
`),2;let Z=j();try{let X=(await Promise.resolve().then(() => (c$(),F1))).loadPreviousFindings(Z,Q);if(X.findings.length===0)return process.stdout.write(`reflect: no findings for iter ${Q} (nothing to do)
`),0;let q=P$(Z,"state");a7(q,{recursive:!0}),A$(P$(q,`findings-${Q}.json`),{review_id:X.reviewId,iteration:Q,findings:X.findings});let K=await Promise.resolve().then(() => (p$(),g6)),W=0;if(process.env.LOKI_AUTO_LEARNINGS!=="0"){for(let J of X.findings)if(J.severity==="Critical"||J.severity==="High")await K.appendFromGateFailure(Z,Q,J,{episodeBridge:null}),W+=1}return process.stdout.write(`reflect: persisted ${X.findings.length} findings + ${W} learnings (iter ${Q})
`),0}catch(z){return process.stderr.write(`reflect: ${z.message}
`),1}}async function $Z($){let Q=E1($[0]);if(Q===null)return process.stderr.write(`override: missing or invalid <iter>
`),2;let Z=j();try{let z=await Promise.resolve().then(() => (c6(),u6)),X=z.loadCounterEvidence(Z,Q);if(X===null||X.evidence.length===0)return process.stdout.write(`override: no counter-evidence for iter ${Q} (skip)
`),0;let K=(await Promise.resolve().then(() => (c$(),F1))).loadPreviousFindings(Z,Q),W=K.findings.filter((M)=>M.severity==="Critical"||M.severity==="High");if(W.length===0)return process.stdout.write(`override: no blocking findings for iter ${Q} (skip)
`),0;let J=new Set(["duplicate-code-path","file-exists","test-passes","grep-miss","out-of-scope"]),U=async(M)=>{let L=J.has(M.evidence.proofType);return{judge:M.judge,verdict:L?"APPROVE_OVERRIDE":"REJECT_OVERRIDE",reasoning:L?`[stub] proofType=${M.evidence.proofType} trusted`:`[stub] proofType=${M.evidence.proofType} requires manual review`}},H=await z.runOverrideCouncil(W,X,U);await z.recordOverrideOutcome(Z,Q,H,W);let Y=P$(Z,"quality","reviews");if(n7(Y))try{let M=s7(Y).filter((x)=>x.startsWith("review-")).sort(),L=M[M.length-1];if(L&&r7(P$(Y,L)).isDirectory())A$(P$(Y,L,`override-${Q}.json`),{review_id:K.reviewId,iteration:Q,approved_finding_ids:Array.from(H.approvedFindingIds),rejected_finding_ids:Array.from(H.rejectedFindingIds),votes:H.votes})}catch{}let B=H.approvedFindingIds.size,G=H.rejectedFindingIds.size;if(G===0&&B>0)process.stdout.write(`override: LIFTED -- ${B} approved, ${G} rejected
`);else process.stdout.write(`override: BLOCKED -- ${B} approved, ${G} rejected
`);return 0}catch(z){return process.stderr.write(`override: ${z.message}
`),1}}async function QZ($){let Q=$[0],Z=Number.parseInt($[1]??"0",10),z=E1($[2]);if(!Q||!Number.isFinite(Z)||z===null)return process.stderr.write(`handoff: usage: handoff <gate> <consecutive-failures> <iter>
`),2;let X=j();try{let K=(await Promise.resolve().then(() => (o6(),d6))).writeEscalationHandoff(X,{gateName:Q,iteration:z,consecutiveFailures:Z,detail:`${Q} hit PAUSE_LIMIT (${Z} consecutive failures)`});return process.stdout.write(`handoff: wrote ${K.path} (${K.bytes}B)
`),0}catch(q){return process.stderr.write(`handoff: ${q.message}
`),1}}function E1($){if($===void 0)return null;let Q=Number.parseInt($,10);return Number.isFinite(Q)&&Q>=0?Q:null}var x1=`loki internal phase1-hooks <subcommand>

Subcommands:
  reflect <iter>                    Persist structured findings + auto-learnings.
  override <iter>                   Run override council if counter-evidence present.
  handoff <gate> <count> <iter>     Write structured handoff doc before PAUSE.

This command is invoked by autonomy/run.sh between iterations. Users
should not run it directly -- run \`loki start\` instead.
`,ZZ;var a6=P(()=>{C();v$();ZZ=x1});s$();function C1(){return process.stdout.write(`Loki Mode v${F$()}
`),0}d();c();C();import{readFileSync as UQ,existsSync as HQ}from"fs";import{resolve as BQ}from"path";var GQ=["claude","codex","cline","aider"];function h1(){let $=BQ(j(),"state","provider");if(!HQ($))return"";try{return UQ($,"utf-8").trim()}catch{return""}}function YQ($,Q){return $||Q||process.env.LOKI_PROVIDER||"claude"}function MQ($){let Q=h1(),Z=YQ($,Q);switch(process.stdout.write(`${R}Current Provider${V}
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
`),0}async function TQ(){let Q=h1()||process.env.LOKI_PROVIDER||"claude";process.stdout.write(`${R}Available Providers${V}
`),process.stdout.write(`
`);let Z=await Promise.all(GQ.map(async(q)=>[q,await f(q)!==null])),z=new Map;for(let[q,K]of Z)z.set(q,K?`${S}installed${V}`:`${T}not installed${V}`);let X=[["claude","claude  - Claude Code (Anthropic)    "],["codex","codex   - Codex CLI (OpenAI)         "],["cline","cline   - Cline (multi-provider)     "],["aider","aider   - Aider (terminal pair prog) "]];for(let[q,K]of X){let W=Q===q?` ${I}(current)${V}`:"";process.stdout.write(`  ${K} ${z.get(q)}${W}
`)}return process.stdout.write(`
`),process.stdout.write(`Set provider: ${I}loki provider set <name>${V}
`),0}function OQ(){return process.stdout.write(`${R}Loki Mode Provider Management${V}
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
`),0}async function y1($){let Q=$[0]??"show",Z=$.slice(1);switch(Q){case"show":case"current":return MQ(Z[0]);case"list":return TQ();case"set":case"info":case"models":return AQ(["provider",Q,...Z]);default:return OQ()}}async function AQ($){let{run:Q}=await Promise.resolve().then(() => (d(),b1)),{resolve:Z}=await import("path"),{REPO_ROOT:z}=await Promise.resolve().then(() => (C(),D1)),X=Z(z,"autonomy","loki"),q=await Q([X,...$],{env:{LOKI_LEGACY_BASH:"1"},timeoutMs:3600000});return process.stdout.write(q.stdout),process.stderr.write(q.stderr),q.exitCode}c();C();V$();import{existsSync as v1,readFileSync as _Q}from"fs";import{resolve as J$}from"path";import{mkdir as IQ}from"fs/promises";var M$=J$(a$(),"learnings");function t$($){if(!v1($))return 0;try{let Q=_Q($,"utf-8"),Z=0;for(let z of Q.split(`
`))if(z.includes('"description"'))Z++;return Z}catch{return 0}}async function LQ(){await IQ(M$,{recursive:!0});let $=t$(J$(M$,"patterns.jsonl")),Q=t$(J$(M$,"mistakes.jsonl")),Z=t$(J$(M$,"successes.jsonl"));return process.stdout.write(`${R}Cross-Project Learnings${V}
`),process.stdout.write(`
`),process.stdout.write(`  Patterns:  ${S}${$}${V}
`),process.stdout.write(`  Mistakes:  ${_}${Q}${V}
`),process.stdout.write(`  Successes: ${I}${Z}${V}
`),process.stdout.write(`
`),process.stdout.write(`Location: ${M$}
`),process.stdout.write(`
`),process.stdout.write(`Use 'loki memory show <type>' to view entries
`),0}async function PQ($){if($){let z=`
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
`),0;return process.stdout.write(Z.stdout),0}async function m1($){switch($[0]??"list"){case"list":case"ls":return LQ();case"index":return PQ($[1]==="rebuild");default:{let Z=J$(g,"autonomy","loki"),z=3600000,X=Bun.spawn({cmd:[Z,"memory",...$],stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,LOKI_LEGACY_BASH:"1"}}),q=setTimeout(()=>{try{X.kill("SIGKILL")}catch{}},3600000);try{return await X.exited}finally{clearTimeout(q)}}}}C();V$();d();import{resolve as jQ,join as FQ}from"path";import{existsSync as i$,readFileSync as kQ}from"fs";import{homedir as RQ}from"os";import{spawnSync as c1}from"child_process";var p1=3000;function xQ(){let $=(process.env.LOKI_TELEMETRY??"").toLowerCase();if($==="off")return!1;if(process.env.LOKI_TELEMETRY_DISABLED==="true")return!1;if(process.env.DO_NOT_TRACK==="1")return!1;let Q=!1,Z=!1;try{let z=FQ(RQ(),".loki","config");if(i$(z)){let X=kQ(z,"utf8");for(let q of X.split(`
`)){let K=q.replace(/\r$/,"");if(K==="TELEMETRY_DISABLED=true")Q=!0;if(K==="TELEMETRY_ENABLED=true")Z=!0}}}catch{}if(Q)return!1;if($==="on"||Z)return!0;return!1}var k$=!1;function EQ(){return jQ(g,"autonomy","lib","crash_capture.py")}function NQ($,Q){let Z=[$,"--error-class",Q.errorClass,"--message",Q.message];if(Q.stack!==void 0)Z.push("--stack",Q.stack);if(Q.rarvPhase!==void 0)Z.push("--rarv-phase",Q.rarvPhase);if(Q.exitCode!==void 0)Z.push("--exit-code",String(Q.exitCode));if(Q.frictionKind!==void 0)Z.push("--friction-kind",Q.frictionKind);return Z.push("--target-dir",Q.targetDir??process.cwd()),Z}function SQ(){if(i$("/opt/homebrew/bin/python3.12"))return"/opt/homebrew/bin/python3.12";for(let Q of["python3.12","python3"])try{let Z=c1("sh",["-c",`command -v ${Q}`],{timeout:p1,encoding:"utf8"});if(Z.status===0){let z=(Z.stdout||"").trim();if(z)return z}}catch{}return null}function g1($){try{if(!xQ())return;let Q=EQ();if(!i$(Q))return;let Z=SQ();if(!Z)return;let z=NQ(Q,$);c1(Z,z,{timeout:p1,stdio:"ignore"})}catch{}}function f1($,Q){if($ instanceof Error){let z={errorClass:$.name&&$.name.length>0?$.name:Q,message:$.message};if($.stack)z.stack=$.stack;return z}return{errorClass:Q,message:String($)}}var u1=!1;function l1(){if(u1)return;u1=!0,process.on("uncaughtException",($)=>{if(!k$){k$=!0;let Q=f1($,"UncaughtException");g1({errorClass:Q.errorClass,message:Q.message,...Q.stack!==void 0?{stack:Q.stack}:{},exitCode:1})}try{process.stderr.write(`${$&&$.stack||String($)}
`)}catch{}process.exit(1)}),process.on("unhandledRejection",($)=>{if(!k$){k$=!0;let Q=f1($,"UnhandledRejection");g1({errorClass:Q.errorClass,message:Q.message,...Q.stack!==void 0?{stack:Q.stack}:{},exitCode:1})}try{let Q=$ instanceof Error?$.stack||$.message:String($);process.stderr.write(`Unhandled promise rejection: ${Q}
`)}catch{}process.exit(1)})}var s6=`Loki Mode (TypeScript port, Phase 2 of bash->Bun migration)

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
`;function zZ(){let $=process.env.LOKI_LEGACY_BASH;if($===void 0)return;let Q=$.trim().toLowerCase();if(Q!=="1"&&Q!=="true"&&Q!=="yes"&&Q!=="on")return;if(process.env.LOKI_SUPPRESS_BUN_DIRECT_WARN==="1")return;process.stderr.write(`warning: LOKI_LEGACY_BASH is set, but you are running the Bun runtime directly (src/cli.ts). The env var only takes effect via the bin/loki shim, which dispatches between Bun and bash. Behavior is unchanged; this message is informational.
`)}async function XZ($){zZ();let Q=$[0],Z=$.slice(1);switch(Q){case void 0:case"help":case"--help":case"-h":return process.stdout.write(s6),0;case"version":case"--version":case"-v":return C1();case"provider":return y1(Z);case"memory":return m1(Z);case"status":{let{runStatus:z}=await Promise.resolve().then(() => ($0(),e1));return z(Z)}case"stats":{let{runStats:z}=await Promise.resolve().then(() => (V0(),q0));return z(Z)}case"doctor":{let{runDoctor:z}=await Promise.resolve().then(() => (O0(),T0));return z(Z)}case"kpis":{let{runKpis:z}=await Promise.resolve().then(() => (W1(),J1));return z(Z,{aliasOf:"kpis"})}case"report":{if(Z.find((q)=>!q.startsWith("-"))==="kpis"){let{runKpis:q}=await Promise.resolve().then(() => (W1(),J1)),K=!1,W=Z.filter((J)=>{if(!K&&J==="kpis")return K=!0,!1;return!0});return q(W)}let{delegateToBash:X}=await Promise.resolve().then(() => (N0(),E0));return X(["report",...Z])}case"trust":{let{runTrust:z}=await Promise.resolve().then(() => (g0(),m0));return z(Z)}case"rollback":{let{runRollback:z}=await Promise.resolve().then(() => (H6(),U6));return z(Z)}case"proof":{let{runProof:z}=await Promise.resolve().then(() => (T6(),M6));return z(Z)}case"crash":{let{runCrash:z}=await Promise.resolve().then(() => (P6(),L6));return z(Z)}case"wiki":{let{runWiki:z}=await Promise.resolve().then(() => (x6(),R6));return z(Z)}case"internal":{let z=Z[0];if(!z||z==="--help"||z==="-h"||z==="help"){let q=["loki internal -- runtime hooks driven by autonomy/run.sh","","Subcommands:","  phase1-hooks    Persist structured findings, run override council,","                  append learnings, and write the escalation handoff","                  doc once per iteration. Driven by run.sh; not","                  intended for direct invocation.","","Phase 1 (RARV-C closure) env vars:","  LOKI_INJECT_FINDINGS=1   Persist structured reviewer findings to","                           .loki/state/findings-<iter>.json so the","                           next iteration can address them.","  LOKI_OVERRIDE_COUNCIL=1  Allow a 3-LLM override panel to lift a","                           BLOCK when counter-evidence is presented.","                           See LOKI_OVERRIDE_JUDGES (csv),","                           LOKI_OVERRIDE_PANEL_SIZE,","                           LOKI_OVERRIDE_REAL_JUDGE.","  LOKI_AUTO_LEARNINGS=1    Append failure rootcauses to","                           .loki/state/relevant-learnings.json via","                           the episodic memory bridge.","  LOKI_HANDOFF_MD=1        Write a structured human handoff doc to","                           .loki/escalations/<ts>.md before PAUSE.","","All four are default-on as of v7.5.3. Set to 0 to disable.","Reference: CHANGELOG.md (search 'Phase 1') and skills/healing.md.","","These commands are wired into the autonomous loop and may change","without notice. Do not script against them.",""].join(`
`);return process.stdout.write(`${q}
`),0}if(z==="phase1-hooks"){let{runInternalPhase1Hooks:q}=await Promise.resolve().then(() => (a6(),n6));return q(Z.slice(1))}return process.stderr.write(`Unknown internal subcommand: ${z}
`),process.stderr.write(`Run 'loki internal --help' for the supported list.
`),2}default:return process.stderr.write(`Unknown command: ${Q}
`),process.stderr.write(s6),2}}l1();process.on("SIGINT",()=>process.exit(130));process.on("SIGTERM",()=>process.exit(143));var KZ=await XZ(Bun.argv.slice(2));process.exit(KZ);

//# debugId=57FA9507F46D167A64756E2164756E21
