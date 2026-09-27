import{c as l,j as s}from"./index-B6qBTOXX.js";/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const x=[["path",{d:"m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7",key:"132q7q"}],["rect",{x:"2",y:"4",width:"20",height:"16",rx:"2",key:"izxlao"}]],m=l("mail",x);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const d=[["path",{d:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",key:"1yyitq"}],["circle",{cx:"9",cy:"7",r:"4",key:"nufk8"}],["line",{x1:"19",x2:"19",y1:"8",y2:"14",key:"1bvyxn"}],["line",{x1:"22",x2:"16",y1:"11",y2:"11",key:"1shjgl"}]],p=l("user-plus",d),b={sm:{container:"w-6 h-6",text:"text-[10px]",dot:"w-2 h-2 -bottom-0.5 -right-0.5"},md:{container:"w-8 h-8",text:"text-xs",dot:"w-2.5 h-2.5 -bottom-0.5 -right-0.5"},lg:{container:"w-11 h-11",text:"text-sm",dot:"w-3 h-3 -bottom-0.5 -right-0.5"}},g={online:"bg-[#1FC5A8]",offline:"bg-[#939084]",away:"bg-[#E5A940]"};function u(e){let t=0;for(let n=0;n<e.length;n++)t=e.charCodeAt(n)+((t<<5)-t);return Math.abs(t)}const i=["bg-[#553DE9]","bg-[#D63384]","bg-[#1FC5A8]","bg-[#E5A940]","bg-[#3B82F6]","bg-[#8B5CF6]","bg-[#EC4899]","bg-[#06B6D4]"];function f(e){var n;const t=e.trim().split(/\s+/);return t.length>=2?(t[0][0]+t[t.length-1][0]).toUpperCase():(((n=t[0])==null?void 0:n[0])||"?").toUpperCase()}function A({name:e,image:t,size:n="md",status:r,className:a=""}){const o=b[n],c=i[u(e)%i.length],h=f(e);return s.jsxs("span",{className:`relative inline-flex flex-shrink-0 ${a}`,children:[t?s.jsx("img",{src:t,alt:e,className:`${o.container} rounded-full object-cover`}):s.jsx("span",{className:`${o.container} ${c} rounded-full inline-flex items-center justify-center text-white font-semibold ${o.text}`,title:e,children:h}),r&&s.jsx("span",{className:`absolute ${o.dot} ${g[r]} rounded-full border-2 border-white dark:border-[#1A1A1E]`,title:r})]})}export{A,m as M,p as U};
