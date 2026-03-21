import{c,r as x,j as t}from"./index-fDGiE35F.js";/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const m=[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"M12 5v14",key:"s699le"}]],g=c("plus",m);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const u=[["path",{d:"M10 11v6",key:"nco0om"}],["path",{d:"M14 11v6",key:"outv1u"}],["path",{d:"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",key:"miytrc"}],["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",key:"e791ji"}]],k=c("trash-2",u),y={primary:"bg-[#553DE9] text-white hover:bg-[#4432c4] shadow-button rounded-btn",secondary:"border border-[#553DE9] text-[#553DE9] hover:bg-[#E8E4FD] bg-transparent rounded-btn",ghost:"text-[#36342E] hover:bg-[#F8F4F0] rounded-btn",danger:"bg-[#C45B5B]/10 text-[#C45B5B] border border-[#C45B5B]/20 hover:bg-[#C45B5B]/20 rounded-btn"},b={sm:"px-3 py-1.5 text-xs",md:"px-4 py-2 text-sm",lg:"px-6 py-3 text-base"},j={sm:14,md:16,lg:18};function v({size:e}){return t.jsxs("svg",{className:"animate-spin",width:e,height:e,viewBox:"0 0 24 24",fill:"none",children:[t.jsx("circle",{className:"opacity-25",cx:"12",cy:"12",r:"10",stroke:"currentColor",strokeWidth:"4"}),t.jsx("path",{className:"opacity-75",fill:"currentColor",d:"M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"})]})}const B=x.forwardRef(({variant:e="primary",size:r="md",icon:a,iconRight:n,loading:s=!1,disabled:i,className:d="",children:p,...h},l)=>{const o=j[r];return t.jsxs("button",{ref:l,disabled:i||s,className:["inline-flex items-center justify-center gap-2 font-medium transition-colors",y[e],b[r],(i||s)&&"opacity-60 cursor-not-allowed",d].filter(Boolean).join(" "),...h,children:[s?t.jsx(v,{size:o}):a?t.jsx(a,{size:o}):null,p,n&&!s&&t.jsx(n,{size:o})]})});B.displayName="Button";export{B,g as P,k as T};
