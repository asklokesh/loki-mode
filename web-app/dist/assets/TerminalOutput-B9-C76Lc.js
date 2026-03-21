import{c as i,r as m,j as e}from"./index-D2fOHWZo.js";/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const j=[["path",{d:"M12 5v14",key:"s699le"}],["path",{d:"m19 12-7 7-7-7",key:"1idqje"}]],v=i("arrow-down",j);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const b=[["path",{d:"m6 9 6 6 6-6",key:"qrunsl"}]],N=i("chevron-down",b);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const S=[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]],_=i("chevron-right",S);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const E=[["rect",{width:"18",height:"11",x:"3",y:"11",rx:"2",ry:"2",key:"1w4ew1"}],["path",{d:"M7 11V7a5 5 0 0 1 10 0v4",key:"fwvmzm"}]],L=i("lock",E);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const C=[["rect",{x:"14",y:"3",width:"5",height:"18",rx:"1",key:"kaeet6"}],["rect",{x:"5",y:"3",width:"5",height:"18",rx:"1",key:"1wsw3u"}]],P=i("pause",C);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const M=[["path",{d:"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z",key:"10ikf1"}]],V=i("play",M);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const T=[["path",{d:"M16.247 7.761a6 6 0 0 1 0 8.478",key:"1fwjs5"}],["path",{d:"M19.075 4.933a10 10 0 0 1 0 14.134",key:"ehdyv1"}],["path",{d:"M4.925 19.067a10 10 0 0 1 0-14.134",key:"1q22gi"}],["path",{d:"M7.753 16.239a6 6 0 0 1 0-8.478",key:"r2q7qm"}],["circle",{cx:"12",cy:"12",r:"2",key:"1c9p78"}]],$=i("radio",T);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const q=[["path",{d:"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8",key:"1p45f6"}],["path",{d:"M21 3v5h-5",key:"1q7to0"}]],z=i("rotate-cw",q);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const R=[["path",{d:"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",key:"wmoenq"}],["path",{d:"M12 9v4",key:"juzpu7"}],["path",{d:"M12 17h.01",key:"p32p05"}]],A=i("triangle-alert",R);function D({error:s}){const[r,d]=m.useState(!1);return s?e.jsxs("div",{className:"mt-3 text-left w-full max-w-sm mx-auto",children:[e.jsxs("button",{onClick:()=>d(!r),className:"flex items-center gap-1 text-xs text-muted hover:text-ink transition-colors",children:[r?e.jsx(N,{size:12}):e.jsx(_,{size:12}),"Show Details"]}),r&&e.jsx("pre",{className:"mt-2 p-3 text-[11px] font-mono text-danger/80 bg-danger/5 border border-danger/10 rounded-btn overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap",children:s.stack||s.message})]}):null}class F extends m.Component{constructor(r){super(r),this.state={hasError:!1,error:null}}static getDerivedStateFromError(r){return{hasError:!0,error:r}}componentDidCatch(r,d){console.error(`[${this.props.name||"Component"}] render error:`,r,d)}render(){var r;return this.state.hasError?this.props.fallback?this.props.fallback:e.jsxs("div",{className:"flex flex-col items-center justify-center p-6 h-full min-h-[120px]",children:[e.jsx("div",{className:"w-10 h-10 rounded-full bg-danger/10 flex items-center justify-center mb-3",children:e.jsx(A,{size:20,className:"text-danger"})}),e.jsx("p",{className:"text-sm font-medium text-ink",children:"Something went wrong"}),e.jsx("p",{className:"text-xs text-muted mt-1 max-w-xs text-center",children:((r=this.state.error)==null?void 0:r.message)||"An unexpected error occurred in this section."}),e.jsxs("button",{onClick:()=>this.setState({hasError:!1,error:null}),className:"mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-btn border border-primary/20 text-primary hover:bg-primary/5 transition-colors",children:[e.jsx(z,{size:12}),"Try Again"]}),e.jsx(D,{error:this.state.error})]}):this.props.children}}const H={info:"text-info",error:"text-danger",warning:"text-warning",debug:"text-muted",critical:"text-danger font-bold"};function B(s){if(!s)return"";if(s.includes("T")||s.includes("-"))try{return new Date(s).toLocaleTimeString("en-US",{hour12:!1})}catch{return s}return s}function I({logs:s,loading:r,subscribe:d}){const l=m.useRef(null),[c,f]=m.useState(!1),[g,k]=m.useState([]);m.useEffect(()=>d?d("log",o=>{const a=o;a!=null&&a.line&&k(h=>{const n=[...h,{message:a.line,timestamp:a.timestamp||""}];return n.length>500?n.slice(-500):n})}):void 0,[d]);const x=(()=>{const t=g.map(n=>{let u="info";const p=n.message.toLowerCase();return p.includes("error")||p.includes("fail")?u="error":p.includes("warn")?u="warning":p.includes("debug")&&(u="debug"),{timestamp:n.timestamp,level:u,message:n.message,source:"ws"}}),o=s||[];if(t.length===0)return o;if(o.length===0)return t;const a=new Set(t.map(n=>n.message));return[...o.filter(n=>!a.has(n.message)),...t]})();m.useEffect(()=>{!c&&l.current&&(l.current.scrollTop=l.current.scrollHeight)},[x,c]);const y=()=>{if(!l.current)return;const{scrollTop:t,scrollHeight:o,clientHeight:a}=l.current,h=o-t-a<50;f(!h)},w=()=>{var t;f(!1),(t=l.current)==null||t.scrollTo({top:l.current.scrollHeight,behavior:"smooth"})};return e.jsxs("div",{className:"card p-0 overflow-hidden flex flex-col h-full",children:[e.jsxs("div",{className:"flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0",children:[e.jsx("h3",{className:"text-sm font-semibold text-ink uppercase tracking-wider",children:"Terminal"}),e.jsxs("div",{className:"flex items-center gap-3",children:[e.jsxs("span",{className:"font-mono text-xs text-muted",children:[x.length," lines"]}),e.jsxs("button",{onClick:c?w:()=>f(!0),className:`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${c?"border-warning/40 text-warning bg-warning/5 hover:bg-warning/10":"border-primary/20 text-primary hover:bg-primary/5"}`,title:c?"Scroll locked -- click to resume auto-scroll":"Auto-scrolling -- click to lock",children:[c?e.jsx(L,{size:14}):e.jsx($,{size:14}),c?"Locked":"Live"]}),c&&e.jsxs("button",{onClick:w,className:"flex items-center gap-1.5 text-xs text-primary hover:text-primary transition-colors font-medium",children:[e.jsx(v,{size:14}),"Jump to bottom"]})]})]}),e.jsxs("div",{ref:l,onScroll:y,className:"flex-1 overflow-y-auto terminal-scroll bg-ink/[0.03] p-4 font-mono text-xs leading-relaxed",children:[r&&!s&&g.length===0&&e.jsx("div",{className:"text-muted animate-pulse",children:"Connecting to log stream..."}),x.length===0&&!r&&e.jsxs("div",{className:"text-muted/60",children:[e.jsx("p",{children:"No log output yet."}),e.jsx("p",{className:"mt-1",children:"Start a build to see terminal output here."})]}),x.map((t,o)=>e.jsxs("div",{className:"flex gap-2 hover:bg-hover rounded px-1 -mx-1",children:[e.jsx("span",{className:"text-muted flex-shrink-0 select-none w-16 text-right",children:B(t.timestamp)}),e.jsx("span",{className:`flex-shrink-0 w-12 text-right uppercase text-xs font-semibold ${H[t.level]||"text-muted"}`,children:t.level}),e.jsx("span",{className:`flex-1 break-all ${t.level==="error"||t.level==="critical"?"text-danger":"text-ink"}`,children:t.message})]},o)),x.length>0&&e.jsx("div",{className:"terminal-cursor mt-1"})]})]})}export{N as C,F as E,V as P,z as R,I as T,P as a,_ as b,A as c};
