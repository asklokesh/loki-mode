import{c as o,r as a,j as e,T as n,i,b as c}from"./index-CLvjO22Z.js";/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const l=[["rect",{x:"14",y:"3",width:"5",height:"18",rx:"1",key:"kaeet6"}],["rect",{x:"5",y:"3",width:"5",height:"18",rx:"1",key:"1wsw3u"}]],p=o("pause",l);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const x=[["path",{d:"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8",key:"1p45f6"}],["path",{d:"M21 3v5h-5",key:"1q7to0"}]],h=o("rotate-cw",x);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const d=[["rect",{width:"18",height:"18",x:"3",y:"3",rx:"2",key:"afitv7"}]],f=o("square",d);function m({error:r}){const[t,s]=a.useState(!1);return r?e.jsxs("div",{className:"mt-3 text-left w-full max-w-sm mx-auto",children:[e.jsxs("button",{onClick:()=>s(!t),className:"flex items-center gap-1 text-xs text-muted hover:text-ink transition-colors",children:[t?e.jsx(i,{size:12}):e.jsx(c,{size:12}),"Show Details"]}),t&&e.jsx("pre",{className:"mt-2 p-3 text-[11px] font-mono text-danger/80 bg-danger/5 border border-danger/10 rounded-btn overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap",children:r.stack||r.message})]}):null}class g extends a.Component{constructor(t){super(t),this.state={hasError:!1,error:null}}static getDerivedStateFromError(t){return{hasError:!0,error:t}}componentDidCatch(t,s){console.error(`[${this.props.name||"Component"}] render error:`,t,s)}render(){var t;return this.state.hasError?this.props.fallback?this.props.fallback:e.jsxs("div",{className:"flex flex-col items-center justify-center p-6 h-full min-h-[120px]",children:[e.jsx("div",{className:"w-10 h-10 rounded-full bg-danger/10 flex items-center justify-center mb-3",children:e.jsx(n,{size:20,className:"text-danger"})}),e.jsx("p",{className:"text-sm font-medium text-ink",children:"Something went wrong"}),e.jsx("p",{className:"text-xs text-muted mt-1 max-w-xs text-center",children:((t=this.state.error)==null?void 0:t.message)||"An unexpected error occurred in this section."}),e.jsxs("button",{onClick:()=>this.setState({hasError:!1,error:null}),className:"mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-btn border border-primary/20 text-primary hover:bg-primary/5 transition-colors",children:[e.jsx(h,{size:12}),"Try Again"]}),e.jsx(m,{error:this.state.error})]}):this.props.children}}export{g as E,p as P,h as R,f as S};
