import { Board } from "./Board";

// Replaces the old Work page registered by CPE-02 at #/work.
export const page = { id: "work", path: "/work", title: "Work", component: () => <Board /> };
export { Board };
