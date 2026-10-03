import { Plans } from "./Plans";

export const page = { id: "plans", path: "/plans/:source/:run", title: "Plans", component: Plans };
/** Run picker at "/plans" (no params); the CoS registers it beside `page`. */
export const pickerPage = { id: "plans-picker", path: "/plans", title: "Plans", component: Plans };
